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
import { ALL_PLATFORMS } from './model.js';
import { MEDIA_HOSTS, PLATFORM_MEDIA_HOSTS, MEDIA_MAX } from './media-hosts.js';
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

/** Belirteçsiz güvenilen yerel kaynaklar: Vite (5173), çekirdeğin kendi portu ve Tauri. Makinedeki BAŞKA yerel web uygulamaları
 * (Jupyter, başka dev sunucu, kötücül paket) artık belirteçsiz geçemez. */
const localOriginRe = (port: number) => new RegExp(`^(https?://(localhost|127\\.0\\.0\\.1):(5173|${port})|https?://tauri\\.localhost(:\\d+)?|tauri://localhost|asset://localhost)$`);
let LOCAL_ORIGIN = localOriginRe(7788);
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
  LOCAL_ORIGIN = localOriginRe(port);
  // açılışta eski outbox artıkları (çekirdek kapanırken silinememiş dosyalar)
  try {
    const ob = path.join(DATA_DIR, 'outbox');
    if (fs.existsSync(ob)) for (const f of fs.readdirSync(ob)) if (Date.now() - fs.statSync(path.join(ob, f)).mtimeMs > 3_600_000) fs.rmSync(path.join(ob, f), { force: true });
  } catch {
    /* yok */
  }
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
    // Tünel/vekil üzerinden gelen istekler (cloudflared, ngrok) loopback görünür: bunlar uzak sayılır, belirteç şart
    if (req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-host']) return givenToken(req) === token;
    const origin = req.headers.origin;
    if (!origin || LOCAL_ORIGIN.test(origin)) return true;
    return givenToken(req) === token;
  };
  /** Uzak (LAN/tünel) istemciden hesap ekleme/silme/LAN ayarı yapılamaz: belirteç sızsa da yıkıcı işlemler bu Mac'te kalır */
  const isRemote = (req: http.IncomingMessage) => !isLoopback(req.socket.remoteAddress) || !!(req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-host']);
  const localOnly = (req: http.IncomingMessage) => {
    if (isRemote(req)) throw new HttpError(403, 'Bu işlem yalnızca bu bilgisayardan yapılabilir');
  };
  const dec = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      throw new HttpError(400, 'Geçersiz kimlik');
    }
  };
  let lanServer: http.Server | undefined;
  const openLan = () => {
    if (lanServer) return;
    lanServer = http.createServer(onRequest);
    attachUpgrade(lanServer);
    lanServer.keepAliveTimeout = 120_000;
    lanServer.on('error', (e) => bus.log('warn', `LAN dinleyicisi: ${(e as Error).message}`));
    lanServer.listen(port, '0.0.0.0');
  };
  const closeLan = () => {
    lanServer?.close();
    lanServer = undefined;
  };
  const lanInfo = async () => {
    const urls = lanAddresses().map((ip) => `http://${ip}:${port}/#token=${token}`);
    return { enabled: lanEnabled, urls, qr: urls[0] ? await QRCode.toDataURL(urls[0], { margin: 1, width: 220 }) : undefined };
  };
  // Bekleyen QR kodları: arayüz sonradan açılsa da eşleşme ekranı boş kalmasın
  const pendingQr = new Map<string, string>();
  bus.on((ev) => {
    if (ev.type === 'account.qr') pendingQr.set(ev.accountId, ev.qrDataUrl);
    if (ev.type === 'account.status' && ev.account.status !== 'pairing') pendingQr.delete(ev.account.id);
  });

  // ---------- routes ----------
  route('GET', '/api/health', () => {
    const m = process.memoryUsage();
    return { ok: true, ai: aiEnabled(), stats: store.stats(), pid: process.pid, uptimeSec: Math.round(process.uptime()), memoryMb: { rss: Math.round(m.rss / 1048576), heapUsed: Math.round(m.heapUsed / 1048576), heapTotal: Math.round(m.heapTotal / 1048576), external: Math.round(m.external / 1048576) } };
  });

  route('GET', '/api/accounts', () => registry.list().map((a) => ({ ...a, qrDataUrl: pendingQr.get(a.id) })));
  route('POST', '/api/accounts', async (r, _s, _p, body) => {
    localOnly(r);
    const b = body as { platform?: Platform; token?: string; label?: string };
    if (!b.platform || !ALL_PLATFORMS.includes(b.platform)) throw new HttpError(400, 'Geçersiz platform');
    return registry.add(b.platform, { token: typeof b.token === 'string' ? b.token : undefined, label: typeof b.label === 'string' ? b.label.slice(0, 80) : undefined });
  });
  route('DELETE', '/api/accounts/:id', async (r, _s, p) => {
    localOnly(r);
    await registry.remove(dec(p.id));
    return { ok: true };
  });
  route('POST', '/api/accounts/:id/restart', async (r, _s, p) => {
    localOnly(r);
    await registry.restart(dec(p.id));
    return { ok: true };
  });
  route('POST', '/api/accounts/:id/input', (_r, _s, p, body) => {
    const c = registry.get(dec(p.id));
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
    return store.listMessages(dec(p.id), limit, Number.isFinite(before) && before > 0 ? before : undefined);
  });
  route('POST', '/api/chats/:id/read', (_r, _s, p) => {
    const id = dec(p.id);
    const before = store.getChat(id);
    store.markRead(id);
    // sohbet açık: yazıyor/çevrimiçi aboneliği (WhatsApp presence vb.)
    { const c0 = store.getChat(id); if (c0) void registry.get(c0.accountId)?.watch?.(c0.remoteId).catch(() => undefined); }
    const chat = store.getChat(id);
    if (chat) {
      bus.emit({ type: 'chat.upsert', chat });
      // platformda da okundu işaretle (yalnızca gerçekten okunmamış vardıysa; arka planda)
      if (before && before.unread > 0) void registry.get(chat.accountId)?.markRead?.(chat.remoteId).catch((e) => bus.log('warn', `${chat.platform}: okundu işaretlenemedi: ${(e as Error).message}`));
    }
    return { ok: true };
  });
  route('POST', '/api/chats/:id/tags', (_r, _s, p, body) => {
    const id = dec(p.id);
    const tags = (body as { tags?: unknown }).tags ?? [];
    if (!Array.isArray(tags)) throw new HttpError(400, 'tags bir dizi olmalı');
    store.setTags(id, tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20));
    const chat = store.getChat(id);
    if (chat) bus.emit({ type: 'chat.upsert', chat });
    return chat;
  });
  // Dosya gönderme: JSON {name, mime, data(base64), caption} → ~/.kavsak/outbox/<zaman>-<ad> → connector.sendMedia
  route('POST', '/api/chats/:id/send-file', async (_r, _s, p, body) => {
    const id = dec(p.id);
    const chat = store.getChat(id);
    if (!chat) throw new HttpError(404, 'Sohbet yok');
    const b = body as { name?: string; mime?: string; data?: string; caption?: string };
    if (!b.name || !b.data) throw new HttpError(400, 'name ve data gerekli');
    const c = registry.get(chat.accountId);
    if (!c) throw new HttpError(409, 'Hesap bağlı değil');
    if (!c.sendMedia) throw new HttpError(400, 'Bu platformda dosya gönderme desteklenmiyor');
    const dir = path.join(DATA_DIR, 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(b.name).replace(/[^\w.\-çğıöşüÇĞİÖŞÜ ]+/g, '_').slice(0, 120) || 'dosya';
    const file = path.join(dir, `${Date.now()}-${safe}`);
    const buf = Buffer.from(String(b.data), 'base64');
    fs.writeFileSync(file, buf);
    try {
      return await c.sendMedia(chat.remoteId, { path: file, name: safe, mime: String(b.mime || 'application/octet-stream'), size: buf.length }, b.caption ? String(b.caption) : undefined);
    } finally {
      // connector'lar dosyayı gönderim sırasında okur/kopyalar: hemen sil (kimlik belgesi vb. diskte kalmasın)
      setTimeout(() => fs.rmSync(file, { force: true }), 5_000).unref();
    }
  });
  // Sohbet listesinin sonraki sayfası (daha eski e-postalar/sohbetler)
  route('POST', '/api/accounts/:id/more', async (_r, _s, p) => {
    const c = registry.get(dec(p.id));
    if (!c) throw new HttpError(409, 'Hesap bağlı değil');
    if (!c.loadMoreChats) return { added: 0, supported: false };
    return { added: await c.loadMoreChats(), supported: true };
  });
  route('POST', '/api/chats/:id/send', async (_r, _s, p, body) => {
    const id = dec(p.id);
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
    const chat = store.getChat(dec(p.id));
    if (!chat) throw new HttpError(404, 'Sohbet yok');
    const c = registry.get(chat.accountId);
    if (!c?.action) throw new HttpError(400, 'Bu platformda işlem desteklenmiyor');
    await c.action(chat.remoteId, (body ?? {}) as Record<string, unknown>);
    return store.getChat(chat.id);
  });
  route('POST', '/api/chats/:id/history', async (_r, _s, p, body) => {
    const id = dec(p.id);
    const chat = store.getChat(id);
    if (!chat) throw new HttpError(404, 'Sohbet yok');
    const c = registry.get(chat.accountId);
    const b = body as { limit?: number; before?: number };
    const before = Number(b.before);
    if (c?.loadHistory) await c.loadHistory(chat.remoteId, Math.min(500, Math.max(1, Number(b.limit) || 50)), Number.isFinite(before) && before > 0 ? before : undefined);
    return { ok: true };
  });
  route('POST', '/api/chats/:id/draft', async (_r, _s, p, body) => {
    const id = dec(p.id);
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
  route('POST', '/api/lan', async (r, _s, _p, body) => {
    localOnly(r);
    lanEnabled = !!(body as { enabled?: boolean }).enabled;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...readSettings(), lan: lanEnabled }), { mode: 0o600 });
    if (lanEnabled) openLan();
    else closeLan();
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

  const onRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const origin = req.headers.origin;
    // Yerel arayüzler: Vite (localhost:5173), Tauri (tauri://localhost / http://tauri.localhost) ve WKWebView'ın
    // özel şema sayfaları için gönderdiği "null" kaynağı (yalnızca belirteçle). Sunucu yalnızca 127.0.0.1'e bağlıdır.
    // Uzak arayüz (ör. demo sitesi https://mivelo.kaantiftikci.com, tünel üzerinden): CORS başlıkları her kaynağa verilir,
    // yetki yine belirteçle (authorized: yerel olmayan kaynak x-kavsak-token/?token= vermek zorunda)
    if (origin) {
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
        const id = dec(url.pathname.slice('/api/media/'.length));
        const u = url.searchParams.get('u') ?? '';
        const c = registry.get(id);
        if (!c?.fetchMedia) throw new HttpError(404, 'Bu hesap medya sunmuyor');
        if (!u) throw new HttpError(400, 'u gerekli');
        if (/^https?:\/\//.test(u)) {
          let host = '';
          try {
            host = new URL(u).hostname;
          } catch {
            throw new HttpError(400, 'Geçersiz adres');
          }
          const acc = registry.list().find((a) => a.id === id);
          const allow = (acc && PLATFORM_MEDIA_HOSTS[acc.platform]) ?? MEDIA_HOSTS;
          if (!allow.test(host)) throw new HttpError(403, `Bu sunucudan medya indirilmez: ${host}`);
        }
        // Uzak sunucu hatası (süresi dolmuş CDN bağlantısı → 403 vb.) 500 gibi yığın dökmesin; ayrıntı yalnızca günlüğe
        const m = await c.fetchMedia(u).catch((e: Error) => {
          const code = (e as { response?: { status?: number } }).response?.status;
          bus.log('warn', `Medya indirilemedi (${id}): ${e.message.split('\n')[0].slice(0, 200)}`);
          throw new HttpError(502, `Medya indirilemedi${code ? ` (${code})` : ''}`);
        });
        if (!m) throw new HttpError(503, 'Oturum açık değil');
        if (m.body.length > MEDIA_MAX) throw new HttpError(413, 'Medya çok büyük');
        // Saldırgan denetimli content-type (text/html ekli e-posta/belge) API origin'inde çalışmasın: yalnızca görsel/ses/video/PDF
        // satır içi, gerisi indirme; nosniff + sandbox CSP
        const inline = /^(image\/(?!svg)|video\/|audio\/)/i.test(m.type) || m.type === 'application/pdf';
        res.writeHead(200, {
          'content-type': inline ? m.type : 'application/octet-stream',
          'content-length': m.body.length,
          'x-content-type-options': 'nosniff',
          'content-disposition': inline ? 'inline' : 'attachment',
          'content-security-policy': "default-src 'none'; sandbox",
          'cache-control': 'private, max-age=86400',
        });
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
      res.end('Mivelo çekirdeği çalışıyor. Arayüz için: npm run dev -w apps/web');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) bus.log('error', `API: ${(e as Error).stack ?? e}`);
      res.writeHead(status, { 'content-type': 'application/json' });
      // iç hata ayrıntısı (yığın/yol) istemciye gitmesin
      res.end(JSON.stringify({ error: status === 500 ? 'Sunucu hatası (ayrıntı Günlük\'te)' : (e as Error).message }));
    }
  };
  const server = http.createServer(onRequest);

  // WebKit (Tauri) bağlantıyı yeniden kullanırken sunucu keep-alive'ı erken kapatırsa "Load failed" oluşur
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;

  // ---------- websocket ----------
  // WS: tek WebSocketServer, hem yerel hem (açıksa) LAN dinleyicisinin upgrade'lerini alır
  const wss = new WebSocketServer({ noServer: true });
  const attachUpgrade = (srv: http.Server) =>
    srv.on('upgrade', (req, socket, head) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      if (p !== '/ws' || !authorized(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client, req));
    });
  attachUpgrade(server);
  wss.on('connection', (client) => {
    // Yeni bağlanan arayüze bekleyen QR'ları hemen gönder
    for (const [accountId, qrDataUrl] of pendingQr) client.send(JSON.stringify({ type: 'account.qr', accountId, qrDataUrl }));
  });
  const unsub = bus.on((ev) => {
    const payload = JSON.stringify(ev);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      // yavaş/ölü istemcide tampon şişmesin (geçmiş eşitlemesinde binlerce olay)
      if (client.bufferedAmount > 8_000_000) {
        client.terminate();
        continue;
      }
      client.send(payload);
    }
  });
  const alive = new WeakSet<WebSocket>();
  wss.on('connection', (client) => {
    alive.add(client);
    client.on('pong', () => alive.add(client));
  });
  const pingTimer = setInterval(() => {
    for (const client of wss.clients) {
      if (!alive.has(client)) {
        client.terminate();
        continue;
      }
      alive.delete(client);
      client.ping();
    }
  }, 30_000);
  pingTimer.unref();
  server.on('close', () => {
    unsub();
    clearInterval(pingTimer);
  });

  // Yerel dinleyici yalnız 127.0.0.1; LAN modu açıkken ayrı bir dinleyici 0.0.0.0'da (kapatınca port ağdan kaybolur)
  server.listen(port, '127.0.0.1', () => bus.log('info', `Yerel API hazır: http://127.0.0.1:${port}  (ws: /ws)${lanEnabled ? ' · telefondan: ' + lanAddresses().map((ip) => `http://${ip}:${port}`).join(', ') : ''}`));
  if (lanEnabled) openLan();
  server.on('close', () => closeLan());
  return server;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      data += c;
      if (data.length > (req.url?.includes('/send-file') ? 80_000_000 : 1_000_000)) {
        reject(new HttpError(413, 'İstek gövdesi çok büyük'));
        req.pause(); // bağlantıyı koparmak yerine 413 yanıtı yazılabilsin
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        const v: unknown = JSON.parse(data);
        if (v === null || typeof v !== 'object' || Array.isArray(v)) return reject(new HttpError(400, 'JSON nesnesi bekleniyor'));
        resolve(v);
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
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}
