import { createHash, randomBytes } from 'node:crypto';
import { bus } from './bus.js';
import { MAIL_PLATFORMS, type Message, type Platform } from './model.js';
import type { Store } from './store.js';

/**
 * Kişi birleştirme: aynı kişinin farklı platformlardaki BİREBİR sohbetleri tek kişide (tek profil, tek zaman çizelgesi).
 *
 * - Kişi = en az iki birebir sohbet (people + person_chats; şema store.ts'te). Gruplar/kanallar/pazaryeri siparişleri bağlanmaz.
 * - Öneri motoru OTOMATİK BİRLEŞTİRMEZ, öneri üretir; kullanıcı onaylar. Tek istisna: aynı karşı adresli e-posta dizileri tek
 *   kimliktir — kişiye bağlı bir adresten yeni dizi gelince kendiliğinden o kişiye eklenir.
 * - Güçlü eşleşme: aynı telefon (E.164; TR varsayılan ülke kodu) ya da aynı e-posta. Orta: normalleştirilmiş ad (≥2 kelime,
 *   farklı platformlar) ya da aynı @kullanıcı adı (farklı platformlar).
 * - Hesaplama O(n) gruplama: her kimlik anahtarı bir kova; yalnız kova içi (küçük) çiftler karşılaştırılır. Kalabalık kovalar
 *   (yaygın ad) belirsiz sayılıp atlanır. Satırlar dilimli işlenir (olay döngüsü kilitlenmez).
 * - Reddedilen öneri sohbet çiftleri olarak kalıcı (people_dismissed): aynı kişiler bir daha önerilmez.
 */

/** Kişiye bağlanamayan platformlar (pazaryeri siparişleri/soruları kişi değil) */
export const PEOPLE_EXCLUDED: readonly Platform[] = ['shopier', 'trendyol', 'hepsiburada', 'etsy', 'shopify', 'n11', 'amazon', 'pttavm'];
const USERNAME_PLATFORMS: readonly Platform[] = ['instagram', 'x', 'tiktok', 'telegram'];
/** Adı rehberden gelen platformlar (kişinin görünen adı için önce bunlar) */
const NAME_RANK: Partial<Record<Platform, number>> = { imessage: 0, whatsapp: 1, telegram: 2, instagram: 3, linkedin: 3, messenger: 3, x: 4, tiktok: 4, slack: 4 };

export class PeopleError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface PersonChat {
  id: string;
  accountId: string;
  platform: Platform;
  name: string;
  handle?: string;
  avatarUrl?: string;
  lastMessageAt: number;
}

export interface Person {
  id: string;
  name: string;
  note?: string;
  avatarUrl?: string;
  createdAt: number;
  /** bağlı sohbetler, en yeni yazışma önce */
  chats: PersonChat[];
}

export interface PersonSuggestion {
  /** kararlı anahtar (birim kimliklerinin özeti): Birleştir / Hayır bu anahtarla */
  key: string;
  /** 0-1 güven */
  score: number;
  /** yalnız telefon/e-posta eşleşmesiyle bağlı (Tümünü birleştir yalnız bunlar) */
  strong: boolean;
  reasons: string[];
  name: string;
  /** önerideki mevcut kişi (varsa: sohbet o kişiye eklenir) */
  personId?: string;
  chatIds: string[];
  chats: PersonChat[];
}

export interface TimelineMessage extends Message {
  platform: Platform;
  accountId: string;
}

// ---------------------------------------------------------------- normalleştirme

/** Telefonu E.164'e çevir ("+905000000099"); ülke kodu yoksa TR (90). Geçersizse undefined. */
export function normalizePhone(raw: string | undefined | null, defaultCc = '90'): string | undefined {
  if (!raw) return undefined;
  const s = String(raw).trim();
  if (/[a-z@]/i.test(s)) return undefined;
  let d = s.replace(/[^\d+]/g, '');
  if (!d) return undefined;
  if (d.startsWith('+')) d = d.slice(1).replace(/\+/g, '');
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = defaultCc + d.slice(1); // 05xx xxx xx xx
  else if (d.length === 10 && d.startsWith('5')) d = defaultCc + d; // 5xx xxx xx xx
  if (!/^\d{8,15}$/.test(d) || /^0/.test(d)) return undefined;
  return '+' + d;
}

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i;
/** E-posta: küçük harf, googlemail → gmail. Geçersizse undefined. */
export function normalizeEmail(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let s = String(raw).trim().toLowerCase().replace(/^mailto:/, '');
  const m = /<([^>]+)>/.exec(s);
  if (m) s = m[1].trim();
  if (!EMAIL_RE.test(s)) return undefined;
  return s.replace(/@googlemail\.com$/, '@gmail.com');
}

/** @kullanıcı adı: @ atılır, küçük harf; yalnız a-z 0-9 . _ (en az 3) */
export function normalizeUsername(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const s = String(raw).trim().replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9._]{3,40}$/.test(s) && /[a-z]/.test(s) ? s : undefined;
}

/** Ad karşılaştırmasında atılan unvan/hitaplar (normalleştirilmiş, aksansız) */
const TITLES = new Set([
  'dr', 'doc', 'prof', 'av', 'uzm', 'muh', 'sn', 'sayin', 'bey', 'hanim', 'hn', 'bay', 'bayan', 'mr', 'mrs', 'ms', 'miss', 'sir',
  'op', 'ogr', 'gor', 'yrd', 'dt', 'ecz', 'vet', 'abi', 'abla', 'hoca', 'hocam', 'ustam', 'usta', 'amca', 'teyze', 'dayi', 'eng',
]);
/** Platformların genel yer tutucu adları: eşleşme sayılmaz */
const GENERIC_NAMES = new Set(['kisisi whatsapp', 'instagram user', 'instagram kullanicisi', 'facebook kullanicisi', 'facebook user', 'kisi bilinmeyen', 'linkedin member', 'linkedin uyesi', 'deleted account', 'hesap silinmis', 'kendine notlar']);

function fold(s: string): string {
  return s
    .normalize('NFKC')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');
}

/**
 * Ad anahtarı: Türkçe karakter / büyük-küçük harf / emoji / unvan farkı yok, kelime sırası önemsiz. En az iki kelime (≥2 harf);
 * rakamlı kelimeler (telefon, "Ahmet 2") ve 5'ten çok kelime (konu satırı vb.) sayılmaz. Uygun değilse undefined.
 */
export function nameKey(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const words: string[] = [];
  for (const tok of fold(String(raw)).split(/[\s,;|/]+/)) {
    if (!tok || /\d/.test(tok)) continue;
    const w = tok.replace(/[^\p{L}]/gu, '');
    if (w.length < 2 || TITLES.has(w)) continue;
    words.push(w);
  }
  const uniq = [...new Set(words)].sort();
  if (uniq.length < 2 || uniq.length > 5) return undefined;
  const key = uniq.join(' ');
  return GENERIC_NAMES.has(key) ? undefined : key;
}

/** Otomatik/toplu e-posta adresleri: adla eşleştirilmez */
const AUTOMATED_MAIL = /(^|[._+-])(no-?reply|noreply|donotreply|do-not-reply|notifications?|bildirim|mailer-daemon|bounce|newsletter|bulten|info|support|destek|hello|team|news|marketing|kampanya)([._+-]|@)/i;

// ---------------------------------------------------------------- sohbet kimlikleri

interface ChatRow {
  id: string;
  account_id: string;
  platform: Platform;
  remote_id: string;
  name: string;
  kind: string;
  handle: string | null;
  meta: string | null;
  avatar_url: string | null;
  last_message_at: number;
  pjson: string | null;
}

interface Ident {
  phones: string[];
  emails: string[];
  users: string[];
  name?: string;
  /** görünen ad (kişi adı önerisi için; e-postada konu değil karşı tarafın adı) */
  display?: string;
  /** e-posta dizisinin karşı adresi (aynı adresli diziler tek birim) */
  mailAddr?: string;
}

const MAIL = new Set<string>(MAIL_PLATFORMS);
const hasLetters = (s: string) => /\p{L}{2,}/u.test(s);

/** Bir birebir sohbetin kimlik anahtarları (telefon, e-posta, kullanıcı adı, ad) */
export function chatIdentity(r: Pick<ChatRow, 'platform' | 'remote_id' | 'name' | 'handle' | 'meta' | 'pjson'>): Ident {
  const out: Ident = { phones: [], emails: [], users: [] };
  const addPhone = (v?: string | null) => {
    const p = normalizePhone(v);
    if (p && !out.phones.includes(p)) out.phones.push(p);
  };
  const addEmail = (v?: string | null) => {
    const e = normalizeEmail(v);
    if (e && !out.emails.includes(e)) out.emails.push(e);
  };
  const handle = r.handle ?? undefined;
  let meta: Record<string, unknown> = {};
  if (r.meta) {
    try {
      meta = JSON.parse(r.meta) as Record<string, unknown>;
    } catch {
      /* bozuk meta */
    }
  }
  let display = r.name;
  if (r.platform === 'whatsapp') {
    const m = /^(\d{6,15})@s\.whatsapp\.net$/.exec(r.remote_id);
    if (m) addPhone('+' + m[1]);
    if (handle?.startsWith('+')) addPhone(handle);
  } else if (r.platform === 'imessage') {
    const ident = (r.remote_id.includes(';-;') ? r.remote_id.split(';-;')[1] : r.remote_id).replace(/\((filtered|smsft)\)$/, '');
    if (ident.includes('@')) addEmail(ident);
    else addPhone(ident);
  } else if (MAIL.has(r.platform)) {
    const addr = normalizeEmail(handle);
    if (addr) {
      out.mailAddr = addr;
      out.emails.push(addr);
      display = '';
      if (r.pjson && !AUTOMATED_MAIL.test(addr)) {
        try {
          const ps = JSON.parse(r.pjson) as Array<{ id?: string; name?: string; handle?: string }>;
          const p = ps.find((x) => normalizeEmail(x.handle ?? x.id) === addr);
          if (p?.name && !p.name.includes('@')) display = p.name;
        } catch {
          /* bozuk katılımcı */
        }
      }
    }
  } else {
    if (handle?.startsWith('+')) addPhone(handle);
    else if (handle?.includes('@') && handle.indexOf('@') > 0) addEmail(handle);
  }
  if (typeof meta.phone === 'string') addPhone(meta.phone);
  if (typeof meta.email === 'string') addEmail(meta.email);
  if (USERNAME_PLATFORMS.includes(r.platform) && handle?.startsWith('@')) {
    const u = normalizeUsername(handle);
    if (u) out.users.push(u);
  }
  if (display && hasLetters(display)) {
    out.display = display.trim();
    out.name = nameKey(display);
  }
  return out;
}

// ---------------------------------------------------------------- birimler, kovalar, öneriler

interface Unit {
  /** 'p:<kişi>' | 'e:<adres>' | 'c:<sohbet>' */
  uid: string;
  personId?: string;
  chats: ChatRow[];
  platforms: Set<Platform>;
  phones: Set<string>;
  emails: Set<string>;
  users: Set<string>;
  names: Set<string>;
  display: Array<{ name: string; platform: Platform }>;
  lastAt: number;
}

interface Edge {
  a: number;
  b: number;
  parts: Map<string, number>;
  strong: boolean;
}

const SCORE = { phone: 0.97, email: 0.95, user: 0.75, name: 0.6 } as const;
/** kova başına en çok birim: kalabalık kova (yaygın ad, ortak santral numarası) belirsizdir, önerilmez */
const BUCKET_MAX = { ph: 12, em: 12, un: 6, nm: 6 } as const;
const COMPONENT_MAX = 8;
const SUGGESTION_MAX = 500;
const SLICE = 800;

const tick = () => new Promise<void>((r) => setImmediate(r));
const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

function toPersonChat(r: ChatRow): PersonChat {
  return {
    id: r.id,
    accountId: r.account_id,
    platform: r.platform,
    name: r.name,
    handle: r.handle ?? undefined,
    avatarUrl: r.avatar_url ?? undefined,
    lastMessageAt: Number(r.last_message_at) || 0,
  };
}

/** Kişinin görünen adı: rehberden gelen platformlar önce; harfsiz (numara) adlar atlanır */
function bestName(list: Array<{ name: string; platform: Platform }>): string {
  const ok = list.filter((d) => hasLetters(d.name));
  // tam ad (≥2 kelime) önce, sonra rehber platformu, sonra uzunluk
  const full = (s: string) => (s.trim().split(/\s+/).length >= 2 ? 0 : 1);
  ok.sort((x, y) => full(x.name) - full(y.name) || (NAME_RANK[x.platform] ?? 5) - (NAME_RANK[y.platform] ?? 5) || y.name.length - x.name.length);
  return ok[0]?.name ?? list[0]?.name ?? 'Kişi';
}

export class People {
  private suggestions: PersonSuggestion[] = [];
  private computedAt = 0;
  private computing: Promise<void> | null = null;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private daily: NodeJS.Timeout | null = null;
  private unsub: (() => void) | null = null;
  private lastSig = '';

  constructor(private store: Store) {}

  /** Arka plan: açılıştan 90 sn sonra, hesap eşitlemesi bitince (30 sn sonra) ve günde bir yeniden hesapla */
  start(): void {
    if (this.unsub) return;
    this.unsub = bus.on((ev) => {
      if (ev.type === 'account.sync' && ev.progress >= 100) this.schedule(30_000);
      if (ev.type === 'account.removed') {
        this.store.prunePeople();
        this.schedule(3_000);
        bus.emit({ type: 'people.update' });
      }
    });
    this.schedule(90_000);
    this.daily = setInterval(() => this.schedule(0), 24 * 3_600_000);
    this.daily.unref();
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.daily) clearInterval(this.daily);
    this.timer = this.daily = null;
  }

  /** "Tüm verileri sil" sonrası: öneri önbelleği boşalır (tablolar store.wipeAll'da silindi) */
  clear(): void {
    this.suggestions = [];
    this.lastSig = '';
    this.computedAt = 0;
    bus.emit({ type: 'people.update' });
  }

  /** Yeniden hesaplamayı `ms` sonra planla (daha yakın bir plan varsa o kalır) */
  schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.recompute().catch((e) => bus.log('warn', `Kişi önerileri hesaplanamadı: ${(e as Error).message}`));
    }, ms);
    this.timer.unref?.();
  }

  // ------------------------------------------------ okuma

  private removingFilter<T extends { accountId: string }>(list: T[]): T[] {
    return list.filter((c) => !this.store.isRemoving(c.accountId));
  }

  list(): Person[] {
    this.store.prunePeople();
    const rows = this.store
      .sql(
        `SELECT p.id AS pid, p.name AS pname, p.note, p.created_at, p.avatar_chat, c.id, c.account_id, c.platform, c.remote_id, c.name, c.kind, c.handle, c.meta, c.avatar_url, c.last_message_at, NULL AS pjson
           FROM people p JOIN person_chats pc ON pc.person_id = p.id JOIN chats c ON c.id = pc.chat_id ORDER BY p.created_at, c.last_message_at DESC`,
      )
      .all() as Array<ChatRow & { pid: string; pname: string; note: string | null; created_at: number; avatar_chat: string | null }>;
    const map = new Map<string, Person & { _avatarChat?: string | null }>();
    for (const r of rows) {
      let p = map.get(r.pid);
      if (!p) {
        p = { id: r.pid, name: r.pname, note: r.note ?? undefined, createdAt: Number(r.created_at), chats: [], _avatarChat: r.avatar_chat };
        map.set(r.pid, p);
      }
      p.chats.push(toPersonChat(r));
    }
    const out: Person[] = [];
    for (const { _avatarChat, ...p } of map.values()) {
      p.chats = this.removingFilter(p.chats);
      if (p.chats.length < 2) continue;
      const av = p.chats.find((c) => c.id === _avatarChat && c.avatarUrl) ?? [...p.chats].sort((x, y) => (NAME_RANK[x.platform] ?? 5) - (NAME_RANK[y.platform] ?? 5)).find((c) => c.avatarUrl);
      if (av?.avatarUrl) p.avatarUrl = av.avatarUrl;
      out.push(p);
    }
    return out;
  }

  get(id: string): Person | undefined {
    return this.list().find((p) => p.id === id);
  }

  /** Sohbetin bağlı olduğu kişi kimliği */
  personOf(chatId: string): string | undefined {
    return (this.store.sql('SELECT person_id FROM person_chats WHERE chat_id = ?').get(chatId) as { person_id?: string } | undefined)?.person_id;
  }

  async listSuggestions(): Promise<{ suggestions: PersonSuggestion[]; computedAt: number }> {
    if (!this.computedAt) await this.recompute();
    return { suggestions: this.suggestions, computedAt: this.computedAt };
  }

  /**
   * Birleşik zaman çizelgesi: kişinin tüm sohbetlerinin mesajları zamana göre (eskiden yeniye), sayfalı. Her sohbet kendi
   * (chat_id, ts) dizininden `limit` kadar okunur, birleştirilip en yeni `limit` mesaj döner.
   */
  timeline(id: string, before?: number, limit = 100): { messages: TimelineMessage[]; hasMore: boolean; chats: PersonChat[] } {
    const person = this.get(id);
    if (!person) throw new PeopleError(404, 'Kişi yok');
    limit = Math.min(300, Math.max(1, Math.floor(limit) || 100));
    const all: TimelineMessage[] = [];
    let more = false;
    for (const c of person.chats) {
      const list = this.store.listMessages(c.id, limit, before);
      if (list.length >= limit) more = true;
      for (const m of list) all.push({ ...m, platform: c.platform, accountId: c.accountId });
    }
    all.sort((a, b) => a.ts - b.ts || (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0));
    const messages = all.length > limit ? all.slice(all.length - limit) : all;
    return { messages, hasMore: more || all.length > limit, chats: person.chats };
  }

  // ------------------------------------------------ yazma

  private chatRow(id: string): ChatRow | undefined {
    return this.store
      .sql('SELECT id, account_id, platform, remote_id, name, kind, handle, meta, avatar_url, last_message_at, NULL AS pjson FROM chats WHERE id = ?')
      .get(id) as ChatRow | undefined;
  }

  /** Aynı karşı adresli (bağsız) e-posta dizileri */
  private mailSiblings(addr: string): string[] {
    const rows = this.store
      .sql(`SELECT c.id, c.handle FROM chats c WHERE c.kind = 'direct' AND c.platform IN (${MAIL_PLATFORMS.map((p) => `'${p}'`).join(',')}) AND c.handle IS NOT NULL AND lower(c.handle) LIKE ?`)
      .all(`%${addr.split('@')[1] ?? addr}`) as Array<{ id: string; handle: string }>;
    return rows.filter((r) => normalizeEmail(r.handle) === addr).map((r) => r.id);
  }

  /**
   * Birleştir: verilen sohbetler (ve varsa bağlı oldukları kişiler) tek kişide. `personId` verilirse o kişiye eklenir.
   * E-posta dizisi bağlanınca aynı adresli diğer diziler de bağlanır.
   */
  merge(chatIds: string[], opts: { personId?: string; name?: string } = {}): Person {
    const ids = [...new Set(chatIds.filter((x) => typeof x === 'string' && x))];
    if (ids.length > 200) throw new PeopleError(400, 'Çok fazla sohbet');
    const rows: ChatRow[] = [];
    for (const id of ids) {
      const r = this.chatRow(id);
      if (!r || this.store.isRemoving(r.account_id)) throw new PeopleError(404, 'Sohbet yok');
      if (r.kind !== 'direct') throw new PeopleError(400, 'Yalnız birebir sohbetler bir kişiye bağlanabilir');
      if (PEOPLE_EXCLUDED.includes(r.platform)) throw new PeopleError(400, 'Pazaryeri sohbetleri kişiye bağlanmaz');
      rows.push(r);
    }
    if (opts.personId && !this.store.sql('SELECT 1 FROM people WHERE id = ?').get(opts.personId)) throw new PeopleError(404, 'Kişi yok');
    // e-posta: aynı adresli bütün diziler
    for (const r of [...rows]) {
      if (!MAIL.has(r.platform)) continue;
      const addr = normalizeEmail(r.handle);
      if (!addr) continue;
      for (const sid of this.mailSiblings(addr)) if (!ids.includes(sid)) {
        const s = this.chatRow(sid);
        if (s) {
          ids.push(sid);
          rows.push(s);
        }
      }
    }
    const existing = new Set<string>();
    if (opts.personId) existing.add(opts.personId);
    for (const id of ids) {
      const pid = this.personOf(id);
      if (pid) existing.add(pid);
    }
    const target = opts.personId ?? [...existing][0] ?? 'p_' + randomBytes(6).toString('hex');
    const current = existing.has(target) ? (this.store.sql('SELECT chat_id FROM person_chats WHERE person_id = ?').all(target) as Array<{ chat_id: string }>).map((x) => x.chat_id) : [];
    const distinct = new Set([...ids, ...current]);
    if (distinct.size < 2) throw new PeopleError(400, 'Birleştirmek için en az iki sohbet gerekli');
    const now = Date.now();
    this.store.transaction(() => {
      if (!existing.has(target)) {
        const name = (opts.name ?? '').trim().slice(0, 80) || bestName(rows.map((r) => ({ name: chatIdentity(r).display ?? r.name, platform: r.platform })));
        this.store.sql('INSERT INTO people (id, name, created_at) VALUES (?, ?, ?)').run(target, name, now);
      } else if (opts.name?.trim()) this.store.sql('UPDATE people SET name = ? WHERE id = ?').run(opts.name.trim().slice(0, 80), target);
      for (const other of existing) {
        if (other === target) continue;
        this.store.sql('UPDATE person_chats SET person_id = ? WHERE person_id = ?').run(target, other);
        this.store.sql('DELETE FROM people WHERE id = ?').run(other);
      }
      const link = this.store.sql('INSERT INTO person_chats (chat_id, person_id, linked_at) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET person_id = excluded.person_id');
      for (const id of ids) link.run(id, target, now);
      // birleştirilenler arasındaki eski "Hayır" kayıtları anlamsız
      const all = [...distinct];
      const del = this.store.sql('DELETE FROM people_dismissed WHERE a = ? AND b = ?');
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length && j < 60; j++) {
        const [a, b] = pairKey(all[i], all[j]).split('\u0000');
        del.run(a, b);
      }
    });
    this.dropCovered();
    this.changed();
    return this.get(target)!;
  }

  /** Sohbeti kişiden ayır; ayrılan sohbet bu kişiyle bir daha önerilmez. E-posta dizisinde aynı adresli dizilerin hepsi ayrılır. */
  unlink(personId: string, chatId: string): Person | null {
    const person = this.get(personId);
    if (!person) throw new PeopleError(404, 'Kişi yok');
    const chat = person.chats.find((c) => c.id === chatId);
    if (!chat) throw new PeopleError(404, 'Sohbet bu kişiye bağlı değil');
    const addr = MAIL.has(chat.platform) ? normalizeEmail(chat.handle) : undefined;
    const gone = person.chats.filter((c) => c.id === chatId || (addr && MAIL.has(c.platform) && normalizeEmail(c.handle) === addr));
    const stay = person.chats.filter((c) => !gone.includes(c));
    const now = Date.now();
    this.store.transaction(() => {
      const del = this.store.sql('DELETE FROM person_chats WHERE chat_id = ?');
      for (const c of gone) del.run(c.id);
      const dis = this.store.sql('INSERT OR IGNORE INTO people_dismissed (a, b, at) VALUES (?, ?, ?)');
      for (const g of gone) for (const s of stay) {
        const [a, b] = pairKey(g.id, s.id).split('\u0000');
        dis.run(a, b, now);
      }
      this.store.prunePeople();
    });
    this.changed();
    return this.get(personId) ?? null;
  }

  update(id: string, patch: { name?: unknown; note?: unknown }): Person {
    if (!this.store.sql('SELECT 1 FROM people WHERE id = ?').get(id)) throw new PeopleError(404, 'Kişi yok');
    if (typeof patch.name === 'string') {
      const n = patch.name.trim().slice(0, 80);
      if (!n) throw new PeopleError(400, 'Ad boş olamaz');
      this.store.sql('UPDATE people SET name = ? WHERE id = ?').run(n, id);
    }
    if (typeof patch.note === 'string' || patch.note === null) this.store.sql('UPDATE people SET note = ? WHERE id = ?').run(typeof patch.note === 'string' ? patch.note.slice(0, 2000) || null : null, id);
    bus.emit({ type: 'people.update' });
    return this.get(id)!;
  }

  /** Öneriyi reddet: önerideki birimler arasındaki tüm sohbet çiftleri kalıcı olarak "aynı kişi değil" */
  dismiss(key: string): boolean {
    const s = this.suggestions.find((x) => x.key === key);
    if (!s) return false;
    const groups = this.unitGroups(s);
    const now = Date.now();
    this.store.transaction(() => {
      const dis = this.store.sql('INSERT OR IGNORE INTO people_dismissed (a, b, at) VALUES (?, ?, ?)');
      for (let i = 0; i < groups.length; i++)
        for (let j = i + 1; j < groups.length; j++)
          for (const x of groups[i]) for (const y of groups[j]) {
            const [a, b] = pairKey(x, y).split('\u0000');
            dis.run(a, b, now);
          }
    });
    this.suggestions = this.suggestions.filter((x) => x.key !== key);
    bus.emit({ type: 'people.update' });
    return true;
  }

  mergeSuggestion(key: string): Person {
    const s = this.suggestions.find((x) => x.key === key);
    if (!s) throw new PeopleError(404, 'Öneri yok (listeyi yenileyin)');
    return this.merge(s.chatIds, { personId: s.personId });
  }

  /** "Tümünü birleştir": yalnız güçlü (telefon/e-posta) öneriler */
  mergeAllStrong(): number {
    let n = 0;
    for (const s of this.suggestions.filter((x) => x.strong)) {
      try {
        this.merge(s.chatIds, { personId: s.personId && this.store.sql('SELECT 1 FROM people WHERE id = ?').get(s.personId) ? s.personId : undefined });
        n++;
      } catch {
        /* bu arada değişmiş öneri atlanır */
      }
    }
    return n;
  }

  /** Öneriyi birim gruplarına ayır (kişi → tüm sohbetleri; bağsız sohbet → kendisi) */
  private unitGroups(s: PersonSuggestion): string[][] {
    const byPerson = new Map<string, string[]>();
    const out: string[][] = [];
    for (const c of s.chatIds) {
      const pid = this.personOf(c);
      if (pid) byPerson.set(pid, [...(byPerson.get(pid) ?? []), c]);
      else out.push([c]);
    }
    // aynı adresli e-posta dizileri tek birim
    const mail = new Map<string, string[]>();
    const rest: string[][] = [];
    for (const g of out) {
      const ch = s.chats.find((c) => c.id === g[0]);
      const addr = ch && MAIL.has(ch.platform) ? normalizeEmail(ch.handle) : undefined;
      if (addr) mail.set(addr, [...(mail.get(addr) ?? []), ...g]);
      else rest.push(g);
    }
    return [...byPerson.values(), ...mail.values(), ...rest];
  }

  /** Birleşmeyle geçersizleşen öneriler hemen düşer (tam hesap arkada) */
  private dropCovered(): void {
    const linked = new Map<string, string>();
    for (const r of this.store.sql('SELECT chat_id, person_id FROM person_chats').all() as Array<{ chat_id: string; person_id: string }>) linked.set(r.chat_id, r.person_id);
    this.suggestions = this.suggestions.filter((s) => new Set(s.chatIds.map((c) => linked.get(c) ?? c)).size > 1);
  }

  private changed(): void {
    bus.emit({ type: 'people.update' });
    this.schedule(1_500);
  }

  // ------------------------------------------------ öneri hesabı

  /** Önerileri yeniden hesapla (aynı anda tek hesap; sürerken istenirse bittiğinde bir kez daha) */
  recompute(): Promise<void> {
    if (this.computing) {
      this.again = true;
      return this.computing;
    }
    this.computing = (async () => {
      try {
        do {
          this.again = false;
          await this.compute();
        } while (this.again);
      } finally {
        this.computing = null;
      }
    })();
    return this.computing;
  }

  private async compute(): Promise<void> {
    const t0 = Date.now();
    const mailIn = MAIL_PLATFORMS.map((p) => `'${p}'`).join(',');
    const rows = this.store
      .sql(
        `SELECT id, account_id, platform, remote_id, name, kind, handle, meta, avatar_url, last_message_at,
                CASE WHEN platform IN (${mailIn}) THEN (SELECT p.json FROM chat_participants p WHERE p.chat_id = chats.id) END AS pjson
           FROM chats WHERE kind = 'direct' AND platform NOT IN (${PEOPLE_EXCLUDED.map((p) => `'${p}'`).join(',')})`,
      )
      .all() as ChatRow[];
    const links = new Map<string, string>();
    for (const r of this.store.sql('SELECT chat_id, person_id FROM person_chats').all() as Array<{ chat_id: string; person_id: string }>) links.set(r.chat_id, r.person_id);
    const dismissed = new Set<string>();
    for (const r of this.store.sql('SELECT a, b FROM people_dismissed').all() as Array<{ a: string; b: string }>) dismissed.add(`${r.a}\u0000${r.b}`);

    // 1) birimler (kişi / e-posta adresi / tek sohbet)
    const units: Unit[] = [];
    const byUid = new Map<string, number>();
    const unitFor = (uid: string, personId?: string): Unit => {
      let i = byUid.get(uid);
      if (i === undefined) {
        i = units.length;
        byUid.set(uid, i);
        units.push({ uid, personId, chats: [], platforms: new Set(), phones: new Set(), emails: new Set(), users: new Set(), names: new Set(), display: [], lastAt: 0 });
      }
      return units[i];
    };
    /** kişiye bağlı e-posta adresleri → kişi (yeni dizi kendiliğinden eklenir) */
    const personMail = new Map<string, string>();
    const autoLink: Array<[string, string]> = [];
    const idents = new Map<string, Ident>();
    for (let i = 0; i < rows.length; i++) {
      if (i && i % SLICE === 0) await tick();
      const r = rows[i];
      if (this.store.isRemoving(r.account_id)) continue;
      const id = chatIdentity(r);
      idents.set(r.id, id);
      const pid = links.get(r.id);
      if (pid && id.mailAddr) personMail.set(id.mailAddr, pid);
    }
    for (let i = 0; i < rows.length; i++) {
      if (i && i % SLICE === 0) await tick();
      const r = rows[i];
      const id = idents.get(r.id);
      if (!id) continue;
      let pid = links.get(r.id);
      if (!pid && id.mailAddr && personMail.has(id.mailAddr)) {
        pid = personMail.get(id.mailAddr)!;
        autoLink.push([r.id, pid]);
      }
      const u = pid ? unitFor(`p:${pid}`, pid) : id.mailAddr ? unitFor(`e:${id.mailAddr}`) : unitFor(`c:${r.id}`);
      u.chats.push(r);
      u.platforms.add(r.platform);
      for (const p of id.phones) u.phones.add(p);
      for (const e of id.emails) u.emails.add(e);
      for (const x of id.users) u.users.add(x);
      if (id.name) u.names.add(id.name);
      if (id.display) u.display.push({ name: id.display, platform: r.platform });
      u.lastAt = Math.max(u.lastAt, Number(r.last_message_at) || 0);
    }
    if (autoLink.length) {
      const now = Date.now();
      this.store.transaction(() => {
        const link = this.store.sql('INSERT OR IGNORE INTO person_chats (chat_id, person_id, linked_at) VALUES (?, ?, ?)');
        for (const [c, p] of autoLink) link.run(c, p, now);
      });
      bus.log('info', `Kişi birleştirme: ${autoLink.length} yeni e-posta dizisi bağlı kişilere eklendi`);
    }

    // 2) kovalar: kimlik anahtarı → birimler
    const buckets = new Map<string, number[]>();
    const put = (k: string, i: number) => {
      const b = buckets.get(k);
      if (!b) buckets.set(k, [i]);
      else if (b[b.length - 1] !== i) b.push(i);
    };
    for (let i = 0; i < units.length; i++) {
      if (i && i % SLICE === 0) await tick();
      const u = units[i];
      for (const p of u.phones) put(`ph:${p}`, i);
      for (const e of u.emails) put(`em:${e}`, i);
      for (const x of u.users) put(`un:${x}`, i);
      for (const n of u.names) put(`nm:${n}`, i);
    }

    // 3) kenarlar (yalnız kova içi; kalabalık kovalar atlanır)
    const edges = new Map<string, Edge>();
    /** reddedilmiş birim çiftleri (bir kez bakılır) */
    const blocked = new Set<string>();
    const isDismissed = (a: Unit, b: Unit): boolean => {
      if (!dismissed.size) return false;
      for (const x of a.chats) for (const y of b.chats) if (dismissed.has(pairKey(x.id, y.id))) return true;
      return false;
    };
    const disjoint = (a: Unit, b: Unit) => {
      for (const p of a.platforms) if (b.platforms.has(p)) return false;
      return true;
    };
    let n = 0;
    for (const [k, list] of buckets) {
      if (list.length < 2) continue;
      if (++n % SLICE === 0) await tick();
      const kind = k.slice(0, 2) as keyof typeof BUCKET_MAX;
      if (list.length > BUCKET_MAX[kind]) continue;
      for (let x = 0; x < list.length; x++)
        for (let y = x + 1; y < list.length; y++) {
          const a = list[x];
          const b = list[y];
          const ua = units[a];
          const ub = units[b];
          if ((kind === 'nm' || kind === 'un') && !disjoint(ua, ub)) continue;
          const ek = a < b ? `${a}|${b}` : `${b}|${a}`;
          if (blocked.has(ek)) continue;
          let e = edges.get(ek);
          if (!e) {
            if (isDismissed(ua, ub)) {
              blocked.add(ek);
              continue;
            }
            e = { a: Math.min(a, b), b: Math.max(a, b), parts: new Map(), strong: false };
            edges.set(ek, e);
          }
          const v = k.slice(3);
          if (kind === 'ph') {
            e.parts.set('Aynı telefon numarası', SCORE.phone);
            e.strong = true;
          } else if (kind === 'em') {
            e.parts.set('Aynı e-posta adresi', SCORE.email);
            e.strong = true;
          } else if (kind === 'un') e.parts.set(`Aynı kullanıcı adı (@${v})`, SCORE.user);
          else e.parts.set('Aynı ad', SCORE.name);
        }
    }
    const live = [...edges.values()];
    const scoreOf = (e: Edge) => Math.min(0.99, 1 - [...e.parts.values()].reduce((p, s) => p * (1 - s), 1));

    // 4) bileşenler (birleşim-bul); çok büyük bileşen yalnız güçlü kenarlarla yeniden, olmazsa atılır
    const components = (list: Edge[]): number[][] => {
      const parent = new Map<number, number>();
      const find = (x: number): number => {
        let r = x;
        while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
        let c = x;
        while (c !== r) {
          const nx = parent.get(c)!;
          parent.set(c, r);
          c = nx;
        }
        return r;
      };
      for (const e of list) {
        if (!parent.has(e.a)) parent.set(e.a, e.a);
        if (!parent.has(e.b)) parent.set(e.b, e.b);
        const ra = find(e.a);
        const rb = find(e.b);
        if (ra !== rb) parent.set(ra, rb);
      }
      const groups = new Map<number, number[]>();
      for (const x of parent.keys()) {
        const r = find(x);
        groups.set(r, [...(groups.get(r) ?? []), x]);
      }
      return [...groups.values()];
    };
    const out: PersonSuggestion[] = [];
    const build = (members: number[], list: Edge[]) => {
      const set = new Set(members);
      const inner = list.filter((e) => set.has(e.a) && set.has(e.b));
      const strongGroups = components(inner.filter((e) => e.strong));
      const strong = strongGroups.length === 1 && strongGroups[0].length === members.length;
      const best = new Map<number, number>();
      const reasons = new Map<string, number>();
      for (const e of inner) {
        const s = scoreOf(e);
        best.set(e.a, Math.max(best.get(e.a) ?? 0, s));
        best.set(e.b, Math.max(best.get(e.b) ?? 0, s));
        for (const [r, v] of e.parts) reasons.set(r, Math.max(reasons.get(r) ?? 0, v));
      }
      const us = members.map((i) => units[i]).sort((a, b) => b.lastAt - a.lastAt);
      const uids = us.map((u) => u.uid).sort();
      const chats = us.flatMap((u) => u.chats.map(toPersonChat)).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      const person = us.find((u) => u.personId);
      const personName = person ? (this.store.sql('SELECT name FROM people WHERE id = ?').get(person.personId) as { name?: string } | undefined)?.name : undefined;
      out.push({
        key: createHash('sha1').update(uids.join('\n')).digest('hex').slice(0, 16),
        score: Math.round(Math.min(...members.map((i) => best.get(i) ?? 0)) * 100) / 100,
        strong,
        reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r),
        name: personName || bestName(us.flatMap((u) => u.display)),
        personId: person?.personId,
        chatIds: chats.map((c) => c.id),
        chats,
      });
    };
    // Bileşende güçlü (telefon/e-posta) alt gruplar varsa önce onlar ayrı ve "güçlü" önerilir; yalnız adla/kullanıcı adıyla
    // bağlı birimler, güçlü grup birleşince (kişi birimi olarak) bir sonraki hesapta önerilir. Güçlü grup yoksa bileşen bütün.
    for (const comp of components(live)) {
      const set = new Set(comp);
      const strongOnly = live.filter((e) => e.strong && set.has(e.a) && set.has(e.b));
      const strongSubs = components(strongOnly).filter((sub) => sub.length >= 2);
      if (!strongSubs.length || (strongSubs.length === 1 && strongSubs[0].length === comp.length)) {
        if (comp.length <= COMPONENT_MAX) build(comp, live);
        continue;
      }
      for (const sub of strongSubs) if (sub.length <= COMPONENT_MAX) build(sub, strongOnly);
    }
    out.sort((a, b) => Number(b.strong) - Number(a.strong) || b.score - a.score || (b.chats[0]?.lastMessageAt ?? 0) - (a.chats[0]?.lastMessageAt ?? 0));
    this.suggestions = out.slice(0, SUGGESTION_MAX);
    this.computedAt = Date.now();
    const sig = this.suggestions.map((s) => s.key).join(',');
    if (sig !== this.lastSig || autoLink.length) {
      this.lastSig = sig;
      bus.emit({ type: 'people.update' });
    }
    // reddedilen çiftlerden sohbeti silinmiş olanlar (tablo büyümesin)
    if (dismissed.size > 2000)
      this.store.sql('DELETE FROM people_dismissed WHERE a NOT IN (SELECT id FROM chats) OR b NOT IN (SELECT id FROM chats)').run();
    const ms = Date.now() - t0;
    if (ms > 500 || out.length) bus.log('info', `Kişi önerileri: ${rows.length} birebir sohbet, ${out.length} öneri (${ms} ms)`);
  }
}
