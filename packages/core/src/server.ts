import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import QRCode from 'qrcode';
import { DATA_DIR } from './config.js';
import { ScheduledQueue } from './scheduled.js';
import type { CalEvent } from './model.js';
import { addToDeviceCalendar, deviceCalendarApp, listDeviceCalendars, type DeviceCalendarError } from './calendar-device.js';
import { WebSocketServer, WebSocket } from 'ws';
import { markActive } from './activity.js';
import type { Store } from './store.js';
import type { Registry } from './registry.js';
import type { Connector, LoginInput } from './connectors/base.js';
import { resolveOAuth } from './connectors/mail.js';
import { bus } from './bus.js';
import { AiError, aiEnabled, aiKey, aiKeySource, draftReply, isAiTone, setAiKey } from './ai.js';
import { analyzeStyle, describeStyle } from './style.js';
import { buildIcs, formatStart, parseStart } from './calendar.js';
import { openExternal } from './platform.js';
import { ALL_PLATFORMS } from './model.js';
import { MEDIA_HOSTS, PLATFORM_MEDIA_HOSTS, MEDIA_MAX } from './media-hosts.js';
import { fetchPreview } from './link-preview.js';
import { checkSend, persistSendGuard, SendBlocked } from './send-guard.js';
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
/** ~/.mivelo/settings.json: { lan: boolean } — telefondan (aynı Wi‑Fi) erişim */
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
const hasForwarded = (req: http.IncomingMessage) => !!(req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-host']);

/** Kalıcı hatayla dönen medya istekleri (hesap|adres → zaman, kod) */
const mediaFailures = new Map<string, { at: number; code: number }>();

export function createServer(store: Store, registry: Registry, port: number): http.Server {
  persistSendGuard(path.join(DATA_DIR, 'send-guard.json'));
  const scheduled = new ScheduledQueue(path.join(DATA_DIR, 'scheduled.json'));
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
  /** Belirteç karşılaştırması sabit sürede (zamanlama ile tahmin edilemesin) */
  const tokenBuf = Buffer.from(token);
  const tokenOk = (req: http.IncomingMessage): boolean => {
    const g = Buffer.from(String(givenToken(req)));
    return g.length === tokenBuf.length && timingSafeEqual(g, tokenBuf);
  };
  /**
   * DNS yeniden bağlama (rebinding) önlemi: kötü niyetli bir site adını 127.0.0.1'e çevirip aynı-kaynak GET'le (Origin'siz)
   * API'yi okuyamasın. Host yalnız yerel adlar (çekirdek portu ya da Vite 5173 vekili — vekil Host'u değiştirmez), Tauri ve
   * LAN açıkken bu makinenin ağ adresleri olabilir. Tünel/vekil istekleri (forwarded başlıklar) ayrıca belirteç ister.
   */
  const hostAllowed = (req: http.IncomingMessage): boolean => {
    if (hasForwarded(req)) return true;
    const raw = req.headers.host;
    if (!raw) return true; // tarayıcılar Host'u her zaman gönderir; Host'suz istek tarayıcıdan gelmez
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(raw.trim().toLowerCase());
    if (!m) return false;
    const host = m[1];
    const p = m[2] ? Number(m[2]) : 80;
    if (host === 'tauri.localhost') return true;
    if ((host === 'localhost' || host === '127.0.0.1' || host === '[::1]') && (p === port || p === 5173)) return true;
    return lanEnabled && p === port && lanAddresses().includes(host);
  };
  /**
   * Yerel (loopback) istemci: Origin yoksa ya da yerel origin ise serbest; diğer origin'ler (null dahil) belirteç ister.
   * Uzak istemci (telefon): yalnızca LAN modu açıksa ve belirteç doğruysa.
   */
  const authorized = (req: http.IncomingMessage): boolean => {
    if (!hostAllowed(req)) return false;
    if (!isLoopback(req.socket.remoteAddress)) {
      if (!lanEnabled) return false;
      // arayüz dosyaları (index, assets) belirteçsiz inebilir; veri (/api, /ws) belirteç ister
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      if (req.method === 'GET' && !p.startsWith('/api/') && p !== '/ws') return true;
      return tokenOk(req);
    }
    // Tünel/vekil üzerinden gelen istekler (cloudflared, ngrok) loopback görünür: bunlar uzak sayılır, belirteç şart
    if (hasForwarded(req)) return tokenOk(req);
    const origin = req.headers.origin;
    if (!origin || LOCAL_ORIGIN.test(origin)) return true;
    return tokenOk(req);
  };
  /** Uzak (LAN/tünel) istemciden hesap ekleme/silme/LAN ayarı yapılamaz: belirteç sızsa da yıkıcı işlemler bu Mac'te kalır */
  const isRemote = (req: http.IncomingMessage) => !isLoopback(req.socket.remoteAddress) || hasForwarded(req);
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
  /** LAN'dan (uzak adresten) bağlanan WS istemcileri: telefondan erişim kapatılınca hemen koparılır */
  const lanClients = new WeakSet<WebSocket>();
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
    // close() yalnız yeni bağlantıları durdurur: açık keep-alive soketleri ve WS istemcileri de kesilsin
    lanServer?.closeAllConnections();
    lanServer = undefined;
    for (const client of wss.clients) if (lanClients.has(client)) client.terminate();
  };
  /** withToken: yalnız bu bilgisayardan istenince (QR/bağlantı belirteci taşır); uzak istemciye belirteç geri verilmez */
  const lanInfo = async (withToken: boolean) => {
    const urls = lanAddresses().map((ip) => `http://${ip}:${port}/${withToken ? `#token=${token}` : ''}`);
    return { enabled: lanEnabled, urls, qr: urls[0] ? await QRCode.toDataURL(urls[0], { margin: 1, width: 220 }) : undefined };
  };
  // Bekleyen QR kodları: arayüz sonradan açılsa da eşleşme ekranı boş kalmasın
  const pendingQr = new Map<string, string>();
  bus.on((ev) => {
    if (ev.type === 'account.qr') pendingQr.set(ev.accountId, ev.qrDataUrl);
    if (ev.type === 'account.status' && ev.account.status !== 'pairing') pendingQr.delete(ev.account.id);
    // sohbet silindi: bekleyen zamanlanmış gönderimleri de at
    if (ev.type === 'chat.delete' && scheduled.list(ev.chatId).length) {
      scheduled.removeChat(ev.chatId);
      bus.emit({ type: 'scheduled.update' });
    }
  });

  // ---------- routes ----------
  route('GET', '/api/health', () => {
    const m = process.memoryUsage();
    return { ok: true, ai: aiEnabled(), stats: store.stats(), os: process.platform, pid: process.pid, uptimeSec: Math.round(process.uptime()), memoryMb: { rss: Math.round(m.rss / 1048576), heapUsed: Math.round(m.heapUsed / 1048576), heapTotal: Math.round(m.heapTotal / 1048576), external: Math.round(m.external / 1048576) } };
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
    const id = dec(p.id);
    if (!store.getAccount(id) && !registry.get(id)) throw new HttpError(404, 'Hesap yok');
    await registry.remove(id);
    // hesabın sohbetlerine zamanlanmış gönderimler de gitsin (yoksa 404 → "kaçırıldı" olarak 7 gün kalırdı)
    const gone = new Set(scheduled.list().filter((s) => s.chatId.startsWith(`${id}/`)).map((s) => s.chatId));
    for (const cid of gone) scheduled.removeChat(cid);
    if (gone.size) bus.emit({ type: 'scheduled.update' });
    return { ok: true };
  });
  route('POST', '/api/accounts/:id/restart', async (r, _s, p) => {
    localOnly(r);
    if (!store.getAccount(dec(p.id))) throw new HttpError(404, 'Hesap yok');
    await registry.restart(dec(p.id));
    return { ok: true };
  });
  // Mivelo içi giriş ekranı: fare/klavye girdisi, iptal, ayrı pencereye geçiş
  route('POST', '/api/accounts/:id/login-input', async (_r, _s, p, body) => {
    const c = registry.get(dec(p.id)) as { loginInput?: (e: LoginInput[]) => Promise<void> } | undefined;
    if (!c?.loginInput) throw new HttpError(400, 'Bu hesap giriş ekranı açmıyor');
    const events = (body as { events?: LoginInput[] }).events;
    if (!Array.isArray(events) || events.length > 200) throw new HttpError(400, 'Geçersiz girdi');
    await c.loginInput(events).catch((e) => {
      throw new HttpError(409, (e as Error).message);
    });
    return { ok: true };
  });
  route('POST', '/api/accounts/:id/login-cancel', (_r, _s, p) => {
    const c = registry.get(dec(p.id)) as { loginCancel?: () => void } | undefined;
    c?.loginCancel?.();
    return { ok: true };
  });
  route('POST', '/api/accounts/:id/login-window', async (r, _s, p) => {
    localOnly(r);
    if (!store.getAccount(dec(p.id))) throw new HttpError(404, 'Hesap yok');
    await registry.restart(dec(p.id), { external: true });
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
  // e-postanın özgün HTML gövdesi (listede taşınmaz; arayüz ileti açılınca ister)
  route('GET', '/api/messages/:id/html', (_r, _s, p) => {
    const html = store.getMessageHtml(dec(p.id));
    if (html === undefined) throw new HttpError(404, 'HTML gövde yok');
    return { html };
  });
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
    if (!store.getChat(id)) throw new HttpError(404, 'Sohbet yok');
    // yalnız metin/sayı etiketler ("null", "[object Object]" gibi çöp etiket yazılmasın)
    const clean = tags.filter((t) => typeof t === 'string' || typeof t === 'number').map((t) => String(t).trim().slice(0, 40)).filter(Boolean);
    store.setTags(id, [...new Set(clean)].slice(0, 20));
    const chat = store.getChat(id)!;
    bus.emit({ type: 'chat.upsert', chat });
    return chat;
  });
  /** Ban önleme: toplu/aşırı gönderim desenini gönderimden önce durdur (send-guard.ts) */
  const guardSend = (chat: { id: string; accountId: string; platform: Platform }, text?: string) => {
    try {
      // ilk temas: karşı taraf bu sohbette hiç yazmamış (soğuk mesaj) → daha sıkı günlük sınır
      const isNew = !store.listMessages(chat.id, 300).some((m) => !m.fromMe);
      checkSend({ accountId: chat.accountId, platform: chat.platform, chatId: chat.id, text, isNew });
    } catch (e) {
      if (e instanceof SendBlocked) {
        bus.log('warn', `${chat.platform}: gönderim güvenlik sınırı: ${e.message}`);
        throw new HttpError(429, e.message);
      }
      throw e;
    }
  };
  // Dosya gönderme: JSON {name, mime, data(base64), caption} → ~/.mivelo/outbox/<zaman>-<ad> → connector.sendMedia
  route('POST', '/api/chats/:id/send-file', async (_r, _s, p, body) => {
    const id = dec(p.id);
    const chat = store.getChat(id);
    if (!chat) throw new HttpError(404, 'Sohbet yok');
    const b = body as { name?: string; mime?: string; data?: string; caption?: string; voice?: boolean };
    if (!b.name || !b.data) throw new HttpError(400, 'name ve data gerekli');
    const c = registry.get(chat.accountId);
    if (!c) throw new HttpError(409, 'Hesap bağlı değil');
    if (!c.sendMedia) throw new HttpError(400, 'Bu platformda dosya gönderme desteklenmiyor');
    guardSend(chat, b.caption ? String(b.caption) : undefined);
    const dir = path.join(DATA_DIR, 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(b.name).replace(/[^\w.\-çğıöşüÇĞİÖŞÜ ]+/g, '_').slice(0, 120) || 'dosya';
    const file = path.join(dir, `${Date.now()}-${safe}`);
    const buf = Buffer.from(String(b.data), 'base64');
    fs.writeFileSync(file, buf);
    try {
      return await c.sendMedia(chat.remoteId, { path: file, name: safe, mime: String(b.mime || 'application/octet-stream'), size: buf.length, voice: b.voice === true }, b.caption ? String(b.caption) : undefined);
    } finally {
      // connector'lar dosyayı gönderim sırasında okur/kopyalar: hemen sil (kimlik belgesi vb. diskte kalmasın)
      setTimeout(() => {
        fs.rmSync(file, { force: true });
        fs.rmSync(file + '.opus.ogg', { force: true }); // sesli mesaj dönüşümü (WhatsApp)
      }, 5_000).unref();
    }
  });
  // Sohbet listesinin sonraki sayfası (daha eski e-postalar/sohbetler)
  route('POST', '/api/accounts/:id/more', async (_r, _s, p) => {
    const c = registry.get(dec(p.id));
    if (!c) throw new HttpError(409, 'Hesap bağlı değil');
    if (!c.loadMoreChats) return { added: 0, supported: false };
    return { added: await c.loadMoreChats(), supported: true };
  });
  /** Metin gönderimi (anlık /send ve zamanlanmış gönderim aynı yoldan: güvenlik sınırları, hata metni) */
  const sendTextNow = async (id: string, text: string, threadId?: string, replyTo?: string) => {
    const chat = store.getChat(id);
    if (!chat) throw new HttpError(404, 'Sohbet yok');
    if (!text) throw new HttpError(400, 'Boş mesaj');
    const c = registry.get(chat.accountId);
    if (!c) throw new HttpError(409, 'Hesap bağlı değil');
    guardSend(chat, text);
    const opts = {
      ...(threadId ? { threadId: String(threadId).slice(0, 64) } : {}),
      // yanıtlanan mesaj (platform kimliği): WhatsApp alıntı, Telegram reply, Instagram replied_to
      ...(replyTo ? { replyTo: String(replyTo).slice(0, 200) } : {}),
    };
    try {
      return await c.sendText(chat.remoteId, text, Object.keys(opts).length ? opts : undefined);
    } catch (e) {
      // gönderim hatası kullanıcıya anlamlı dönsün (oturum düşmüş, alıcı yok…); ayrıntı yine günlükte
      bus.log('warn', `${chat.platform} gönderilemedi: ${(e as Error).message.split('\n')[0].slice(0, 300)}`);
      throw new HttpError(502, `Gönderilemedi: ${(e as Error).message.split('\n')[0].slice(0, 160)}`);
    }
  };
  route('POST', '/api/chats/:id/send', async (_r, _s, p, body) => {
    const b = body as { text?: string; threadId?: string; replyTo?: string };
    return sendTextNow(dec(p.id), String(b.text ?? '').trim(), b.threadId, typeof b.replyTo === 'string' ? b.replyTo : undefined);
  });
  // Zamanlanmış gönderim: çekirdekte tutulur, arayüz kapalıyken de gider (bkz. scheduled.ts)
  route('GET', '/api/scheduled', (req) => {
    const chat = new URL(req.url ?? '/', 'http://x').searchParams.get('chat') ?? undefined;
    return scheduled.list(chat);
  });
  route('POST', '/api/scheduled', (_r, _s, _p, body) => {
    const b = (body ?? {}) as { chatId?: string; text?: string; at?: number; threadId?: string };
    const text = String(b.text ?? '').trim();
    const at = Number(b.at);
    if (!b.chatId || !store.getChat(String(b.chatId))) throw new HttpError(404, 'Sohbet yok');
    if (!text) throw new HttpError(400, 'Boş mesaj');
    if (!Number.isFinite(at) || at < Date.now() - 60_000) throw new HttpError(400, 'Geçmiş bir zaman seçilemez');
    const item = scheduled.add(String(b.chatId), text.slice(0, 20_000), at, b.threadId ? String(b.threadId).slice(0, 64) : undefined);
    bus.emit({ type: 'scheduled.update' });
    return item;
  });
  route('DELETE', '/api/scheduled/:sid', (_r, _s, p) => {
    const ok = scheduled.remove(dec(p.sid));
    if (ok) bus.emit({ type: 'scheduled.update' });
    return { ok };
  });
  // Yeni e-posta (e-posta hesapları): Kime / Konu / Metin → dizi sohbeti
  route('POST', '/api/accounts/:id/compose', async (_r, _s, p, body) => {
    const c = registry.get(dec(p.id));
    if (!c) throw new HttpError(409, 'Hesap bağlı değil');
    if (!c.compose) throw new HttpError(400, 'Bu hesapta yeni e-posta oluşturma desteklenmiyor');
    const b = (body ?? {}) as { to?: string; subject?: string; text?: string };
    const to = String(b.to ?? '').trim();
    const text = String(b.text ?? '').trim();
    if (!to || !text) throw new HttpError(400, 'Alıcı ve metin gerekli');
    return c.compose({ to: to.slice(0, 200), subject: String(b.subject ?? '').trim().slice(0, 300), text: text.slice(0, 50_000) });
  });
  // Emoji tepkisi: aynı emoji zaten benimse kaldırır (toggle); platforma iletilir, depo hemen güncellenir
  route('POST', '/api/chats/:id/react', async (_r, _s, p, body) => {
    const id = dec(p.id);
    const chat = store.getChat(id);
    if (!chat) throw new HttpError(404, 'Sohbet yok');
    const b = body as { messageId?: string; emoji?: string };
    const emoji = String(b.emoji ?? '').trim();
    if (!b.messageId || !emoji || emoji.length > 16) throw new HttpError(400, 'messageId ve emoji gerekli');
    const m = store.getMessage(String(b.messageId));
    if (!m || m.chatId !== id) throw new HttpError(404, 'Mesaj yok');
    const c = registry.get(chat.accountId);
    if (!c?.react) throw new HttpError(400, 'Bu platformda tepki desteklenmiyor');
    const mine = m.reactions?.find((r) => r.fromMe);
    const remove = mine?.emoji === emoji;
    await c.react(chat.remoteId, m.remoteId, emoji, remove);
    const next = store.setReaction(m.id, { emoji, senderId: 'me', senderName: 'Ben', fromMe: true }, remove);
    if (next) bus.emit({ type: 'message.upsert', message: next, chat: store.getChat(id)! });
    return next;
  });
  // Kendi mesajımı herkesten sil / düzenle: platforma iletilir, depo hemen güncellenir (platformun yankısı aynı sonucu yazar)
  const ownMessage = (id: string) => {
    const m = store.getMessage(id);
    if (!m) throw new HttpError(404, 'Mesaj yok');
    if (!m.fromMe) throw new HttpError(400, 'Yalnız kendi mesajın');
    if (m.deleted) throw new HttpError(400, 'Mesaj zaten silinmiş');
    if (m.remoteId.startsWith('local-')) throw new HttpError(400, 'Mesaj henüz platforma ulaşmadı');
    const chat = store.getChat(m.chatId);
    if (!chat) throw new HttpError(404, 'Sohbet yok');
    return { m, chat, c: registry.get(chat.accountId) };
  };
  route('POST', '/api/messages/:id/delete', async (_r, _s, p) => {
    const { m, chat, c } = ownMessage(dec(p.id));
    if (!c?.deleteMessage) throw new HttpError(400, 'Bu platformda mesaj silme desteklenmiyor');
    await c.deleteMessage(chat.remoteId, m.remoteId);
    const next = store.applyEdit(m.id, null) ?? store.getMessage(m.id);
    if (next) bus.emit({ type: 'message.upsert', message: next, chat: store.getChat(chat.id)! });
    return next;
  });
  route('POST', '/api/messages/:id/edit', async (_r, _s, p, body) => {
    const { m, chat, c } = ownMessage(dec(p.id));
    if (!c?.editMessage) throw new HttpError(400, 'Bu platformda mesaj düzenleme desteklenmiyor');
    const text = String((body as { text?: unknown } | undefined)?.text ?? '').trim();
    if (!text) throw new HttpError(400, 'Metin gerekli');
    if (text.length > 20_000) throw new HttpError(400, 'Metin çok uzun');
    // bağlantı önizlemesi (kind 'other') metin mesajı sayılır; medya/dosyalı mesaj düzenlenmez
    if (!m.text.trim() || m.attachments?.some((a) => a.kind !== 'other')) throw new HttpError(400, 'Yalnız metin mesajı düzenlenebilir');
    if (text === m.text) return m;
    await c.editMessage(chat.remoteId, m.remoteId, text);
    const next = store.applyEdit(m.id, text) ?? store.getMessage(m.id);
    if (next) bus.emit({ type: 'message.upsert', message: next, chat: store.getChat(chat.id)! });
    return next;
  });
  // Yerel bayraklar: sabitle / arşivle / sessize al / gizle (platforma yansımaz)
  route('POST', '/api/chats/:id/flags', (_r, _s, p, body) => {
    const id = dec(p.id);
    const b = (body ?? {}) as Record<string, unknown>;
    const flags: Record<string, boolean> = {};
    for (const k of ['pinned', 'archived', 'muted', 'hidden']) if (typeof b[k] === 'boolean') flags[k] = b[k] as boolean;
    const chat = store.setFlags(id, flags);
    if (!chat) throw new HttpError(404, 'Sohbet yok');
    bus.emit({ type: 'chat.upsert', chat });
    return chat;
  });
  // Bağlantı önizlemesi (Open Graph); güvenli getirici link-preview.ts
  route('GET', '/api/preview', async (req) => {
    // Dış istek başlatan uç: başka bir sitenin <img src> ile (Origin'siz GET) tetiklemesine izin verme.
    // Arayüz her istekte x-mivelo-client gönderir (özel başlık → çapraz sitede ön kontrol + Origin → belirteç şart)
    if (!req.headers['x-mivelo-client'] && !tokenOk(req)) throw new HttpError(403, 'İstemci doğrulanamadı');
    const url = new URL(req.url ?? '/', 'http://x').searchParams.get('url') ?? '';
    if (!/^https?:\/\//i.test(url) || url.length > 2048) throw new HttpError(400, 'url gerekli');
    return (await fetchPreview(url)) ?? { url, none: true };
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
    try {
      if (c?.loadHistory) await c.loadHistory(chat.remoteId, Math.min(500, Math.max(1, Number(b.limit) || 50)), Number.isFinite(before) && before > 0 ? before : undefined);
    } catch (e) {
      throw new HttpError(502, `Geçmiş yüklenemedi: ${(e as Error).message.split('\n')[0].slice(0, 160)}`);
    }
    return { ok: true };
  });
  route('POST', '/api/chats/:id/draft', async (_r, _s, p, body) => {
    const id = dec(p.id);
    const chat = store.getChat(id);
    if (!chat) throw new HttpError(404, 'Sohbet yok');
    const t = (body as { tone?: unknown }).tone;
    if (t !== undefined && t !== null && !isAiTone(t)) throw new HttpError(400, 'Geçersiz ton');
    const tone = isAiTone(t) ? t : undefined;
    const style = analyzeStyle([...store.myTexts(chat.platform, 250), ...store.myTexts(undefined, 250)]);
    const pairs = store.styleSamples(id, chat.platform, 12);
    const result = await draftReply({ chat, messages: store.listMessages(id, 30), pairs, style, tone }).catch((e: unknown) => {
      // model hatası (geçersiz anahtar, sınır, yoğunluk) arayüze anlamlı dönsün; genel 500 değil
      if (e instanceof AiError) throw new HttpError(e.status, e.message);
      throw e;
    });
    if (!result) throw new HttpError(503, 'AI taslak kapalı: ANTHROPIC_API_KEY tanımlı değil');
    return result;
  });
  // "Senin tarzın": kendi mesajlarından yerelde çıkarılan üslup profili (AI anahtarı gerekmez)
  // AI anahtarı (Ayarlar → AI özellikleri): yalnız bu bilgisayardan değiştirilebilir; değer asla geri döndürülmez, yalnız maske
  route('GET', '/api/ai/key', () => {
    const k = aiKey();
    return { set: Boolean(k), source: aiKeySource(), hint: k ? `${k.slice(0, 7)}…${k.slice(-4)}` : null };
  });
  route('POST', '/api/activity', (_r, _s, _p, body) => {
    markActive((body as { active?: unknown }).active === true);
    return { ok: true };
  });
  route('POST', '/api/ai/key', (req, _s, _p, body) => {
    localOnly(req);
    const key = (body as { key?: string | null }).key;
    if (key === null || key === '') {
      setAiKey(null);
    } else {
      const k = String(key).trim();
      if (!/^sk-ant-[A-Za-z0-9_-]{20,200}$/.test(k)) throw new HttpError(400, 'Geçerli bir Anthropic API anahtarı gir (sk-ant- ile başlar)');
      setAiKey(k);
    }
    bus.log('info', `AI anahtarı ${key ? 'kaydedildi' : 'kaldırıldı'}`);
    return { ok: true, ai: aiEnabled() };
  });
  route('GET', '/api/style', (req) => {
    const platform = new URL(req.url ?? '/', 'http://x').searchParams.get('platform') || undefined;
    const profile = analyzeStyle([...(platform ? store.myTexts(platform, 250) : []), ...store.myTexts(undefined, platform ? 250 : 500)]);
    return { profile, lines: describeStyle(profile) };
  });
  // Takip hatırlatıcısı: { at: ms } kur, { at: null } kaldır. Karşı taraf yazınca kendiliğinden kapanır.
  route('POST', '/api/chats/:id/followup', (_r, _s, p, body) => {
    const id = dec(p.id);
    const at = (body as { at?: number | null }).at;
    if (at !== null && (typeof at !== 'number' || !Number.isFinite(at) || at < Date.now() - 60_000 || at > Date.now() + 366 * 86_400_000)) throw new HttpError(400, 'Geçersiz hatırlatma zamanı');
    const chat = store.setFollowUp(id, at);
    if (!chat) throw new HttpError(404, 'Sohbet yok');
    bus.emit({ type: 'chat.upsert', chat });
    return chat;
  });
  // Takvime ekle: .ics üretir; bu bilgisayardan istenmişse takvim uygulamasında açar, uzaktaysa dosyayı döndürür (tarayıcı indirir)
  // ---------- Mivelo takvimi (uygulama içi) ----------
  route('GET', '/api/events', (req) => {
    const sp = new URL(req.url ?? '/', 'http://x').searchParams;
    return store.listEvents(sp.get('from') ?? undefined, sp.get('to') ?? undefined);
  });
  // oluştur / güncelle (id verilirse); device:true → cihaz takvimine de (arayüz onay aldıysa)
  route('POST', '/api/events', async (req, _s, _p, body) => {
    const b = (body ?? {}) as Partial<CalEvent> & { device?: boolean; calendar?: string };
    const title = String(b.title ?? '').trim().slice(0, 200);
    const pv = parseStart(String(b.start ?? ''));
    if (!title || !pv) throw new HttpError(400, 'Başlık ve geçerli tarih gerekli');
    // kanonik biçim ("YYYY-MM-DDTHH:mm" / "YYYY-MM-DD"): boşluklu/kırpılmamış giriş hatırlatmayı sessizce kapatmasın
    const start = formatStart(pv);
    const rawRemind = b.remindMin as unknown;
    const noRemind = rawRemind === null || rawRemind === undefined || rawRemind === '';
    const remindNum = noRemind ? undefined : Number(rawRemind);
    if (remindNum !== undefined && !Number.isFinite(remindNum)) throw new HttpError(400, 'Geçersiz hatırlatma süresi');
    const prev = b.id ? store.getEvent(String(b.id)) : undefined;
    const ev: CalEvent = {
      id: prev?.id ?? crypto.randomUUID(),
      title,
      start,
      allDay: pv.allDay,
      durationMin: Math.max(5, Math.min(24 * 60, Number(b.durationMin) || 60)),
      notes: b.notes ? String(b.notes).slice(0, 4000) : undefined,
      location: b.location ? String(b.location).slice(0, 200) : undefined,
      chatId: prev?.chatId ?? (b.chatId && store.getChat(String(b.chatId)) ? String(b.chatId) : undefined),
      messageId: prev?.messageId ?? (b.messageId ? String(b.messageId).slice(0, 300) : undefined),
      remindMin: remindNum === undefined ? undefined : Math.max(0, Math.min(7 * 24 * 60, remindNum)),
      createdAt: prev?.createdAt ?? Date.now(),
    };
    let device: { added?: boolean; calendar?: string; denied?: boolean; error?: string } | undefined;
    // güncellemede cihaz takvimine yeniden ekleme (kopya etkinlik) yok: yalnız henüz eklenmemişse
    if (prev?.deviceCalendar && b.device) device = { added: true, calendar: prev.deviceCalendar };
    else if (b.device && !isRemote(req) && deviceCalendarApp()) {
      try {
        ev.deviceCalendar = await addToDeviceCalendar(ev, b.calendar ? String(b.calendar).slice(0, 200) : undefined);
        device = { added: true, calendar: ev.deviceCalendar };
      } catch (e) {
        const ce = e as DeviceCalendarError;
        device = { added: false, denied: ce.code === 'denied', error: ce.message };
      }
    }
    const saved = store.saveEvent(ev);
    bus.emit({ type: 'events.update' });
    return { event: saved, device };
  });
  route('DELETE', '/api/events/:eid', (_r, _s, p) => {
    const ok = store.deleteEvent(dec(p.eid));
    if (ok) bus.emit({ type: 'events.update' });
    return { ok };
  });
  // Cihaz takvimi: destek var mı; probe=1 → yazılabilir takvim adları (macOS ilk seferde izin sorar — arayüz önce onay alır)
  route('GET', '/api/calendars', async (req) => {
    if (isRemote(req)) return { supported: false, reason: 'remote' };
    const app = deviceCalendarApp();
    if (!app) return { supported: false, reason: 'os' };
    if (new URL(req.url ?? '/', 'http://x').searchParams.get('probe') !== '1') return { supported: true, app };
    try {
      return { supported: true, app, calendars: await listDeviceCalendars() };
    } catch (e) {
      const ce = e as DeviceCalendarError;
      return { supported: true, app, calendars: [], denied: ce.code === 'denied', error: ce.message };
    }
  });
  // macOS: Takvim iznini yeniden açmak için Gizlilik → Otomasyon bölmesi
  route('POST', '/api/calendars/permission', (req) => {
    localOnly(req);
    openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');
    return { ok: true };
  });
  route('POST', '/api/calendar', async (req, _s, _p, body) => {
    const b = (body ?? {}) as { title?: string; start?: string; durationMin?: number; notes?: string; location?: string; mode?: 'device' | 'file'; calendar?: string };
    if (!b.title?.trim() || !b.start || !parseStart(b.start)) throw new HttpError(400, 'Başlık ve geçerli tarih gerekli');
    const ev = { title: b.title, start: b.start, durationMin: Number(b.durationMin) || undefined, notes: b.notes, location: b.location };
    const ics = buildIcs(ev);
    if (isRemote(req)) return { ics, opened: false };
    // Doğrudan cihaz takvimine (kullanıcı arayüzde onay verdiyse); izin reddi arayüze döner, diğer hatalarda .ics'e düşülür
    let fallback: string | undefined;
    if (b.mode === 'device' && deviceCalendarApp()) {
      try {
        const calendar = await addToDeviceCalendar(ev, b.calendar ? String(b.calendar).slice(0, 200) : undefined);
        bus.log('info', `Takvime eklendi (${calendar}): ${ev.title.slice(0, 60)}`);
        return { ics, opened: false, added: true, calendar };
      } catch (e) {
        const ce = e as DeviceCalendarError;
        if (ce.code === 'denied') return { ics, opened: false, added: false, denied: true, error: ce.message };
        fallback = ce.message;
        bus.log('warn', `Takvime doğrudan eklenemedi, dosyayla açılıyor: ${ce.message}`);
      }
    }
    const dir = path.join(DATA_DIR, 'calendar');
    fs.mkdirSync(dir, { recursive: true });
    // eski dosyalar birikmesin (takvim uygulaması içeri aldıktan sonra gereksiz)
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (Date.now() - fs.statSync(fp).mtimeMs > 86_400_000) fs.rmSync(fp, { force: true });
    }
    const file = path.join(dir, `mivelo-${Date.now()}.ics`);
    fs.writeFileSync(file, ics, { mode: 0o600 });
    openExternal(file);
    return { ics, opened: true, fallback };
  });
  route('GET', '/api/logs', () => bus.recent.slice(-200));
  // Telefondan erişim (aynı Wi‑Fi): bağlantı + QR; açma/kapama
  route('GET', '/api/lan', (r) => lanInfo(!isRemote(r)));
  route('POST', '/api/lan', async (r, _s, _p, body) => {
    localOnly(r);
    lanEnabled = !!(body as { enabled?: boolean }).enabled;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...readSettings(), lan: lanEnabled }), { mode: 0o600 });
    if (lanEnabled) openLan();
    else closeLan();
    bus.log('info', lanEnabled ? `Telefondan erişim açıldı: ${lanAddresses().map((ip) => `http://${ip}:${port}`).join(', ')}` : 'Telefondan erişim kapatıldı');
    return lanInfo(true);
  });
  route('GET', '/api/search', (req) => {
    const sp = new URL(req.url ?? '/', 'http://x').searchParams;
    const q = sp.get('q') ?? '';
    const limit = Math.max(1, Math.min(200, Number(sp.get('limit')) || 50));
    return q.trim() ? store.search(q, limit) : [];
  });

  // ---------- static (derlenmiş arayüz varsa) ----------
  const here = path.dirname(fileURLToPath(import.meta.url));
  // derlenmiş arayüz: geliştirmede apps/web/dist, paketli uygulamada Resources/core/web (bundle-core.mjs kopyalar)
  const distDir = [path.resolve(here, '../web'), path.resolve(here, '../../web'), path.resolve(here, '../../../apps/web/dist'), path.resolve(here, '../../apps/web/dist')].find((d) => fs.existsSync(path.join(d, 'index.html')));

  const onRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const origin = req.headers.origin;
    // Yerel arayüzler: Vite (localhost:5173), Tauri (tauri://localhost / http://tauri.localhost) ve WKWebView'ın
    // özel şema sayfaları için gönderdiği "null" kaynağı (yalnızca belirteçle). Sunucu yalnızca 127.0.0.1'e bağlıdır.
    // Uzak arayüz (ör. demo sitesi https://demo.mivelo.app, tünel üzerinden): CORS başlıkları her kaynağa verilir,
    // yetki yine belirteçle (authorized: yerel olmayan kaynak x-kavsak-token/?token= vermek zorunda)
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-kavsak-token, x-mivelo-client');
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
        // Kalıcı hata (401/403/404/410: süresi dolmuş ya da yetkisiz medya) 30 dk hatırlanır: arayüz her çizimde yeniden
        // istemesin — aynı platforma tekrarlanan yetkisiz istekler hem günlüğü doldurur hem otomasyon sinyalidir
        const failKey = `${id}|${u}`;
        const failed = mediaFailures.get(failKey);
        if (failed && Date.now() - failed.at < 30 * 60_000) throw new HttpError(502, `Medya indirilemedi (${failed.code})`);
        // Uzak sunucu hatası (süresi dolmuş CDN bağlantısı → 403 vb.) 500 gibi yığın dökmesin; ayrıntı yalnızca günlüğe
        const m = await c.fetchMedia(u).catch((e: Error) => {
          const ee = e as { response?: { status?: number }; output?: { statusCode?: number } };
          // şifre çözülemeyen medya (anahtar/dosya bozuk; "unable to authenticate data") da kalıcı hata
          const code = /unable to authenticate data/i.test(e.message) ? 422 : (ee.response?.status ?? ee.output?.statusCode ?? Number(/\b(401|403|404|410)\b/.exec(e.message)?.[1] ?? 0));
          if ([401, 403, 404, 410, 422].includes(code)) {
            if (mediaFailures.size > 2000) mediaFailures.clear();
            mediaFailures.set(failKey, { at: Date.now(), code });
          }
          bus.log('warn', `Medya indirilemedi (${id}): ${e.message.split('\n')[0].slice(0, 200)}${code ? ' — 30 dk yeniden denenmeyecek' : ''}`);
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
  wss.on('connection', (client, req: http.IncomingMessage) => {
    if (!isLoopback(req.socket.remoteAddress)) lanClients.add(client);
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
  // Zamanlanmış gönderimler: 15 sn'de bir zamanı gelenler (sıralı; güvenlik sınırları anlık gönderimle aynı)
  let schedBusy = false;
  const schedTimer = setInterval(() => {
    if (schedBusy) return;
    schedBusy = true;
    void scheduled
      .flush((it) => sendTextNow(it.chatId, it.text, it.threadId).then(() => undefined))
      .then(({ sent, missed }) => {
        for (const it of sent) bus.log('info', `Zamanlanmış mesaj gönderildi (${store.getChat(it.chatId)?.name ?? it.chatId})`);
        for (const it of missed) {
          bus.log('warn', `Zamanlanmış mesaj gönderilmedi (${store.getChat(it.chatId)?.name ?? it.chatId}): ${it.missed?.reason}`);
          bus.emit({ type: 'scheduled.missed', item: it, chatName: store.getChat(it.chatId)?.name ?? '' });
        }
        if (sent.length || missed.length) bus.emit({ type: 'scheduled.update' });
      })
      .catch((e) => bus.log('warn', `Zamanlanmış gönderim: ${(e as Error).message}`))
      .finally(() => (schedBusy = false));
  }, 15_000);
  schedTimer.unref();
  // Takip hatırlatıcıları: dakikada bir; yanıt gelenler kapanır, süresi dolanlar bir kez bildirilir
  const followTimer = setInterval(() => {
    try {
      for (const event of store.dueEventReminders()) {
        bus.emit({ type: 'event.reminder', event });
        bus.log('info', `Takvim hatırlatması: ${event.title}`);
      }
      const { resolved, due } = store.checkFollowUps();
      for (const chat of resolved) bus.emit({ type: 'chat.upsert', chat });
      for (const chat of due) {
        bus.emit({ type: 'chat.upsert', chat });
        bus.emit({ type: 'chat.followup', chat });
        bus.log('info', `Takip hatırlatması: ${chat.name} yanıt vermedi`);
      }
    } catch (e) {
      bus.log('warn', `Takip hatırlatıcısı: ${(e as Error).message}`);
    }
  }, 60_000);
  followTimer.unref();
  server.on('close', () => {
    unsub();
    clearInterval(pingTimer);
    clearInterval(followTimer);
    clearInterval(schedTimer);
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
