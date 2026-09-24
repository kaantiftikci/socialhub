import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import QRCode from 'qrcode';
import { DATA_DIR } from './config.js';
import { WebSocketServer, WebSocket } from 'ws';
import type { Store } from './store.js';
import type { Registry } from './registry.js';
import type { Connector } from './connectors/base.js';
import { resolveOAuth } from './connectors/mail.js';
import { bus } from './bus.js';
import { aiEnabled, draftReply } from './ai.js';
import type { Platform } from './model.js';

/**
 * Yerel API: yalnızca 127.0.0.1'e bağlanır. Arayüz (ve ileride MCP/otomasyonlar) bunu kullanır.
 * REST + tek bir WebSocket olay akışı (/ws).
 */
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, body: unknown) => Promise<unknown> | unknown;

const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, pathPattern: string, handler: Handler): void {
  const keys: string[] = [];
  const re = new RegExp('^' + pathPattern.replace(/:([a-zA-Z]+)/g, (_, k: string) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, pattern: re, keys, handler });
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Yerel API belirteci: tarayıcıdaki rastgele bir sayfa (Origin: null / yabancı origin) API'ye erişemesin. Tauri kabuğu dosyadan okur. */
function loadToken(): string {
  const file = path.join(DATA_DIR, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {
    /* yok */
  }
  const t = randomBytes(24).toString('hex');
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

const LOCAL_ORIGIN = /^(https?:\/\/(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?|tauri:\/\/localhost|asset:\/\/localhost)$/;
/** Vekilden indirilebilecek uzak medya sunucuları (oturum çerezleriyle istek yapıldığı için sınırlı) */
// fbsbx.com: Instagram/Messenger sesli mesaj ve dosyaları; giphy/tenor: DM GIF'leri
const MEDIA_HOSTS = /(^|\.)(twimg\.com|twitter\.com|x\.com|cdninstagram\.com|fbcdn\.net|fbsbx\.com|facebook\.com|messenger\.com|licdn\.com|linkedin\.com|slack-edge\.com|slack-files\.com|files\.slack\.com|whatsapp\.net|telegram\.org|shopier\.com|giphy\.com|tenor\.com|mail\.google\.com|googleusercontent\.com)$/i;

/** ~/.kavsak/settings.json: { lan: boolean } — telefondan (aynı Wi‑Fi) erişim */
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
function readSettings(): { lan?: boolean } {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as { lan?: boolean };
  } catch {
    return {};
  }
}
/** Bu Mac'in yerel ağ IPv4 adresleri (Wi‑Fi/Ethernet) */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}
const isLoopback = (addr: string | undefined) => !addr || addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

export function createServer(store: Store, registry: Registry, port: number): http.Server {
  const token = loadToken();
  let lanEnabled = !!readSettings().lan;
  const givenToken = (req: http.IncomingMessage): string => {
    const u = new URL(req.url ?? '/', 'http://x');
    return (req.headers['x-kavsak-token'] as string | undefined) ?? u.searchParams.get('token') ?? '';
  };
  /**
   * Yerel (loopback) istemci: Origin yoksa ya da yerel origin ise serbest; diğer origin'ler (null dahil) belirteç ister.
   * Uzak istemci (telefon): yalnızca LAN modu açıksa ve belirteç doğruysa.
   */
  const authorized = (req: http.IncomingMessage): boolean => {
    if (!isLoopback(req.socket.remoteAddress)) {
      if (!lanEnabled) return false;
      // arayüz dosyaları (index, assets) belirteçsiz inebilir; veri (/api, /ws) belirteç ister
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      if (req.method === 'GET' && !p.startsWith('/api/') && p !== '/ws') return true;
      return givenToken(req) === token;
    }
    const origin = req.headers.origin;
    if (!origin || LOCAL_ORIGIN.test(origin)) return true;
    return givenToken(req) === token;
  };
  const lanInfo = async () => {
    const urls = lanAddresses().map((ip) => `http://${ip}:${port}/?token=${token}`);
    return { enabled: lanEnabled, urls, qr: urls[0] ? await QRCode.toDataURL(urls[0], { margin: 1, width: 220 }) : undefined };
  };
  // Bekleyen QR kodları: arayüz sonradan açılsa da eşleşme ekranı boş kalmasın
  const pendingQr = new Map<string, string>();
  bus.on((ev) => {
    if (ev.type === 'account.qr') pendingQr.set(ev.accountId, ev.qrDataUrl);
    if (ev.type === 'account.status' && ev.account.status !== 'pairing') pendingQr.delete(ev.account.id);
  });

  // ---------- routes ----------
  route('GET', '/api/health', () => ({ ok: true, ai: aiEnabled(), stats: store.stats() }));

  route('GET', '/api/accounts', () => registry.list().map((a) => ({ ...a, qrDataUrl: pendingQr.get(a.id) })));
  route('POST', '/api/accounts', async (_r, _s, _p, body) => {
    const b = body as { platform?: Platform; token?: string; label?: string };
    if (!b.platform) throw new HttpError(400, 'platform gerekli');
    return registry.add(b.platform, { token: b.token, label: b.label });
  });
  route('DELETE', '/api/accounts/:id', async (_r, _s, p) => {
    await registry.remove(decodeURIComponent(p.id));
    return { ok: true };
  });
  route('POST', '/api/accounts/:id/restart', async (_r, _s, p) => {
    await registry.restart(decodeURIComponent(p.id));
    return { ok: true };
  });
  route('POST', '/api/accounts/:id/input', (_r, _s, p, body) => {
    const c = registry.get(decodeURIComponent(p.id));
    const b = body as { kind: 'phone' | 'code' | 'password'; value: string };
    if (!['phone', 'code', 'password'].includes(b.kind)) throw new HttpError(400, 'Geçersiz giriş türü');
    if (!c?.provideInput) throw new HttpError(400, 'Bu hesap giriş beklemiyor');
    c.provideInput(b.kind, String(b.value ?? '').trim());
    return { ok: true };
  });

  route('GET', '/api/chats', () => store.listChats());
  route('GET', '/api/chats/:id/messages', (req, _s, p) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const before = Number(url.searchParams.get('before'));
    return store.listMessages(decodeURIComponent(p.id), limit, Number.isFinite(before) && before > 0 ? before : undefined);
  });
  route('POST', '/api/chats/:id/read', (_r, _s, p) => {
    const id = decodeURIComponent(p.id);
    const before = store.getChat(id);
    store.markRead(id);
    const chat = store.getChat(id);
    if (chat) {
      bus.emit({ type: 'chat.upsert', chat });
      // platformda da okundu işaretle (yalnızca gerçekten okunmamış vardıysa; arka planda)
      if (before && before.unread > 0) void registry.get(chat.accountId)?.markRead?.(chat.remoteId).catch((e) => bus.log('warn', `${chat.platform}: okundu işaretlenemedi: ${(e as Error).message}`));
    }
    return { ok: true };
  });
  route('POST', '/api/chats/:id/tags', (_r, _s, p, body) => {
    const id = decodeURIComponent(p.id);
    const tags = (body as { tags?: unknown }).tags ?? [];
    if (!Array.isArray(tags)) throw new HttpError(400, 'tags bir dizi olmalı');
    store.setTags(id, tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20));
    const chat = store.getChat(id);
    if (chat) bus.emit({ type: 'chat.upsert', chat });
    return chat;
  });
  route('POST', '/api/chats/:id/send', async (_r, _s, p, body) => {
    const id = decodeURIComponent(p.id);
    const chat = store.getChat(id);
    if (!chat) throw new HttpError(404, 'Sohbet yok');
    const text = String((body as { text?: string }).text ?? '').trim();
    if (!text) throw new HttpError(400, 'Boş mesaj');
    const c = registry.get(chat.accountId);
    if (!c) throw new HttpError(409, 'Hesap bağlı değil');
    return c.sendText(chat.remoteId, text);
  });
  route('POST', '/api/chats/open', async (_r, _s, _p, body) => {
    const b = body as { accountId?: string; participant?: { id: string; name: string; handle?: string; avatarUrl?: string } };
    if (!b.accountId || !b.participant?.id) throw new HttpError(400, 'accountId ve participant gerekli');
    const c = registry.get(b.accountId) as (Connector & { openChatWith?: (p: { id: string; name: string }) => Promise<unknown> }) | undefined;
    if (!c?.openChatWith) throw new HttpError(400, 'Hesap bağlı değil');
    return c.openChatWith(b.participant);
  });
  route('POST', '/api/chats/:id/action', async (_r, _s, p, body) => {
    const chat = store.getChat(decodeURIComponent(p.id));
    if (!chat) throw new HttpError(404, 'Sohbet yok');
    const c = registry.get(chat.accountId);
    if (!c?.action) throw new HttpError(400, 'Bu platformda işlem desteklenmiyor');
    await c.action(chat.remoteId, (body ?? {}) as Record<string, unknown>);
    return store.getChat(chat.id);
  });
  route('POST', '/api/chats/:id/history', async (_r, _s, p, body) => {
    const id = decodeURIComponent(p.id);
    const chat = store.getChat(id);
    if (!chat) throw new HttpError(404, 'Sohbet yok');
    const c = registry.get(chat.accountId);
    const b = body as { limit?: number; before?: number };
    const before = Number(b.before);
    if (c?.loadHistory) await c.loadHistory(chat.remoteId, Math.min(500, Math.max(1, Number(b.limit) || 50)), Number.isFinite(before) && before > 0 ? before : undefined);
    return { ok: true };
  });
  route('POST', '/api/chats/:id/draft', async (_r, _s, p, body) => {
    const id = decodeURIComponent(p.id);
    const chat = store.getChat(id);
    if (!chat) throw new HttpError(404, 'Sohbet yok');
    const tone = (body as { tone?: 'default' | 'short' | 'formal' | 'en' }).tone;
    const result = await draftReply({ chat, messages: store.listMessages(id, 30), mySamples: store.myRecentMessages(id), tone });
    if (!result) throw new HttpError(503, 'AI taslak kapalı: ANTHROPIC_API_KEY tanımlı değil');
    return result;
  });
  route('GET', '/api/logs', () => bus.recent.slice(-200));
  // Telefondan erişim (aynı Wi‑Fi): bağlantı + QR; açma/kapama
  route('GET', '/api/lan', () => lanInfo());
  route('POST', '/api/lan', async (_r, _s, _p, body) => {
    lanEnabled = !!(body as { enabled?: boolean }).enabled;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...readSettings(), lan: lanEnabled }), { mode: 0o600 });
    bus.log('info', lanEnabled ? `Telefondan erişim açıldı: ${lanAddresses().map((ip) => `http://${ip}:${port}`).join(', ')}` : 'Telefondan erişim kapatıldı');
    return lanInfo();
  });
  route('GET', '/api/search', (req) => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? '';
    return q.trim() ? store.search(q) : [];
  });

  // ---------- static (derlenmiş arayüz varsa) ----------
  const here = path.dirname(fileURLToPath(import.meta.url));
  // derlenmiş arayüz: geliştirmede apps/web/dist, paketli uygulamada Resources/core/web (bundle-core.mjs kopyalar)
  const distDir = [path.resolve(here, '../web'), path.resolve(here, '../../web'), path.resolve(here, '../../../apps/web/dist'), path.resolve(here, '../../apps/web/dist')].find((d) => fs.existsSync(path.join(d, 'index.html')));

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    // Yerel arayüzler: Vite (localhost:5173), Tauri (tauri://localhost / http://tauri.localhost) ve WKWebView'ın
    // özel şema sayfaları için gönderdiği "null" kaynağı (yalnızca belirteçle). Sunucu yalnızca 127.0.0.1'e bağlıdır.
    if (origin && (LOCAL_ORIGIN.test(origin) || origin === 'null')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-kavsak-token');
    }
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    if (!authorized(req)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: 'Yetkisiz kaynak' }));
    }

    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/oauth/callback') {
        const ok = resolveOAuth(url.searchParams.get('state') ?? '', { code: url.searchParams.get('code') ?? undefined, error: url.searchParams.get('error') ?? undefined });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return void res.end(
          `<!doctype html><meta charset="utf-8"><body style="font-family:-apple-system,Inter,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f7f6fa;color:#111016"><div style="text-align:center"><div style="font-size:40px">${ok ? '✅' : '⚠️'}</div><h2 style="margin:8px 0">${ok ? 'Bağlandı' : 'Bekleyen giriş yok'}</h2><p style="color:#6b6878">Bu pencere kendiliğinden kapanır; kapanmazsa kapatabilirsin.</p></div><script>setTimeout(()=>window.close(),1200)</script>`,
        );
      }
      // Medya vekili: /api/media/<hesap>?u=<uzak adres> — çerezli oturumla indirir, önbelleğe alır
      if (req.method === 'GET' && url.pathname.startsWith('/api/media/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/media/'.length));
        const u = url.searchParams.get('u') ?? '';
        const c = registry.get(id);
        if (!c?.fetchMedia) throw new HttpError(404, 'Bu hesap medya sunmuyor');
        if (!u) throw new HttpError(400, 'u gerekli');
        if (/^https?:\/\//.test(u)) {
          const host = new URL(u).hostname;
          if (!MEDIA_HOSTS.test(host)) throw new HttpError(403, `Bu sunucudan medya indirilmez: ${host}`);
        }
        // Uzak sunucu hatası (süresi dolmuş CDN bağlantısı → 403 vb.) 500 gibi yığın dökmesin
        const m = await c.fetchMedia(u).catch((e: Error) => {
          const code = (e as { response?: { status?: number } }).response?.status;
          throw new HttpError(502, `Medya indirilemedi${code ? ` (${code})` : ''}: ${e.message.split('\n')[0].slice(0, 160)}`);
        });
        if (!m) throw new HttpError(503, 'Oturum açık değil');
        res.writeHead(200, { 'content-type': m.type, 'content-length': m.body.length, 'cache-control': 'private, max-age=86400' });
        return void res.end(m.body);
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        const body = req.method === 'POST' ? await readJson(req) : undefined;
        const out = await r.handler(req, res, params, body);
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify(out ?? null));
      }
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Yol yok');
      if (distDir) return serveStatic(distDir, url.pathname, res);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Kavşak çekirdeği çalışıyor. Arayüz için: npm run dev -w apps/web');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) bus.log('error', `API: ${(e as Error).stack ?? e}`);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });

  // WebKit (Tauri) bağlantıyı yeniden kullanırken sunucu keep-alive'ı erken kapatırsa "Load failed" oluşur
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;

  // ---------- websocket ----------
  const wss = new WebSocketServer({ server, path: '/ws', verifyClient: (info: { req: http.IncomingMessage }) => authorized(info.req) });
  wss.on('connection', (client) => {
    // Yeni bağlanan arayüze bekleyen QR'ları hemen gönder
    for (const [accountId, qrDataUrl] of pendingQr) client.send(JSON.stringify({ type: 'account.qr', accountId, qrDataUrl }));
  });
  const unsub = bus.on((ev) => {
    const payload = JSON.stringify(ev);
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
  server.on('close', unsub);

  // 0.0.0.0: telefondan erişim için; uzak istemciler yalnızca LAN modu + belirteçle geçer (authorized)
  server.listen(port, '0.0.0.0', () => bus.log('info', `Yerel API hazır: http://127.0.0.1:${port}  (ws: /ws)${lanEnabled ? ' · telefondan: ' + lanAddresses().map((ip) => `http://${ip}:${port}`).join(', ') : ''}`));
  return server;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) {
        reject(new HttpError(413, 'İstek gövdesi çok büyük'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new HttpError(400, 'Geçersiz JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function serveStatic(dir: string, pathname: string, res: http.ServerResponse): void {
  let file = path.join(dir, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(dir)) file = path.join(dir, 'index.html');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dir, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}
