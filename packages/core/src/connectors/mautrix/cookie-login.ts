import path from 'node:path';
import fs from 'node:fs';
import type { BrowserContext, Page, Request } from 'playwright';
import { bus } from '../../bus.js';
import { sessionDir } from '../../config.js';
import { ensureChromium } from '../../browser-install.js';
import { killProcessesMatching } from '../../platform.js';

/**
 * Köprünün "cookies" giriş adımı: istenen çerez / yerel depo / istek başlığı / istek gövdesi alanları Mivelo'nun kendi
 * Chromium profilinden (sessions/<hesap>/profile — eski tarayıcı bağlayıcısının profiliyle aynı) toplanır. Kullanıcı şifresi
 * Mivelo'dan geçmez; giriş sağlayıcının kendi sayfasında yapılır.
 *   1) görünmez deneme: profilde oturum varsa (eski hesaplar, yeniden bağlanma) pencere açmadan alınır
 *   2) görünür giriş penceresi (--app): kullanıcı giriş yapınca alanlar dolar, pencere kapanır; girişsiz kapatılırsa iptal
 */
export interface CookieSource {
  type: 'cookie' | 'local_storage' | 'request_header' | 'request_body' | 'special';
  name: string;
  request_url_regex?: string;
  cookie_domain?: string;
}
export interface CookieField {
  id: string;
  required: boolean;
  sources: CookieSource[];
  pattern?: string;
}
export interface CookieParams {
  url: string;
  user_agent?: string;
  fields: CookieField[];
  extract_js?: string;
  wait_for_url_pattern?: string;
}

/** Görünmez denemede oturumlu sayfa (giriş sayfası oturum varsa yönlendirmeyebilir) */
const SILENT_URL: Record<string, string> = {
  instagram: 'https://www.instagram.com/direct/inbox/',
  messenger: 'https://www.facebook.com/messages/',
  x: 'https://x.com/home',
  linkedin: 'https://www.linkedin.com/feed/',
  slack: 'https://app.slack.com/client',
};

export interface CollectOptions {
  accountId: string;
  net: string;
  visible: boolean;
  /** görünür pencere açıldı (hesap 'pairing') */
  onWindow?: () => void;
  cancelled: () => boolean;
  timeoutMs?: number;
}

export type CollectResult = { ok: true; values: Record<string, string> } | { ok: false; reason: 'closed' | 'timeout' | 'cancelled' | 'error'; message?: string };

function reOf(src: string | undefined): RegExp | undefined {
  if (!src) return undefined;
  try {
    return new RegExp(src);
  } catch {
    return undefined;
  }
}

function bodyField(body: string | null, name: string): string | undefined {
  if (!body) return undefined;
  const multipart = new RegExp(`name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\r?\\n\\r?\\n([^\\r\\n]+)`).exec(body);
  if (multipart) return multipart[1];
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    if (typeof j[name] === 'string') return j[name] as string;
  } catch {
    /* form */
  }
  try {
    return new URLSearchParams(body).get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function collectCookies(params: CookieParams, opts: CollectOptions): Promise<CollectResult> {
  const ready = await ensureChromium();
  if (!ready) return { ok: false, reason: 'error', message: 'Tarayıcı bileşeni indirilemedi' };
  let chromium: (typeof import('playwright'))['chromium'];
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return { ok: false, reason: 'error', message: 'Playwright paketi yok' };
  }
  const profile = path.join(sessionDir(opts.accountId), 'profile');
  fs.mkdirSync(profile, { recursive: true });
  const startUrl = opts.visible ? params.url : (SILENT_URL[opts.net] ?? params.url);
  const launch = () =>
    chromium.launchPersistentContext(profile, {
      headless: !opts.visible,
      channel: process.env.KAVSAK_CHROMIUM ? undefined : 'chromium',
      executablePath: process.env.KAVSAK_CHROMIUM || undefined,
      viewport: opts.visible ? null : { width: 1180, height: 820 },
      userAgent: params.user_agent || undefined,
      locale: 'tr-TR',
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-extensions',
        '--disable-sync',
        '--mute-audio',
        ...(opts.visible ? [`--app=${startUrl}`, '--window-size=760,860', '--window-position=140,60'] : []),
      ],
    });
  let ctx: BrowserContext;
  try {
    ctx = await launch();
  } catch (e) {
    const msg = (e as Error).message;
    if (!/ProcessSingleton|SingletonLock|already in use/i.test(msg)) return { ok: false, reason: 'error', message: msg.split('\n')[0] };
    await killProcessesMatching(`--user-data-dir=${profile}`);
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']) fs.rmSync(path.join(profile, f), { force: true });
    try {
      ctx = await launch();
    } catch (e2) {
      return { ok: false, reason: 'error', message: (e2 as Error).message.split('\n')[0] };
    }
  }
  const captured = new Map<string, string>();
  const special = new Map<string, string>();
  const wanted = params.fields.flatMap((f) => f.sources.filter((s) => s.type === 'request_header' || s.type === 'request_body').map((s) => ({ f, s, re: reOf(s.request_url_regex) })));
  const onRequest = (req: Request) => {
    const url = req.url();
    for (const { f, s, re } of wanted) {
      if (captured.has(f.id) || (re && !re.test(url))) continue;
      if (s.type === 'request_body') {
        const v = bodyField(req.postData(), s.name);
        if (v) captured.set(f.id, v);
      } else {
        void req
          .allHeaders()
          .then((h) => {
            const v = h[s.name.toLowerCase()];
            if (v && !captured.has(f.id)) captured.set(f.id, v);
          })
          .catch(() => undefined);
      }
    }
  };
  ctx.on('request', onRequest);
  const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
  // ayıklama betiği (Slack: yerel depodaki xoxc belirteci; "Tarayıcıda kullan" bağlantısına kendisi tıklar) her yüklemede yeniden
  const runExtract = (p: Page) => {
    if (!params.extract_js) return;
    void p
      .evaluate(`(${'async () => { try { return await (' + params.extract_js + ') } catch (e) { return null } }'})()`)
      .then((r) => {
        if (r && typeof r === 'object') for (const [k, v] of Object.entries(r as Record<string, unknown>)) if (typeof v === 'string' && v) special.set(k, v);
      })
      .catch(() => undefined);
  };
  page.on('load', () => runExtract(page));
  ctx.on('page', (p) => p.on('load', () => runExtract(p)));
  if (!opts.visible) await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  else opts.onWindow?.();
  runExtract(page);

  const waitRe = reOf(params.wait_for_url_pattern);
  const collect = async (): Promise<Record<string, string> | undefined> => {
    const jar = await ctx.cookies().catch(() => []);
    const pages = ctx.pages().filter((p) => !p.isClosed());
    const out: Record<string, string> = {};
    for (const f of params.fields) {
      let val: string | undefined;
      for (const s of f.sources) {
        if (val) break;
        if (s.type === 'cookie') {
          const dom = (s.cookie_domain ?? '').replace(/^\./, '');
          val = jar.find((c) => c.name === s.name && (!dom || c.domain.replace(/^\./, '').endsWith(dom)))?.value;
        } else if (s.type === 'local_storage') {
          for (const p of pages) {
            val = (await p.evaluate((k) => localStorage.getItem(k), s.name).catch(() => null)) ?? undefined;
            if (val) break;
          }
        } else if (s.type === 'special') {
          val = special.get(f.id) ?? special.get(s.name);
        } else {
          val = captured.get(f.id);
        }
      }
      if (val) {
        if (f.pattern && !reOf(f.pattern)?.test(val)) val = undefined;
      }
      if (val) out[f.id] = val;
      else if (f.required) return undefined;
    }
    // görünür girişte giriş sonrası sayfaya varılmasını bekle (çerezler giriş ortasında da oluşabiliyor)
    if (opts.visible && waitRe && !pages.some((p) => waitRe.test(p.url()))) return undefined;
    return out;
  };

  const deadline = Date.now() + (opts.timeoutMs ?? (opts.visible ? 10 * 60_000 : 30_000));
  let empty = 0;
  let nudged = false;
  try {
    while (Date.now() < deadline) {
      if (opts.cancelled()) return { ok: false, reason: 'cancelled' };
      const got = await collect();
      if (got) return { ok: true, values: got };
      const open = ctx.pages().filter((p) => !p.isClosed()).length;
      empty = open ? 0 : empty + 1;
      if (empty >= 2) return { ok: false, reason: 'closed' };
      // görünmez denemede istek başlığı gereken alan (LinkedIn) için sayfayı bir kez yenile: yeni istekler yakalansın
      if (!opts.visible && !nudged && Date.now() > deadline - 15_000 && wanted.length) {
        nudged = true;
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, opts.visible ? 1000 : 700));
    }
    return { ok: false, reason: 'timeout' };
  } catch (e) {
    return { ok: false, reason: 'error', message: (e as Error).message.split('\n')[0] };
  } finally {
    ctx.off('request', onRequest);
    await ctx.close().catch(() => undefined);
    bus.log('info', `${opts.net}: ${opts.visible ? 'giriş penceresi' : 'kayıtlı oturum denetimi'} kapandı`);
  }
}
