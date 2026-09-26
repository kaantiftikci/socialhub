import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { Page } from 'playwright';
import type { Msg, Strategy, Thread } from './bridge.js';
import type { Attachment, Participant } from '../../model.js';
import { bus } from '../../bus.js';

/**
 * X (Twitter). Kasım 2025'ten beri sohbetler uçtan uca şifreli "XChat" (/i/chat). Sunucu yalnızca
 * şifreli olay akışı verir; web istemcisi bunları tarayıcıda çözüp OPFS içindeki bir SQLite
 * veritabanına yazar (backups/chat_<kimlik>.db). Kaynaklar, öncelik sırasıyla:
 *  1) Yerel XChat veritabanı (sayfa bağlamından okunur): sohbet listesi, okunmamış sayısı, son mesajlar — tam ve hızlı.
 *  2) Eski 1.1 DM uçları: XChat öncesi (donuk) birebir yazışma geçmişi.
 *  3) /i/chat DOM'u: veritabanında olmayan daha eski XChat mesajları (sayfa yukarı kaydırılarak) ve DB yoksa yedek.
 */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

async function xapi(page: Page, cookies: Record<string, string>, path: string, body?: unknown): Promise<J> {
  return page.evaluate(
    async ({ path, body, csrf, bearer }) => {
      const r = await fetch('https://x.com/i/api' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: 'Bearer ' + bearer,
          'x-csrf-token': csrf,
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-active-user': 'yes',
          'x-twitter-client-language': 'tr',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`X ${r.status} ${path}`);
      return r.json();
    },
    { path, body, csrf: cookies.ct0 ?? '', bearer: BEARER },
  );
}

let meId = '';
/** sohbet → karşı tarafın son okuduğu olay kimliği */
const otherLastRead = new Map<string, string>();
const users = new Map<string, string>();
const avatars = new Map<string, string>();
const handles = new Map<string, string>();

function collectUsers(state: J) {
  for (const [id, u] of Object.entries(state?.users ?? {})) {
    users.set(id, (u as J).name ?? (u as J).screen_name ?? id);
    if ((u as J).screen_name) handles.set(id, '@' + (u as J).screen_name);
    if ((u as J).profile_image_url_https) avatars.set(id, String((u as J).profile_image_url_https).replace('_normal.', '_bigger.'));
  }
}

/** twid çerezi "u%3D<id>" biçimindedir */
function meFromCookies(cookies: Record<string, string>): string {
  const m = decodeURIComponent(cookies.twid ?? '').match(/u=(\d+)/);
  return m ? m[1] : '';
}

function groupName(ids: string[]): string {
  const names = ids.map((u) => users.get(u) ?? u);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
}

/** En düşük bit hızlı mp4 varyantı (hızlı önizleme) */
function mp4(v: J | undefined): string | undefined {
  const vs = (v?.video_info?.variants ?? []).filter((x: J) => x.content_type === 'video/mp4');
  vs.sort((a: J, b: J) => (a.bitrate ?? 0) - (b.bitrate ?? 0));
  return vs[Math.min(1, vs.length - 1)]?.url ?? vs[0]?.url;
}

/** DM eki: fotoğraf, video, GIF, kart (link) ya da paylaşılan gönderi */
function attachmentsOf(md: J): { attachments: Attachment[]; strip: string[] } {
  const out: Attachment[] = [];
  const strip: string[] = [];
  const a = md?.attachment;
  if (!a) return { attachments: out, strip };
  if (a.photo) {
    out.push({ kind: 'image', name: 'Fotoğraf', url: a.photo.media_url_https, link: a.photo.media_url_https });
    if (a.photo.url) strip.push(a.photo.url);
  }
  if (a.video) {
    out.push({ kind: 'video', name: 'Video', url: a.video.media_url_https, link: mp4(a.video) ?? a.video.media_url_https });
    if (a.video.url) strip.push(a.video.url);
  }
  if (a.animated_gif) {
    out.push({ kind: 'video', name: 'GIF', url: a.animated_gif.media_url_https, link: mp4(a.animated_gif) });
    if (a.animated_gif.url) strip.push(a.animated_gif.url);
  }
  if (a.tweet?.status) {
    const t = a.tweet.status;
    const u = t.user ?? {};
    const media = t.extended_entities?.media?.[0] ?? t.entities?.media?.[0];
    const text = String(t.full_text ?? t.text ?? '').replace(/\s+/g, ' ').trim();
    const page = `https://x.com/${u.screen_name ?? 'i'}/status/${t.id_str ?? t.id}`;
    const isVideo = media && media.type !== 'photo';
    out.push({
      kind: media ? (isVideo ? 'video' : 'image') : 'other',
      name: `Gönderi · @${u.screen_name ?? '?'}${text ? ': ' + (text.length > 90 ? text.slice(0, 89) + '…' : text) : ''}`,
      url: media?.media_url_https ?? u.profile_image_url_https?.replace('_normal.', '_bigger.'),
      link: isVideo ? (mp4(media) ?? page) : media ? media.media_url_https : page,
      page,
    });
    if (a.tweet.url) strip.push(a.tweet.url);
  }
  if (a.card) {
    const bv = a.card.binding_values ?? {};
    const title = bv.title?.string_value ?? bv.vanity_url?.string_value ?? 'Bağlantı';
    const img = bv.thumbnail_image_large?.image_value?.url ?? bv.summary_photo_image?.image_value?.url ?? bv.thumbnail_image?.image_value?.url;
    const link = bv.card_url?.string_value ?? a.card.url;
    out.push({ kind: 'other', name: title, url: img, link });
    if (a.card.url) strip.push(a.card.url);
  }
  return { attachments: out, strip };
}

function fromEntries(entries: J[], convId?: string): Msg[] {
  return entries
    .filter((e) => e.message && (!convId || e.message.conversation_id === convId))
    .map((e) => {
      const m = e.message;
      const md = m.message_data ?? {};
      const sid = String(md.sender_id ?? '');
      const { attachments, strip } = attachmentsOf(md);
      let text = String(md.text ?? '');
      for (const u of strip) text = text.replace(u, '');
      // metindeki t.co kısaltmalarını açık adresle değiştir
      for (const u of md.entities?.urls ?? []) if (u.url && u.expanded_url) text = text.replace(u.url, u.expanded_url);
      const lr = convId ? otherLastRead.get(convId) : undefined;
      const seen = sid === meId && !!lr && /^\d+$/.test(String(m.id)) && BigInt(String(m.id)) <= BigInt(lr);
      return {
        status: sid === meId ? (seen ? ('read' as const) : ('sent' as const)) : ('delivered' as const),
        id: String(m.id),
        text: text.trim(),
        ts: Number(m.time ?? md.time ?? Date.now()),
        fromMe: sid === meId,
        senderId: sid,
        senderName: users.get(sid) ?? 'X kullanıcısı',
        senderAvatarUrl: avatars.get(sid),
        attachments: attachments.length ? attachments : undefined,
      };
    });
}

const CHAT = 'https://x.com/i/chat';
const TR_MONTHS: Record<string, number> = { oca: 0, şub: 1, mar: 2, nis: 3, may: 4, haz: 5, tem: 6, ağu: 7, eyl: 8, eki: 9, kas: 10, ara: 11, jan: 0, feb: 1, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const WEEKDAYS: Record<string, number> = { pazar: 0, pazartesi: 1, salı: 2, çarşamba: 3, perşembe: 4, cuma: 5, cumartesi: 6, sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
/**
 * XChat gün ayırıcısı → mesaj zamanı (ms). Görülen biçimler: "15 Eyl Sal, 21:47", "13 Oca 2023, 3:59",
 * "Cumartesi 22:16", "Bugün 10:05", "Dün 9:44". Ayırıcıdaki saat, o gruptaki ilk mesajın saatidir.
 */
function parseDayLabel(label: string): number | undefined {
  const s = label.trim();
  const tm = s.match(/(\d{1,2}):(\d{2})$/);
  if (!tm) return undefined;
  const hm = Number(tm[1]) * 3600e3 + Number(tm[2]) * 60e3;
  const head = s.slice(0, tm.index).replace(/[,\s]+$/, '');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const lower = head.toLocaleLowerCase('tr');
  if (/^(bugün|today)$/.test(lower)) return today + hm;
  if (/^(dün|yesterday)$/.test(lower)) return today - 86400e3 + hm;
  if (WEEKDAYS[lower] !== undefined) {
    const back = (now.getDay() - WEEKDAYS[lower] + 7) % 7 || 7; // bugünse geçen hafta değil: bugün "Bugün" yazılır
    return today - back * 86400e3 + hm;
  }
  const m = head.match(/^(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]{3})\w*\.?(?:\s+(\d{4}))?/);
  if (!m) return undefined;
  const mon = TR_MONTHS[m[2].toLocaleLowerCase('tr')];
  if (mon === undefined) return undefined;
  let d = new Date(m[3] ? Number(m[3]) : now.getFullYear(), mon, Number(m[1]));
  if (!m[3] && d.getTime() > now.getTime() + 86400e3) d = new Date(now.getFullYear() - 1, mon, Number(m[1]));
  return d.getTime() + hm;
}
const DAY_LABEL = /^(?:\d{1,2}\s+\S+(?:\s+\d{4})?(?:\s+\S+)?|Bugün|Dün|Today|Yesterday|Pazartesi|Salı|Çarşamba|Perşembe|Cuma|Cumartesi|Pazar|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+\d{1,2}:\d{2}$/;
/** Twitter snowflake: id → ms ve tersi (1.1 ucunda max_id ile eski mesaj sayfalama) */
const SNOWFLAKE_EPOCH = 1288834974657n;
const snowflakeFromMs = (ms: number) => String((BigInt(Math.max(0, Math.floor(ms))) - SNOWFLAKE_EPOCH) << 22n);
/** 1.1 ucunda bulunmayan (yalnızca XChat) sohbetler */
const apiMissing = new Set<string>();
/** Önceki yoklamada görülen DOM önizlemesi (DB yoksa yedek yol): değiştiyse sohbet "yeni etkinlik" sayılır */
const domPreview = new Map<string, string>();

// ───────────────────────── Kodlayıcılar: CBOR (yerel DB içerikleri) ve Thrift (GraphQL olayları) ─────────────────────────
type CborValue = unknown;
/** Küçük CBOR çözücü: yerel veritabanındaki `contents` sütunları ([tipAdı, yük] çiftleri, sonsuz uzunluklu dizi/harita). */
function cbor(buf: Buffer): CborValue {
  let p = 0;
  const arg = (ai: number): number | bigint | undefined => {
    if (ai < 24) return ai;
    if (ai === 24) return buf[p++];
    if (ai === 25) { const v = buf.readUInt16BE(p); p += 2; return v; }
    if (ai === 26) { const v = buf.readUInt32BE(p); p += 4; return v; }
    if (ai === 27) { const v = buf.readBigUInt64BE(p); p += 8; return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v; }
    return undefined; // 31: sonsuz uzunluk
  };
  const item = (): CborValue => {
    const ib = buf[p++];
    const mt = ib >> 5;
    const ai = ib & 31;
    switch (mt) {
      case 0: return arg(ai);
      case 1: { const v = arg(ai); return typeof v === 'bigint' ? -1n - v : -1 - (v as number); }
      case 2: { const n = Number(arg(ai)); const s = buf.subarray(p, p + n); p += n; return s; }
      case 3: {
        if (ai === 31) { let s = ''; while (buf[p] !== 0xff) s += String(item()); p++; return s; }
        const n = Number(arg(ai)); const s = buf.toString('utf8', p, p + n); p += n; return s;
      }
      case 4: {
        const out: CborValue[] = [];
        if (ai === 31) { while (buf[p] !== 0xff) out.push(item()); p++; } else { const n = Number(arg(ai)); for (let i = 0; i < n; i++) out.push(item()); }
        return out;
      }
      case 5: {
        const out: Record<string, CborValue> = {};
        if (ai === 31) { while (buf[p] !== 0xff) { const k = item(); out[String(k)] = item(); } p++; } else { const n = Number(arg(ai)); for (let i = 0; i < n; i++) { const k = item(); out[String(k)] = item(); } }
        return out;
      }
      case 6: arg(ai); return item(); // etiket
      default: {
        if (ai === 20) return false;
        if (ai === 21) return true;
        if (ai === 22 || ai === 23) return null;
        if (ai === 25) { p += 2; return undefined; }
        if (ai === 26) { const v = buf.readFloatBE(p); p += 4; return v; }
        if (ai === 27) { const v = buf.readDoubleBE(p); p += 8; return v; }
        return undefined;
      }
    }
  };
  try { return item(); } catch { return undefined; }
}
/** [tipAdı, yük] biçimindeki çokbiçimli CBOR değerini ayır */
function typed(v: CborValue): { type: string; payload: J } | undefined {
  if (Array.isArray(v) && typeof v[0] === 'string' && v[1] && typeof v[1] === 'object') return { type: v[0], payload: v[1] as J };
  return undefined;
}
/** Apache Thrift ikili yapı → {alanNo: değer}; şifreli XChat olaylarının üst verisi (kimlik, gönderen, zaman) düz metindir. */
function thrift(buf: Buffer): Record<number, unknown> | undefined {
  let p = 0;
  const val = (t: number): unknown => {
    switch (t) {
      case 2: return buf[p++] !== 0;
      case 3: return buf[p++];
      case 4: { const v = buf.readDoubleBE(p); p += 8; return v; }
      case 6: { const v = buf.readInt16BE(p); p += 2; return v; }
      case 8: { const v = buf.readInt32BE(p); p += 4; return v; }
      case 10: { const v = buf.readBigInt64BE(p); p += 8; return v; }
      case 11: { const n = buf.readInt32BE(p); p += 4; const s = buf.subarray(p, p + n); p += n; const txt = s.toString('utf8'); return /^[\x20-\x7e]*$/.test(txt) ? txt : s; }
      case 12: return struct();
      case 13: { const kt = buf[p++]; const vt = buf[p++]; const n = buf.readInt32BE(p); p += 4; const m: Record<string, unknown> = {}; for (let i = 0; i < n; i++) { const k = val(kt); m[String(k)] = val(vt); } return m; }
      case 14: case 15: { const et = buf[p++]; const n = buf.readInt32BE(p); p += 4; const a: unknown[] = []; for (let i = 0; i < n; i++) a.push(val(et)); return a; }
      default: throw new Error('thrift tip ' + t);
    }
  };
  const struct = (): Record<number, unknown> => { const o: Record<number, unknown> = {}; for (;;) { const t = buf[p++]; if (t === 0 || t === undefined) return o; const id = buf.readInt16BE(p); p += 2; o[id] = val(t); } };
  try { return struct(); } catch { return undefined; }
}

// ───────────────────────── XChat üst verisi: sayfanın kendi GraphQL yanıtlarından ─────────────────────────
/** mesaj uuid → {sıra no, zaman, gönderen}: şifreli olayların düz üst verisi (eski mesajlar kaydırınca gelir) */
const meta = new Map<string, { seq: string; ts: number; sender: string }>();
const hooked = new WeakSet<Page>();
function hookMeta(page: Page): void {
  if (hooked.has(page)) return;
  hooked.add(page);
  page.on('response', (r) => {
    if (!/\/graphql\/[^/]+\/(GetConversationPageQuery|GetInitialXChatPageQuery)/.test(r.url())) return;
    void r
      .json()
      .then((j: J) => {
        const evs: unknown[] = j?.data?.get_conversation_page?.encoded_message_events ?? j?.data?.get_initial_chat_page?.encoded_message_events ?? [];
        for (const e of evs) {
          if (typeof e !== 'string') continue;
          const o = thrift(Buffer.from(e, 'base64'));
          if (!o || typeof o[2] !== 'string' || typeof o[6] !== 'string') continue;
          meta.set(String(o[2]).toLowerCase(), { seq: String(o[1] ?? ''), ts: Number(o[6]), sender: String(o[3] ?? '') });
          if (meta.size > 20_000) for (const k of [...meta.keys()].slice(0, 5_000)) meta.delete(k); // sınırsız büyümesin
        }
      })
      .catch(() => undefined);
  });
}

// ───────────────────────── Yerel XChat veritabanı (OPFS backups/chat_<kimlik>.db) ─────────────────────────
let snap: { db: Database.Database; at: number; mtime: number; file: string; me: string } | undefined;
/**
 * OPFS'teki yedek DB dosyasını sayfa bağlamından okuyup (base64) geçici dosyaya yazar ve salt okunur açar.
 * Profilde birden çok hesabın yedeği olabilir (chat_<kimlik>.db): kendi kimliğimizinki tercih edilir.
 * Yedek son okumadan beri değişmediyse (lastModified aynı) yeniden aktarılmaz.
 */
async function readSnapshot(page: Page): Promise<boolean> {
  const r = await page
    .evaluate(async ({ me, since }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('backups').catch(() => undefined);
      if (!dir) return undefined;
      const files: Array<{ name: string; h: FileSystemFileHandle }> = [];
      for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }).entries()) if (name.endsWith('.db') && h.kind === 'file') files.push({ name, h });
      const pick = files.find((f) => me && f.name.includes(me)) ?? files[0];
      if (!pick) return undefined;
      const f = await pick.h.getFile();
      if (since && f.lastModified <= since) return { name: pick.name, b64: '', lastModified: f.lastModified };
      const buf = new Uint8Array(await f.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + 0x8000)));
      return { name: pick.name, b64: btoa(s), lastModified: f.lastModified };
    }, { me: meId, since: snap && snap.me === meId ? snap.mtime : 0 })
    .catch(() => undefined);
  if (!r) return false;
  if (!r.b64 && snap) {
    snap.at = Date.now(); // değişmemiş: eldeki anlık görüntü geçerli
    return true;
  }
  if (!r.b64) return false;
  // süreç başına ayrı dosya: aynı hesabı açan ikinci çekirdek (geliştirme + paketli uygulama) açık DB'nin altından dosyayı değiştirmesin
  const file = path.join(os.tmpdir(), `kavsak-xchat-${meId || 'x'}-${process.pid}.db`);
  cleanStaleSnapshots();
  snap?.db.close();
  snap = undefined;
  fs.writeFileSync(file, Buffer.from(r.b64, 'base64'), { mode: 0o600 }); // çözülmüş DM kopyası yalnızca bu kullanıcıya okunur
  try {
    snap = { db: new Database(file, { readonly: true, fileMustExist: true }), at: Date.now(), mtime: r.lastModified, file, me: meId };
    // sağlamlık: yedek yazılırken kopyalandıysa açılır ama sorgu patlar; burada yakala
    snap.db.prepare('select count(*) n from dm_conversation').get();
    return true;
  } catch (e) {
    snap?.db.close();
    snap = undefined;
    bus.log('warn', `X yerel veritabanı okunamadı: ${(e as Error).message}`);
    return false;
  }
}
/** Kapanmış süreçlerden kalan anlık görüntü dosyalarını sil (süreç başına bir kez) */
let cleaned = false;
function cleanStaleSnapshots(): void {
  if (cleaned) return;
  cleaned = true;
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      const m = f.match(/^kavsak-xchat-.+?(?:-(\d+))?\.db$/);
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid === process.pid) continue;
      let alive = false;
      if (pid) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          /* süreç yok */
        }
      }
      if (!alive) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
    }
  } catch {
    /* geçici dizin okunamadı */
  }
}
/** OPFS yedeğinin son değişme zamanı (ms) — eşitleme sonrası yedek yazılana dek beklemek için */
async function backupModified(page: Page): Promise<number> {
  return page
    .evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('backups').catch(() => undefined);
      if (!dir) return 0;
      let max = 0;
      for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }).entries()) if (name.endsWith('.db')) max = Math.max(max, (await h.getFile()).lastModified);
      return max;
    })
    .catch(() => 0);
}
/**
 * /i/chat'i (yeniden) yükle: istemci GetInitialXChatPageQuery ile yeni olayları çekip yerel DB'ye işler ve yedeği yazar.
 * Yeni olay geldiyse yedek güncellenene dek (en çok 5 sn) bekle, sonra anlık görüntüyü al.
 */
async function syncAndSnapshot(page: Page): Promise<boolean> {
  hookMeta(page);
  const t0 = Date.now();
  const synced = page.waitForResponse((r) => /GetInitialXChatPageQuery/.test(r.url()), { timeout: 10_000 }).catch(() => undefined);
  await page.goto(CHAT, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  const r = await synced;
  let fresh = false;
  try {
    const j: J | undefined = await r?.json();
    fresh = (j?.data?.get_initial_chat_page?.encoded_message_events?.length ?? 0) > 0;
  } catch {
    /* yanıt okunamadı */
  }
  if (fresh) for (let i = 0; i < 16 && (await backupModified(page)) < t0; i++) await page.waitForTimeout(300);
  else if (!snap) await page.waitForTimeout(1200); // ilk açılış: yedek henüz yazılmamış olabilir
  return readSnapshot(page);
}
async function ensureSnapshot(page: Page): Promise<boolean> {
  if (snap && snap.me === meId && Date.now() - snap.at < 5 * 60e3) return true;
  return freshSnapshot(page);
}

/**
 * Ban önleme: /i/chat'i her yoklamada baştan yüklemek (günde binlerce tam sayfa yükü) insan dışı bir desen.
 * Sayfa açık kalır; XChat istemcisi yeni mesajı kendisi alır ve listeyi günceller. Tam yeniden yükleme yalnızca
 * (a) görünen sohbet listesi değiştiyse, (b) 6–9 dk'lık (rastgele) süre dolduysa ya da (c) sayfa /i/chat'te değilse.
 * Aradaki turlarda yalnız yerel yedek okunur (ağ isteği yok).
 */
let nextReloadAt = 0;
let lastListSig = '';
async function listSignature(page: Page): Promise<string> {
  if (!page.url().startsWith(CHAT)) return '';
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="dm-conversation-item-"]'))
        .slice(0, 25)
        .map((el) => {
          // göreli zaman ("5 dk", "2h", "şimdi") her dakika değişir: imzaya katılmaz
          const lines = el.innerText.split('\n').map((t) => t.trim()).filter((t) => t && !/^(\d+\s*(sn|dk|sa|g|ha|ay|y|s|m|h|d|w|mo)|şimdi|now)$/i.test(t));
          return `${el.getAttribute('data-testid')}|${lines.join(' ').slice(0, 200)}|${el.getAttribute('aria-description') ?? ''}`;
        })
        .join('\n'),
    )
    .catch(() => '');
}
async function freshSnapshot(page: Page): Promise<boolean> {
  const sig = await listSignature(page);
  const due = !snap || snap.me !== meId || !sig || sig !== lastListSig || Date.now() >= nextReloadAt;
  if (!due) {
    const ok = await readSnapshot(page); // sayfanın yazdığı yedek değiştiyse aktarılır, değilse eldeki geçerli
    if (ok) return true;
  }
  const ok = await syncAndSnapshot(page);
  nextReloadAt = Date.now() + (6 + Math.random() * 3) * 60e3;
  lastListSig = await listSignature(page);
  return ok;
}

/** dm_user.contents (CBOR {user:{…}}) → ad/kullanıcı adı/avatar haritaları */
function loadUsers(db: Database.Database): void {
  for (const row of db.prepare('select cast(id as text) id, screen_name, nickname, contents from dm_user').all() as Array<{ id: string; screen_name: string; nickname: string | null; contents: Buffer | null }>) {
    const u = (row.contents && (cbor(row.contents) as J)?.user) as J | undefined;
    const name = row.nickname || u?.name || (row.screen_name ? '@' + row.screen_name : row.id);
    users.set(row.id, String(name));
    const sn = u?.screenName ?? row.screen_name;
    if (sn) handles.set(row.id, '@' + sn);
    if (u?.profileImageUrl) avatars.set(row.id, String(u.profileImageUrl).replace('_normal.', '_bigger.'));
  }
}
const convOf = (threadId: string) => (threadId.startsWith('g') ? threadId : threadId.replace('-', ':'));
const threadOf = (conv: string) => conv.replace(':', '-');
/** ton.x.com/pbs.twimg.com adresleri arayüzden doğrudan açılamaz (çerez ister); vekil bunları köprü üzerinden indirir */
const TON = /^https?:\/\/ton\.(x|twitter)\.com\//;
const pickVariant = (variants: J[] | undefined): string | undefined => {
  const vs = (variants ?? []).filter((v) => v.contentType === 'video/mp4' && v.url);
  vs.sort((a, b) => (a.bitRate ?? 0) - (b.bitRate ?? 0));
  return vs[Math.min(1, vs.length - 1)]?.url ?? vs[0]?.url;
};
/** Paylaşılan gönderi (dm_post_cache) → ek */
function postAttachment(db: Database.Database, postId: string, pageUrl?: string): Attachment {
  const page = pageUrl || `https://x.com/i/status/${postId}`;
  let j: J | undefined;
  try {
    const row = db.prepare('select post_json from dm_post_cache where id = ?').get(BigInt(postId)) as { post_json: string } | undefined;
    j = row ? JSON.parse(row.post_json) : undefined;
  } catch {
    /* önbellekte yok */
  }
  const cp: J | undefined = j?.canonicalPost ?? j;
  if (!cp?.author) return { kind: 'other', name: 'Gönderi', link: page, page };
  const media: J | undefined = cp.media?.[0];
  const isVideo = media && /Video|Gif/i.test(String(media.type ?? ''));
  const text = String(cp.text ?? '').replace(/\s+/g, ' ').trim();
  return {
    kind: media ? (isVideo ? 'video' : 'image') : 'other',
    name: `Gönderi · @${cp.author.screenName ?? '?'}${text ? ': ' + (text.length > 90 ? text.slice(0, 89) + '…' : text) : ''}`,
    url: isVideo ? media.previewImage?.imageUrl : (media?.imageUrl ?? (String(cp.author.profileImageUrl ?? '').replace('_normal.', '_bigger.') || undefined)),
    link: isVideo ? (pickVariant(media.variants) ?? page) : media?.imageUrl ?? page,
    page,
  };
}
/** dm_entry.contents → ekler (gönderi paylaşımı, sunucudaki eski medya, şifreli XChat medyası) */
function entryAttachments(db: Database.Database, conv: string, contents: Buffer | null): { attachments: Attachment[]; text: string } {
  const out: Attachment[] = [];
  const top = contents ? typed(cbor(contents)) : undefined;
  if (!top) return { attachments: out, text: '' };
  for (const raw of (top.payload.attachments as CborValue[] | undefined) ?? []) {
    const a = typed(raw);
    if (!a) continue;
    const p = a.payload;
    if (/\.Post$/.test(a.type)) {
      const pid = p.postId?.value ?? p.postId;
      const pageUrl = typeof p.url === 'string' ? p.url : undefined;
      if (!/^\d+$/.test(String(pid ?? '')) && !pageUrl) continue; // ne kimlik ne bağlantı: gösterilecek bir şey yok
      out.push(postAttachment(db, /^\d+$/.test(String(pid ?? '')) ? String(pid) : '', pageUrl));
    } else if (/Media/.test(a.type)) {
      const hint = `${p.type ?? ''} ${p.mimeType ?? ''}`;
      const kind: Attachment['kind'] = /video|gif/i.test(hint) ? 'video' : /audio/i.test(hint) ? 'audio' : 'image';
      const full: string | undefined = typeof p.legacyMediaUrl === 'string' ? p.legacyMediaUrl : typeof p.mediaUrl === 'string' ? p.mediaUrl : undefined;
      const preview: string | undefined = typeof p.legacyPreviewUrl === 'string' ? p.legacyPreviewUrl : full;
      const attId = p.attachmentId?.id ?? p.attachmentId;
      // Şifreli XChat medyası: istemci çözülmüş dosyayı OPFS'e yazar; "xc:<sohbet>/<ek>" şeması fetchMedia ile okunur
      const local = typeof attId === 'string' && !full ? `xc:${threadOf(conv)}/${attId}` : undefined;
      // ton.x.com: köprü yalnızca url'yi vekile çevirir, link ham kalır ve arayüz görselde ham link'i kullanırdı → görselde link verilmez
      const link = kind === 'image' && full && TON.test(full) ? undefined : (full ?? local);
      out.push({ kind, name: kind === 'video' ? 'Video' : kind === 'audio' ? 'Ses' : 'Fotoğraf', mime: typeof p.mimeType === 'string' ? p.mimeType : undefined, size: typeof p.fileSize === 'number' ? p.fileSize : undefined, url: preview ?? local, link });
    } else if (typeof p.url === 'string') {
      out.push({ kind: 'other', name: a.type.split('.').pop() ?? 'Bağlantı', link: p.url });
    }
  }
  return { attachments: out, text: typeof top.payload.text === 'string' ? top.payload.text : '' };
}
interface EntryRow {
  entry_id: string;
  seq: string;
  timestamp: number;
  sender_id: string;
  sender_is_owner: number;
  plain_text: string | null;
  contents: Buffer | null;
}
/** Yerel DB'den bir sohbetin mesajları (en yeni `limit`; `before` verilirse ondan eskiler) */
function dbMessages(db: Database.Database, conv: string, limit: number, before?: number): Msg[] {
  const rows = db
    .prepare(
      `select entry_id, cast(sequence_number as text) seq, timestamp, cast(sender_id as text) sender_id, sender_is_owner, plain_text, contents
       from dm_entry where conversation_id = ? and entry_type = 'message' and (? is null or timestamp < ?) order by timestamp desc limit ?`,
    )
    .all(conv, before ?? null, before ?? null, limit) as EntryRow[];
  return rows.reverse().map((r) => {
    const { attachments, text } = entryAttachments(db, conv, r.contents);
    const fromMe = r.sender_is_owner === 1 || r.sender_id === meId;
    return {
      id: r.seq || 'xc-' + r.entry_id.toLowerCase(),
      text: (text || r.plain_text || '').trim(), // plain_text arama için küçük harfe indirilmiş; özgün metin contents'te
      ts: Number(r.timestamp),
      fromMe,
      senderId: r.sender_id,
      senderName: fromMe ? 'Ben' : (users.get(r.sender_id) ?? 'X kullanıcısı'),
      senderAvatarUrl: fromMe ? undefined : avatars.get(r.sender_id),
      attachments: attachments.length ? attachments : undefined,
    };
  });
}
interface ConvRow {
  id: string;
  custom_title: string | null;
  custom_avatar_url: string | null;
  lastTs: number | null;
  lastAt: number | null;
  lastIn: number | null;
  unread: number;
  marked_unread_by_me: number;
  preview_text: string | null;
  preview_contents: Buffer | null;
  preview_owner: number | null;
}
/** Yerel DB → sohbet listesi (okunmamış = okundu işaretinden sonraki gelen mesaj sayısı, istemcinin kendi kuralı) */
/**
 * Mivelo'dan okundu işaretlenen sohbetler: konuşma kimliği → işaret anı (ms). Yerel yedek DB (backups/) okundu olayını
 * geç yazıyor (sayfada okundu görünse de yedekte last_read_sequence_number eski kalıyor), bu yüzden işaretten önceki
 * gelen mesajlar okunmuş sayılır. Profilin x.com localStorage'ında saklanır (çekirdek yeniden başlasa da geçerli).
 */
const readMarks = new Map<string, number>();
const READ_KEY = 'kavsak:xchat-read';
async function loadReadMarks(page: Page): Promise<void> {
  const raw = await page.evaluate((k) => localStorage.getItem(k), READ_KEY).catch(() => null);
  if (!raw) return;
  try {
    for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, number>)) if (!readMarks.has(k) || readMarks.get(k)! < v) readMarks.set(k, Number(v));
  } catch {
    /* bozuk kayıt */
  }
}
async function saveReadMarks(page: Page): Promise<void> {
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [READ_KEY, JSON.stringify(Object.fromEntries(readMarks))] as const).catch(() => undefined);
}

/** Yedekteki okunmamış sayısını Mivelo'nun okundu işaretiyle düzelt (işaretten sonra gelen mesaj yoksa 0) */
export function applyReadMark(unread: number, lastIncomingTs: number | null, markedAt: number | undefined): number {
  if (!unread || markedAt === undefined) return unread;
  return lastIncomingTs !== null && lastIncomingTs > markedAt ? unread : 0;
}

function dbThreads(db: Database.Database): Thread[] {
  loadUsers(db);
  const rows = db
    .prepare(
      `select c.conversation_id id, c.custom_title, c.custom_avatar_url, c.marked_unread_by_me, c.last_received_message_at_msec lastAt,
         (select max(timestamp) from dm_entry e where e.conversation_id = c.conversation_id and e.affects_sort_order = 1) lastTs,
         (select max(timestamp) from dm_entry e where e.conversation_id = c.conversation_id and e.affects_read_state = 1 and e.sender_is_owner = 0) lastIn,
         (select count(*) from dm_entry e where e.conversation_id = c.conversation_id and e.affects_read_state = 1 and e.sender_is_owner = 0
            and (c.last_read_sequence_number is null or e.sequence_number > c.last_read_sequence_number)) unread,
         (select plain_text from dm_entry e where e.conversation_id = c.conversation_id and e.entry_type = 'message' order by timestamp desc limit 1) preview_text,
         (select contents from dm_entry e where e.conversation_id = c.conversation_id and e.entry_type = 'message' order by timestamp desc limit 1) preview_contents,
         (select sender_is_owner from dm_entry e where e.conversation_id = c.conversation_id and e.entry_type = 'message' order by timestamp desc limit 1) preview_owner
       from dm_conversation c where c.deleted = 0`,
    )
    .all() as ConvRow[];
  const members = new Map<string, string[]>();
  for (const m of db.prepare('select conversation_id, cast(user_id as text) uid from dm_group_participant where is_current_member = 1').all() as Array<{ conversation_id: string; uid: string }>) {
    members.set(m.conversation_id, [...(members.get(m.conversation_id) ?? []), m.uid]);
  }
  const out: Thread[] = [];
  for (const c of rows) {
    const group = c.id.startsWith('g');
    const ids = group ? (members.get(c.id) ?? []) : c.id.split(':');
    const others = ids.filter((u) => u !== meId);
    const participants: Participant[] = ids.map((u) => ({ id: u, name: users.get(u) ?? u, handle: handles.get(u), avatarUrl: avatars.get(u) }));
    let preview = '';
    if (c.preview_contents) {
      const { attachments, text } = entryAttachments(db, c.id, c.preview_contents);
      preview = text.trim() || (attachments[0] ? `[${attachments[0].name ?? attachments[0].kind}]` : '');
    }
    preview ||= (c.preview_text ?? '').trim();
    if (preview && c.preview_owner === 1) preview = 'Sen: ' + preview;
    let unread = c.marked_unread_by_me ? Math.max(1, Number(c.unread)) : Number(c.unread);
    if (!c.marked_unread_by_me) {
      unread = applyReadMark(unread, c.lastIn === null ? null : Number(c.lastIn), readMarks.get(c.id));
      if (Number(c.unread) === 0) readMarks.delete(c.id); // yedek yetişti: işarete gerek yok
    }
    // özel grup avatarı ton.x.com'da (çerez ister, arayüz doğrudan açamaz) → verilmez
    const avatar = group ? (c.custom_avatar_url && !/ton\.(x|twitter)\.com/.test(c.custom_avatar_url) ? c.custom_avatar_url : undefined) : avatars.get(others[0]);
    // kendine mesaj (550911115:550911115): X "Sen"/kendi adını gösterir
    const self = !group && others.length === 0;
    out.push({
      id: threadOf(c.id),
      name: group ? c.custom_title || groupName(others) || 'Grup' : self ? (users.get(meId) ?? 'Kendine notlar') : (users.get(others[0]) ?? handles.get(others[0]) ?? others[0] ?? 'Sohbet'),
      kind: group ? 'group' : 'direct',
      lastTs: Number(c.lastTs ?? c.lastAt ?? 0),
      preview,
      unread,
      avatarUrl: avatar,
      handle: group ? undefined : handles.get(others[0]),
      link: group ? undefined : handles.get(others[0]) ? `https://x.com/${handles.get(others[0])!.slice(1)}` : undefined,
      participants,
    });
  }
  return out;
}

// ───────────────────────── /i/chat DOM'u: DB yoksa yedek; DB'de olmayan eski XChat mesajları için kaydırarak okuma ─────────────────────────
async function domInbox(page: Page): Promise<Array<{ id: string; name: string; preview: string; unread: boolean }>> {
  if (!page.url().startsWith(CHAT)) await page.goto(CHAT, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  await page.waitForSelector('[data-testid^="dm-conversation-item-"]', { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const out: Array<{ id: string; name: string; preview: string; unread: boolean }> = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="dm-conversation-item-"]'))) {
      const id = el.getAttribute('data-testid')!.slice('dm-conversation-item-'.length).replace(':', '-');
      const lines = el.innerText.split('\n').map((t) => t.trim()).filter(Boolean);
      if (!lines.length) continue;
      const relIdx = lines.findIndex((t, i) => i > 0 && /^\d+\s*(dk|sa|g|ha|ay|y|m|h|d|w|mo)$/i.test(t));
      const preview = lines.slice(relIdx > 0 ? relIdx + 1 : 1).join(' ').replace(/^(You|Sen):\s*/, '');
      // okunmamış: önizleme kalın ya da isim yanında mavi nokta
      const leafs = Array.from(el.querySelectorAll<HTMLElement>('*')).filter((e) => e.children.length === 0);
      const bold = leafs.some((e) => e.innerText?.trim() === preview.slice(0, 20) && Number(getComputedStyle(e).fontWeight) >= 700);
      const dot = leafs.some((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.width <= 12 && r.height <= 12 && /rgb\(29, 155, 240\)|rgb\(30, 156, 241\)/.test(getComputedStyle(e).backgroundColor); });
      out.push({ id, name: lines[0], preview, unread: bold || dot || /okunmamış|unread/i.test(el.getAttribute('aria-description') ?? '') });
    }
    return out;
  });
}
/**
 * /i/chat listesinde o an çizili sohbetlerin okunmamış işareti (erişilebilirlik açıklaması "…, Okunmamış").
 * Yedek DB başka cihazda okunan sohbetleri geç güncelliyor; görünen (en yeni) sohbetlerde sayfanın canlı durumu yetkili.
 */
async function domUnreadFlags(page: Page): Promise<Map<string, boolean>> {
  if (!page.url().startsWith(CHAT)) return new Map();
  await page.waitForSelector('[data-testid^="dm-conversation-item-"]', { timeout: 3_000 }).catch(() => undefined);
  const rows = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="dm-conversation-item-"]')).map((el) => ({
        id: el.getAttribute('data-testid')!.slice('dm-conversation-item-'.length).replace(':', '-'),
        desc: el.getAttribute('aria-description') ?? '',
      })),
    )
    .catch(() => [] as Array<{ id: string; desc: string }>);
  // açıklama hiç yoksa (arayüz değişti) işaret okunamaz: hiçbirine dokunma
  if (!rows.some((r) => r.desc)) return new Map();
  return new Map(rows.map((r) => [r.id, /okunmamış|unread/i.test(r.desc)]));
}

interface DomRow {
  id: string;
  text: string;
  time: string;
  day: string;
  me: boolean;
  sender: string;
  top: number;
  images: string[];
  videos: string[];
  post?: { href: string; author: string; text: string; image?: string; video?: string };
}
/** Sayfada o an çizili mesajlar (liste sanal: yalnızca görünür pencere). */
async function domRows(page: Page): Promise<{ rows: DomRow[]; scrollTop: number; atTop: boolean } | undefined> {
  return page.evaluate((DAY) => {
    const sc = document.querySelector<HTMLElement>('[data-testid="dm-message-scroller"]') ?? document.querySelector<HTMLElement>('[data-testid="dm-message-list"]');
    if (!sc) return undefined;
    const dayRe = new RegExp(DAY);
    const pr = sc.getBoundingClientRect();
    const mid = pr.left + pr.width / 2;
    const seps: Array<{ top: number; label: string }> = [];
    let atTop = sc.scrollTop < 4;
    for (const e of Array.from(sc.querySelectorAll<HTMLElement>('div, span'))) {
      if (e.children.length) continue;
      const t = (e.textContent ?? '').trim();
      if (!t) continue;
      if (dayRe.test(t) && !e.closest('[data-testid^="message-"]')) seps.push({ top: e.getBoundingClientRect().top, label: t });
      else if (/^(Profili Görüntüle|View profile|tarihinde katıldı|Joined )/.test(t) || /(katıldı|Joined)\b/.test(t)) atTop = true; // en üstte profil kartı: geçmişin başı
    }
    seps.sort((a, b) => a.top - b.top);
    const rows: DomRow[] = [];
    for (const el of Array.from(sc.querySelectorAll<HTMLElement>('[data-testid^="message-"]'))) {
      const tid = el.getAttribute('data-testid') ?? '';
      if (tid.startsWith('message-text-') || tid.startsWith('message-list')) continue;
      const id = tid.slice('message-'.length);
      if (!/^[0-9a-f-]{20,}$/i.test(id)) continue;
      const r = el.getBoundingClientRect();
      const textEl = el.querySelector<HTMLElement>('[data-testid^="message-text-"]');
      const lines = (textEl?.innerText ?? '').split('\n').map((t) => t.trim()).filter(Boolean);
      const time = [...lines].reverse().find((t) => /^\d{1,2}:\d{2}$/.test(t)) ?? '';
      const text = lines.filter((t) => !/^\d{1,2}:\d{2}$/.test(t) && !/^(Görüldü|Seen|Gönderildi|Sent|Yeni|New|Düzenlendi|Edited)$/i.test(t)).join('\n');
      const bubble = textEl ?? el.querySelector<HTMLElement>('a[href], video, img:not([src*="profile_images"])') ?? el;
      const br = bubble.getBoundingClientRect();
      const me = br.left + br.width / 2 > mid;
      // grupta gönderen adı: mesaj öğesinden önce, aynı satır sarmalayıcısındaki kısa metin
      let sender = '';
      const wrap = el.parentElement?.parentElement;
      if (wrap) {
        for (const e of Array.from(wrap.querySelectorAll<HTMLElement>('*'))) {
          if (el.contains(e) || e === el) break;
          if (e.children.length) continue;
          const t = (e.textContent ?? '').trim();
          if (t && t !== '.' && t.length < 40 && !dayRe.test(t) && !/^\d{1,2}:\d{2}$/.test(t)) sender = t;
        }
      }
      const images = Array.from(el.querySelectorAll<HTMLImageElement>('img')).map((i) => i.currentSrc || i.src).filter((s) => /pbs\.twimg\.com\/media|ton\.(x|twitter)\.com/.test(s));
      const videos = Array.from(el.querySelectorAll<HTMLVideoElement | HTMLSourceElement>('video, video source')).map((v) => v.src).filter((s) => /^https?:/.test(s));
      let post: DomRow['post'];
      const card = el.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
      if (card) {
        const cl = card.innerText.split('\n').map((t) => t.trim()).filter(Boolean);
        post = { href: card.href, author: cl[0] ?? '', text: cl.slice(2).join(' '), image: card.querySelector<HTMLImageElement>('img:not([src*="profile_images"])')?.src, video: card.querySelector<HTMLVideoElement>('video')?.src || card.querySelector<HTMLSourceElement>('video source')?.src };
      }
      let day = '';
      for (const s of seps) if (s.top <= r.top + 2) day = s.label;
      rows.push({ id, text, time, day, me, sender, top: r.top, images, videos, post });
    }
    return { rows, scrollTop: sc.scrollTop, atTop };
  }, DAY_LABEL.source);
}
/** DOM satırları → Msg (zaman: GraphQL üst verisi > gün ayırıcısı + mesaj saati > önceki mesaj) */
function domToMsgs(threadId: string, rows: DomRow[], fallbackTs: number): Msg[] {
  const others = threadId.startsWith('g') ? [] : threadId.split('-').filter((p) => p !== meId);
  // yerel DB'de olan satırlar: kimlik (sıra no) ve kesin zaman oradan
  const known = new Map<string, { seq: string; ts: number; sender: string }>();
  if (snap) {
    try {
      for (const r of snap.db.prepare('select lower(entry_id) e, cast(sequence_number as text) s, timestamp t, cast(sender_id as text) u from dm_entry where conversation_id = ?').all(convOf(threadId)) as Array<{ e: string; s: string; t: number; u: string }>) known.set(r.e, { seq: r.s, ts: Number(r.t), sender: r.u });
    } catch {
      /* anlık görüntü kapanmış olabilir */
    }
  }
  rows.sort((a, b) => a.top - b.top);
  // 1) kesin zamanlar (üst veri / DB / gün ayırıcısı + saat); 2) bilinmeyenler: bir sonraki bilinen satırdan geriye
  //    (görünür pencerenin üstündeki satırların gün ayırıcısı kaydırılmış olabilir); hiç yoksa fallbackTs'ten geriye.
  const metas = rows.map((r) => known.get(r.id.toLowerCase()) ?? meta.get(r.id.toLowerCase()));
  const tss: Array<number | undefined> = rows.map((r, i) => {
    const m = metas[i];
    if (m) return m.ts;
    const dayTs = parseDayLabel(r.day);
    if (dayTs === undefined) return undefined;
    const tm = r.time.match(/(\d{1,2}):(\d{2})/);
    const day0 = new Date(dayTs);
    day0.setHours(0, 0, 0, 0);
    return tm ? day0.getTime() + Number(tm[1]) * 3600e3 + Number(tm[2]) * 60e3 : dayTs;
  });
  let next: number | undefined;
  for (let i = tss.length - 1; i >= 0; i--) {
    if (tss[i] === undefined) tss[i] = next !== undefined ? next - 1 : fallbackTs - (tss.length - 1 - i);
    next = tss[i];
  }
  let cur = 0;
  const out: Msg[] = [];
  rows.forEach((r, i) => {
    const key = r.id.toLowerCase();
    const m = metas[i];
    const ts = m ? m.ts : Math.max(tss[i]!, cur ? cur + 1 : 0); // kesin zaman korunur; tahminler sırayı bozmasın
    cur = Math.max(cur, ts);
    const fromMe = m ? m.sender === meId : r.me;
    const senderId = m?.sender || (fromMe ? meId : others[0] ?? (r.sender ? 'name:' + r.sender : threadId));
    const senderName = fromMe ? 'Ben' : (users.get(senderId) ?? r.sender ?? 'X kullanıcısı');
    const attachments: Attachment[] = [];
    if (r.post) {
      const isVideo = !!r.post.video;
      attachments.push({ kind: isVideo ? 'video' : r.post.image ? 'image' : 'other', name: `Gönderi · ${r.post.author}${r.post.text ? ': ' + r.post.text.slice(0, 90) : ''}`, url: r.post.image, link: isVideo ? r.post.video : r.post.image ?? r.post.href, page: r.post.href });
    }
    // ton.x.com bağlantıları köprüde vekile çevrilmez (yalnızca url çevrilir); arayüz ham link'i <img>'e verirdi → link yok
    for (const u of r.images) if (!r.post?.image || u !== r.post.image) attachments.push({ kind: 'image', name: 'Fotoğraf', url: u, link: TON.test(u) ? undefined : u });
    for (const u of r.videos) if (!r.post?.video || u !== r.post.video) attachments.push({ kind: 'video', name: 'Video', link: u });
    out.push({ id: m?.seq || 'xc-' + key, text: r.text, ts, fromMe, senderId, senderName, senderAvatarUrl: fromMe ? undefined : avatars.get(senderId), attachments: attachments.length ? attachments : undefined });
  });
  return out;
}
/**
 * Sohbet sayfasını aç ve `need` kadar, `before`'dan eski mesaj toplanana (ya da geçmişin başına gelinene) dek
 * yukarı kaydır. Liste sanal olduğundan her adımda görünen satırlar biriktirilir; eski sayfalar istemcinin
 * GetConversationPageQuery çağrısıyla gelir, zaman/gönderen üst verisi hookMeta ile yakalanır.
 */
async function domMessages(page: Page, threadId: string, need: number, before?: number, fallbackTs = Date.now()): Promise<Msg[]> {
  hookMeta(page);
  const url = `${CHAT}/${threadId}`;
  if (page.url().startsWith(url)) await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  else await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  await page.waitForSelector('[data-testid="dm-message-scroller"] [data-testid^="message-"]', { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  const acc = new Map<string, DomRow>();
  let box: { x: number; y: number } | undefined;
  let stale = 0;
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) {
    const r = await domRows(page);
    if (!r) break;
    const beforeN = acc.size;
    for (const row of r.rows) acc.set(row.id, { ...row, top: row.top - r.scrollTop });
    if (before === undefined) break; // yalnızca görünenler (son mesajlar)
    const have = domToMsgs(threadId, [...acc.values()], fallbackTs).filter((m) => m.ts < before).length;
    if (have >= need || r.atTop) break;
    stale = acc.size === beforeN ? stale + 1 : 0;
    if (stale >= 4) break; // kaydırdık, yeni satır gelmedi: geçmişin başı
    if (Date.now() - t0 > 12_000) break; // süre sınırı: köprünün mesaj zaman aşımına yaklaşmasın; kalanı sonraki istekte
    if (!box) box = await page.evaluate(() => { const el = document.querySelector('[data-testid="dm-message-scroller"]')!.getBoundingClientRect(); return { x: el.left + el.width / 2, y: el.top + el.height / 2 }; });
    await page.mouse.move(box.x, box.y);
    await page.mouse.wheel(0, -4000);
    await page.waitForTimeout(650);
  }
  if (before !== undefined) await page.waitForTimeout(400); // son GraphQL yanıtı (üst veri) gelsin
  return domToMsgs(threadId, [...acc.values()], fallbackTs);
}

/** 1.1 gelen kutusu Kasım 2025'ten beri donuk: süreç başına bir kez okunur */
let legacyThreads: Thread[] | undefined;
let legacyMe = '';
const LEGACY_Q = 'include_ext_alt_text=false&include_reply_count=1&tweet_mode=extended&dm_secret_conversations_enabled=false';
/**
 * 1.1 gelen kutusu zaman çizelgesi (trusted) sayfalama zinciri: [0] = inbox_initial_state'in min_entry_id'si,
 * [k] = k. inbox_timeline sayfasının min_entry_id'si; '' = AT_END (daha eski sohbet yok).
 */
const timelineCursors: string[] = [];
function rememberTimeline(k: number, tl: J | undefined): void {
  timelineCursors.length = k;
  timelineCursors[k] = tl && tl.status !== 'AT_END' && tl.min_entry_id ? String(tl.min_entry_id) : '';
}
async function legacyInbox(page: Page, cookies: Record<string, string>): Promise<Thread[]> {
  if (legacyThreads) return legacyThreads;
  const data = await xapi(page, cookies, `/1.1/dm/inbox_initial_state.json?${LEGACY_Q}`);
  const state = data.inbox_initial_state ?? {};
  rememberTimeline(0, state.inbox_timelines?.trusted ?? state.inbox_timeline);
  legacyThreads = legacyThreadsOf(state);
  return legacyThreads;
}

/** inbox_initial_state / inbox_timeline yanıtındaki sohbetler → Thread (donuk arşiv: okunmamış 0) */
export function legacyThreadsOf(state: J): Thread[] {
  collectUsers(state);
  const lastByConv = new Map<string, J>();
  for (const e of state.entries ?? []) if (e.message) lastByConv.set(e.message.conversation_id, e.message);
  const out: Thread[] = [];
  for (const [id, c] of Object.entries(state.conversations ?? {}) as Array<[string, J]>) {
    const others = (c.participants ?? []).map((p: J) => String(p.user_id)).filter((u: string) => u !== meId);
    // görüldü: karşı tarafların son okuduğu olay kimliği (snowflake, artan) → messages() bununla karşılaştırır
    const lastReadOthers = (c.participants ?? []).filter((p: J) => String(p.user_id) !== meId).map((p: J) => String(p.last_read_event_id ?? '')).filter(Boolean).sort((a: string, b: string) => (BigInt(a) < BigInt(b) ? 1 : -1))[0];
    if (lastReadOthers) otherLastRead.set(id, lastReadOthers);
    const last = lastByConv.get(id);
    const participants = (c.participants ?? []).map((p: J) => ({ id: String(p.user_id), name: users.get(String(p.user_id)) ?? String(p.user_id), handle: handles.get(String(p.user_id)), avatarUrl: avatars.get(String(p.user_id)) }));
    out.push({
      id,
      handle: c.type === 'GROUP_DM' ? undefined : handles.get(others[0]),
      link: c.type === 'GROUP_DM' ? undefined : handles.get(others[0]) ? `https://x.com/${handles.get(others[0])!.slice(1)}` : undefined,
      participants,
      name: c.name || groupName(others) || (c.type !== 'GROUP_DM' ? (users.get(meId) ?? 'Kendine notlar') : 'Sohbet'),
      kind: c.type === 'GROUP_DM' ? 'group' : 'direct',
      lastTs: Number(c.sort_timestamp ?? last?.time ?? 0),
      preview: last?.message_data?.text ?? '',
      unread: 0, // donuk arşiv: yeni mesaj gelmez, eski okundu imleci güvenilmez
      avatarUrl: c.type === 'GROUP_DM' ? c.avatar_image_https : avatars.get(others[0]),
    });
  }
  return out;
}

/**
 * Eski (1.1) gelen kutusunun sonraki sayfası: `/1.1/dm/inbox_timeline/trusted.json?max_id=<min_entry_id>`
 * (profil kopyasıyla doğrulandı: HAS_MORE, 15 sohbet, ilk sayfayla çakışma yok). XChat (şifreli) listesi zaten
 * tam geldiğinden yalnızca 1.1 arşivi sayfalanır; AT_END'de boş dizi. 1.1 grubu yerel XChat DB'sinde "g<id>" olarak
 * varsa o kimlikle (takma ad eski kimlik) döner ki köprü aynı sohbeti ikinci kez yaratmasın.
 */
async function legacyTimelinePage(page: Page, cookies: Record<string, string>, pageIndex: number): Promise<Thread[]> {
  if (!timelineCursors.length) await legacyInbox(page, cookies);
  for (let k = timelineCursors.length; k <= pageIndex - 1; k++) {
    const prev = timelineCursors[k - 1];
    if (!prev) return [];
    const j = await xapi(page, cookies, `/1.1/dm/inbox_timeline/trusted.json?max_id=${encodeURIComponent(prev)}&${LEGACY_Q}`);
    rememberTimeline(k, j.inbox_timeline);
  }
  const cursor = timelineCursors[pageIndex - 1];
  if (!cursor) return [];
  const j = await xapi(page, cookies, `/1.1/dm/inbox_timeline/trusted.json?max_id=${encodeURIComponent(cursor)}&${LEGACY_Q}`);
  const tl: J = j.inbox_timeline ?? {};
  rememberTimeline(pageIndex, tl);
  const out = legacyThreadsOf(tl);
  for (const t of out) {
    if (t.kind !== 'group' || t.id.startsWith('g')) continue;
    let inXchat = false;
    try {
      inXchat = !!snap?.db.prepare('select 1 from dm_conversation where conversation_id = ?').get('g' + t.id);
    } catch {
      /* anlık görüntü yok */
    }
    if (inXchat) {
      t.aliases = [...(t.aliases ?? []), t.id];
      t.id = 'g' + t.id;
    }
  }
  return out;
}

/** moreThreads'in tükettiği 1.1 zaman çizelgesi sayfası sayısı (0 = henüz yok) */
let timelineConsumed = 0;

/** Testler için: zaman çizelgesi zincirini ve eski gelen kutusu önbelleğini sıfırla */
export function _resetLegacyInbox(): void {
  timelineCursors.length = 0;
  timelineConsumed = 0;
  legacyThreads = undefined;
}

/** Eski 1.1 ucundan birebir sohbet geçmişi (`before` verilirse max_id ile ondan eskiler) */
async function legacyMessages(page: Page, cookies: Record<string, string>, threadId: string, limit: number, before?: number): Promise<Msg[]> {
  // XChat grubu "g<kimlik>": XChat öncesi geçmişi 1.1'de "<kimlik>" altında (yalnızca 1.1 gelen kutusunda varsa; yoksa 404 beklenir)
  const id = legacyIdOf(threadId);
  if (apiMissing.has(id) || (threadId.startsWith('g') && !legacyThreads?.some((t) => t.id === id))) return [];
  try {
    const q = `count=${Math.min(Math.max(limit, 20), 100)}&include_ext_alt_text=false&tweet_mode=extended${before ? `&max_id=${snowflakeFromMs(before)}` : ''}`;
    const data = await xapi(page, cookies, `/1.1/dm/conversation/${encodeURIComponent(id)}.json?${q}`);
    const tl = data.conversation_timeline ?? {};
    collectUsers(tl);
    return fromEntries(tl.entries ?? [], id).reverse();
  } catch (e) {
    if (/X 404/.test((e as Error).message)) apiMissing.add(id);
    else bus.log('warn', `X eski DM ucu (${id}): ${(e as Error).message}`);
    return [];
  }
}

/**
 * XChat geçmişi sunucuda DB'dekinden eskiye uzanıyor mu? dm_fetched_range.has_more=0: istemci sohbetin başına kadar
 * indirmiş (DOM'u kaydırmak boşuna). Sohbet DB'de hiç yoksa (yalnızca 1.1 arşivi) XChat geçmişi yok: false.
 */
function xchatHasOlder(db: Database.Database | undefined, conv: string): boolean {
  if (!db) return true; // DB yok: DOM tek kaynak
  try {
    if (!db.prepare('select 1 from dm_conversation where conversation_id = ?').get(conv)) return false;
    const r = db.prepare('select has_more from dm_fetched_range where conv_id = ?').get(conv) as { has_more: number } | undefined;
    return !r || Number(r.has_more) !== 0;
  } catch {
    return true; // şema farklı: eski davranış
  }
}

/**
 * Eski (1.1) grup sohbeti "<kimlik>" XChat'e taşınınca "g<kimlik>" olur: ikisi ayrı sohbet gibi listelenmesin.
 * XChat kimliği kalır (canlı olan, gönderim DOM'dan onunla); 1.1 kaydının daha yeni zamanı/önizlemesi varsa aktarılır.
 */
export function mergeLegacyGroups(byId: Map<string, Thread>): void {
  for (const [id, t] of [...byId]) {
    if (t.kind !== 'group' || id.startsWith('g')) continue;
    const xc = byId.get('g' + id);
    if (!xc) continue;
    if (t.lastTs > xc.lastTs) {
      xc.lastTs = t.lastTs;
      xc.preview = t.preview || xc.preview;
    }
    xc.preview ||= t.preview;
    if (!xc.participants?.length && t.participants?.length) xc.participants = t.participants;
    // köprü eski kimlikle kaydedilmiş sohbeti bu sohbete taşısın (kopya kalmasın)
    xc.aliases = [...(xc.aliases ?? []), id];
    byId.delete(id);
  }
}

/** 1.1 ucundaki karşılığı: XChat grubu "g<kimlik>" → "<kimlik>" */
const legacyIdOf = (threadId: string) => (threadId.startsWith('g') ? threadId.slice(1) : threadId);

/**
 * Aynı mesaj farklı kaynaklarda (DB / 1.1 API / DOM): kimlik (sıra no) eşleşiyorsa ya da başka kaynaktan gelen
 * bir mesajla metin+yön+±3 dk eşleşiyorsa ilkini tut. Aynı kaynak içindeki tekrarlar ("ok", "ok") gerçek mesajdır, silinmez.
 */
function mergeMsgs(...lists: Msg[][]): Msg[] {
  const out: Array<Msg & { src: number }> = [];
  const ids = new Set<string>();
  lists.forEach((list, src) => {
    for (const m of list) {
      if (ids.has(m.id)) continue;
      if (out.some((o) => o.src !== src && o.fromMe === m.fromMe && o.text === m.text && !!o.text && Math.abs(o.ts - m.ts) < 180e3)) continue;
      ids.add(m.id);
      out.push({ ...m, src });
    }
  });
  return out.sort((a, b) => a.ts - b.ts).map(({ src: _src, ...m }) => m);
}

export const x: Strategy & { fetchMedia(page: Page, cookies: Record<string, string>, u: string): Promise<{ body: Buffer; type: string } | undefined> } = {
  home: CHAT,
  loginHint: 'Açılan pencerede X hesabına giriş yap',

  async loggedIn(_page, cookies) {
    return Boolean(cookies.ct0 && cookies.auth_token);
  },

  async me(page, cookies) {
    meId = meFromCookies(cookies);
    try {
      const v = await xapi(page, cookies, '/1.1/account/verify_credentials.json');
      meId = String(v.id_str ?? v.id ?? meId);
      users.set(meId, v.name ?? 'Ben');
      return { id: meId, label: v.screen_name ? `@${v.screen_name}` : 'X' };
    } catch {
      // verify_credentials kapalı; gelen kutusundaki kullanıcı listesinden adı bul
      const data: J = await xapi(page, cookies, '/1.1/dm/inbox_initial_state.json?include_ext_alt_text=false&include_reply_count=1&tweet_mode=extended&dm_secret_conversations_enabled=false').catch(() => ({}) as J);
      const u = data?.inbox_initial_state?.users?.[meId];
      return { id: meId, label: u?.screen_name ? `@${u.screen_name}` : 'X' };
    }
  },

  async threads(page, cookies): Promise<Thread[]> {
    meId = meFromCookies(cookies) || meId;
    if (legacyThreads && legacyMe !== meId) legacyThreads = undefined;
    legacyMe = meId;
    const byId = new Map<string, Thread>();
    // 1) XChat öncesi sohbetler (donuk; bir kez)
    try {
      for (const t of await legacyInbox(page, cookies)) byId.set(t.id, t);
    } catch (e) {
      bus.log('warn', `X eski gelen kutusu okunamadı: ${(e as Error).message}`);
    }
    // 2) Yerel XChat veritabanı: güncel liste, gerçek zaman ve okunmamış sayısı (aynı sohbette DB kazanır)
    let fromDb = false;
    try {
      if (await freshSnapshot(page)) {
        await loadReadMarks(page);
        const list = dbThreads(snap!.db); // şema uyuşmazlığında burada patlar → DOM yedeğine düş
        // görünen sohbetlerde sayfanın canlı okunmamış işareti yedekten yetkili (telefonda okunan sohbet yedekte okunmamış kalıyor)
        const live = await domUnreadFlags(page);
        for (const t of list) {
          const u = live.get(t.id);
          if (u === false) t.unread = 0;
          else if (u === true) t.unread = Math.max(1, t.unread);
          byId.set(t.id, t);
        }
        fromDb = true;
      }
    } catch (e) {
      bus.log('warn', `X yerel veritabanı: ${(e as Error).message}`);
    }
    if (!fromDb) {
      // 3) DB yoksa (ilk açılış/yedek yazılmamış): /i/chat DOM'undan ad, önizleme ve okunmamış işareti
      try {
        for (const d of await domInbox(page)) {
          const prev = domPreview.get(d.id);
          domPreview.set(d.id, d.preview);
          const changed = prev !== undefined && prev !== d.preview;
          const ex = byId.get(d.id);
          if (ex) {
            if (d.preview && d.preview !== ex.preview.replace(/^(You|Sen):\s*/, '')) {
              ex.preview = d.preview;
              if (changed) ex.lastTs = Math.max(ex.lastTs, Date.now());
            }
            ex.unread = d.unread ? Math.max(1, ex.unread) : 0;
          } else {
            // DOM'da yalnızca göreli süre var → zaman 0 (mesajlar okununca gerçek değeri alır), önizleme değişince "şimdi"
            byId.set(d.id, { id: d.id, name: d.name || 'Sohbet', kind: d.id.startsWith('g') ? 'group' : 'direct', lastTs: changed ? Date.now() : 0, preview: d.preview, unread: d.unread ? 1 : 0 });
          }
        }
      } catch (e) {
        bus.log('warn', `X sohbet listesi (DOM) okunamadı: ${(e as Error).message}`);
      }
    }
    mergeLegacyGroups(byId);
    return [...byId.values()];
  },

  async messages(page, cookies, threadId, limit, before): Promise<Msg[]> {
    meId = meFromCookies(cookies) || meId;
    const conv = convOf(threadId);
    let db: Msg[] = [];
    try {
      if (await ensureSnapshot(page)) db = dbMessages(snap!.db, conv, limit, before);
    } catch (e) {
      bus.log('warn', `X yerel veritabanı (${threadId}): ${(e as Error).message}`);
    }
    // XChat öncesi geçmiş: 1.1 ucu (birebir sohbetler); yalnızca DB yetmezse
    const api = db.length < limit ? await legacyMessages(page, cookies, threadId, limit, before) : [];
    let dom: Msg[] = [];
    // DB'de olmayan eski XChat mesajları yalnızca sayfada: eski mesaj isteğinde (ya da DB hiç yoksa) kaydırarak oku
    const known = mergeMsgs(db, api);
    // DOM (yavaş: sayfayı kaydırır) yalnızca XChat'te DB'dekinden eski geçmiş varken; yalnızca 1.1 arşivi olan ya da
    // başına kadar indirilmiş sohbette gereksiz (önceden eski mesaj isteği ~17 sn boşuna kaydırıyordu)
    if (before !== undefined ? known.filter((m) => m.ts < before).length < limit && xchatHasOlder(snap?.db, conv) : !snap) {
      try {
        const oldest = known[0]?.ts ?? before;
        dom = await domMessages(page, threadId, before === undefined ? limit : limit - known.filter((m) => m.ts < before).length, before, oldest ? oldest - 1 : undefined);
      } catch (e) {
        bus.log('warn', `X mesajlar (DOM) okunamadı (${threadId}): ${(e as Error).message}`);
      }
    }
    const all = mergeMsgs(db, api, dom).filter((m) => before === undefined || m.ts < before);
    return all.slice(-limit);
  },

  async markRead(page, _cookies, threadId) {
    // /i/chat/<id> sayfasını açmak okundu işaretler: istemci şifreli okundu olayını SendMessageEventMutation ile gönderir
    // (profil kopyasıyla doğrulandı; olay sayfa açıldıktan 1-3 sn sonra gidiyor, eskiden 0,8 sn beklenip kapatılıyordu).
    // Sayfa zaten açıksa yeniden yükle: aradaki yeni mesajlar için olay yeniden gönderilsin.
    // #mivelo-visible: gizli sekme taklidi kapatılır (istemci okundu olayını görünür sekmede gönderir)
    const url = `${CHAT}/${threadId}`;
    const sent = page.waitForRequest((r) => /SendMessageEventMutation|mark_read|markRead/i.test(r.url()), { timeout: 6_000 }).catch(() => undefined);
    if (page.url().startsWith(url)) await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    else await page.goto(`${url}#mivelo-visible`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    await page.waitForSelector('[data-testid="dm-message-scroller"]', { timeout: 10_000 }).catch(() => undefined);
    await sent;
    await page.waitForTimeout(500);
    readMarks.set(convOf(threadId), Date.now());
    await saveReadMarks(page);
  },

  async openDirect(_page, _cookies, p) {
    // X birebir sohbet kimliği: iki kullanıcı kimliğinin küçükten büyüğe birleşimi
    const a = BigInt(meId);
    const b = BigInt(p.id);
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  },

  /**
   * Daha eski sohbetler: yalnızca eski 1.1 gelen kutusu sayfalanır (max_id); XChat listesi (yerel DB) zaten tam gelir.
   * 1.1 sayfaları çoğunlukla XChat'e taşınmış (DB'de olan, threads() ile zaten yazılmış) sohbetleri döndürür; bunlar
   * elenir ve DB'de olmayan bir sohbet bulunana (ya da zincir bitene) dek en çok 6 sayfa ilerlenir. Köprünün
   * pageIndex'i yerine kendi konumu tutulur: aynı çağrı yinelense de kaldığı yerden sürer.
   */
  async moreThreads(page, cookies): Promise<Thread[]> {
    meId = meFromCookies(cookies) || meId;
    const known = (id: string): boolean => {
      try {
        return !!snap?.db.prepare('select 1 from dm_conversation where conversation_id = ?').get(convOf(id));
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 6; i++) {
      const pageNo = timelineConsumed + 1;
      const got = await legacyTimelinePage(page, cookies, pageNo);
      if (!got.length) return [];
      timelineConsumed = pageNo;
      const fresh = got.filter((t) => !known(t.id));
      if (fresh.length) return fresh;
    }
    return [];
  },

  /**
   * Dosya/fotoğraf: /i/chat/<id> düzenleyicisindeki gizli `input[data-testid="dm-composer-file-input"]` (multiple,
   * accept yok; "Dosya ekle" düğmesi; profil kopyasıyla doğrulandı) dosyayı alır — XChat istemcisi şifreleyip yükler.
   * Önizleme çizilince açıklama yazılır ve Enter gönderir. (Gönderim canlı denenmedi.)
   */
  async sendFile(page, _cookies, threadId, file, caption) {
    const url = `${CHAT}/${threadId}`;
    if (!page.url().startsWith(url)) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const box = page.locator('[data-testid="dm-composer-textarea"]').first();
    await box.waitFor({ timeout: 15_000 });
    const input = page.locator('[data-testid="dm-composer-file-input"], [data-testid="dm-composer-container"] input[type="file"]').first();
    if (!(await input.count().catch(() => 0))) throw new Error('X: sohbet düzenleyicisinde dosya girişi bulunamadı');
    await input.setInputFiles(file.path);
    // önizleme (composer'da küçük resim / dosya kartı) çizilene dek en çok 20 sn
    const container = page.locator('[data-testid="dm-composer-container"]');
    for (const t0 = Date.now(); Date.now() - t0 < 20_000; ) {
      await page.waitForTimeout(400);
      if ((await container.locator('img, video, [data-testid*="attachment"], [aria-label*="Kaldır"], [aria-label*="Remove"]').count().catch(() => 0)) > 0) break;
    }
    await box.click();
    if (caption) await box.fill(caption);
    await page.keyboard.press('Enter');
    // gönderim: kutu boşalır ve önizleme kalkar (en fazla dosya boyutuna göre)
    const maxMs = Math.max(8_000, Math.min(180_000, file.size / 50));
    for (const t0 = Date.now(); Date.now() - t0 < maxMs; ) {
      await page.waitForTimeout(400);
      const text = (await box.inputValue({ timeout: 1000 }).catch(async () => box.innerText({ timeout: 1000 }).catch(() => ''))).trim();
      const previews = await container.locator('img, video, [data-testid*="attachment"]').count().catch(() => 0);
      if (!text && previews === 0) break;
    }
    return undefined;
  },

  async send(page, cookies, threadId, text) {
    // Şifreli (XChat) sohbetlerde 1.1 gönderimi reddedilir → sayfadaki yazı kutusuna yaz
    const domSend = async (): Promise<string | undefined> => {
      const url = `${CHAT}/${threadId}`;
      if (!page.url().startsWith(url)) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const box = page.locator('[data-testid="dm-composer-textarea"]').first();
      await box.waitFor({ timeout: 15_000 });
      await box.click();
      await box.fill(text);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);
      return undefined;
    };
    if (threadId.startsWith('g') || apiMissing.has(threadId)) return domSend();
    let r: J;
    try {
      r = await xapi(page, cookies, '/1.1/dm/new2.json?ext=mediaColor,altText&include_ext_alt_text=true&supports_reactions=true', {
        conversation_id: threadId,
        recipient_ids: false,
        request_id: crypto.randomUUID(),
        text,
        cards_platform: 'Web-12',
        include_cards: 1,
        include_quote_count: true,
        dm_users: false,
      });
    } catch {
      return domSend();
    }
    return r?.entries?.[0]?.message?.id ? String(r.entries[0].message.id) : domSend();
  },

  /**
   * Şifreli XChat medyası: "xc:<sohbet>/<ekKimliği>" → istemcinin OPFS'e yazdığı çözülmüş dosya
   * (dm-files-<kimlik>/decrypted-media-v2/<sohbet>/<ek>/<dosya>). Köprü bu kancayı çağırınca çalışır.
   */
  async fetchMedia(page, _cookies, u) {
    const m = u.match(/^xc:([^/]+)\/([^/]+)$/);
    if (!m) return undefined;
    const r = await page.evaluate(
      async ({ me, conv, att }) => {
        const root = await navigator.storage.getDirectory();
        const walk = async (dir: FileSystemDirectoryHandle, parts: string[]): Promise<FileSystemDirectoryHandle | undefined> => {
          let d: FileSystemDirectoryHandle | undefined = dir;
          for (const p of parts) d = await d?.getDirectoryHandle(p).catch(() => undefined);
          return d;
        };
        const dir = await walk(root, [`dm-files-${me}`, 'decrypted-media-v2', conv, att]);
        if (!dir) return undefined;
        for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }).entries()) {
          if (h.kind !== 'file') continue;
          const f = await h.getFile();
          const buf = new Uint8Array(await f.arrayBuffer());
          let s = '';
          for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + 0x8000)));
          return { name, type: f.type, b64: btoa(s) };
        }
        return undefined;
      },
      { me: meId, conv: m[1], att: m[2] },
    );
    if (!r) return undefined;
    const ext = r.name.split('.').pop()?.toLowerCase() ?? '';
    const type = r.type || ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', m4a: 'audio/mp4', mp3: 'audio/mpeg' } as Record<string, string>)[ext] || 'application/octet-stream';
    return { body: Buffer.from(r.b64, 'base64'), type };
  },
};
