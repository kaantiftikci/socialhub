import type { Chat, Platform } from './types';
import type { PersonChat, PersonSuggestion } from './people-api';

/**
 * Kişi birleştirme öneri motorunun arayüz kopyası (çekirdek: packages/core/src/people.ts — kurallar AYNI kalmalı).
 * Yalnız statik demoda kullanılır (çekirdek yok). Kimlik anahtarı kovaları → kova içi çiftler → bileşenler.
 */

export const PEOPLE_EXCLUDED = new Set<Platform>(['shopier', 'trendyol', 'hepsiburada', 'etsy', 'shopify', 'n11', 'amazon', 'pttavm']);
const MAIL = new Set<Platform>(['gmail', 'outlook', 'yahoo', 'yandex', 'icloud', 'imap']);
const USERNAME_PLATFORMS = new Set<Platform>(['instagram', 'x', 'tiktok', 'telegram']);
const NAME_RANK: Partial<Record<Platform, number>> = { imessage: 0, whatsapp: 1, telegram: 2, instagram: 3, linkedin: 3, messenger: 3, x: 4, tiktok: 4, slack: 4 };

export function normalizePhone(raw?: string | null, cc = '90'): string | undefined {
  if (!raw || /[a-z@]/i.test(raw)) return undefined;
  let d = raw.trim().replace(/[^\d+]/g, '');
  if (!d) return undefined;
  if (d.startsWith('+')) d = d.slice(1).replace(/\+/g, '');
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = cc + d.slice(1);
  else if (d.length === 10 && d.startsWith('5')) d = cc + d;
  return /^[1-9]\d{7,14}$/.test(d) ? '+' + d : undefined;
}

export function normalizeEmail(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim().toLowerCase().replace(/^mailto:/, '');
  const m = /<([^>]+)>/.exec(s);
  if (m) s = m[1].trim();
  return /^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i.test(s) ? s.replace(/@googlemail\.com$/, '@gmail.com') : undefined;
}

export function normalizeUsername(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim().replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9._]{3,40}$/.test(s) && /[a-z]/.test(s) ? s : undefined;
}

const TITLES = new Set(['dr', 'doc', 'prof', 'av', 'uzm', 'muh', 'sn', 'sayin', 'bey', 'hanim', 'hn', 'bay', 'bayan', 'mr', 'mrs', 'ms', 'miss', 'sir', 'op', 'ogr', 'gor', 'yrd', 'dt', 'ecz', 'vet', 'abi', 'abla', 'hoca', 'hocam', 'ustam', 'usta', 'amca', 'teyze', 'dayi', 'eng']);
const GENERIC = new Set(['kisisi whatsapp', 'instagram user', 'instagram kullanicisi', 'facebook kullanicisi', 'facebook user', 'kisi bilinmeyen', 'linkedin member', 'linkedin uyesi', 'deleted account', 'hesap silinmis', 'kendine notlar']);
const fold = (s: string) => s.normalize('NFKC').toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/\p{M}+/gu, '');

export function nameKey(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const words: string[] = [];
  for (const tok of fold(raw).split(/[\s,;|/]+/)) {
    if (!tok || /\d/.test(tok)) continue;
    const w = tok.replace(/[^\p{L}]/gu, '');
    if (w.length >= 2 && !TITLES.has(w)) words.push(w);
  }
  const u = [...new Set(words)].sort();
  if (u.length < 2 || u.length > 5) return undefined;
  const k = u.join(' ');
  return GENERIC.has(k) ? undefined : k;
}

const AUTOMATED_MAIL = /(^|[._+-])(no-?reply|noreply|donotreply|do-not-reply|notifications?|bildirim|mailer-daemon|bounce|newsletter|bulten|info|support|destek|hello|team|news|marketing|kampanya)([._+-]|@)/i;
const hasLetters = (s: string) => /\p{L}{2,}/u.test(s);

interface Ident {
  phones: string[];
  emails: string[];
  users: string[];
  name?: string;
  display?: string;
  mailAddr?: string;
}

export function chatIdentity(c: Chat): Ident {
  const out: Ident = { phones: [], emails: [], users: [] };
  const addP = (v?: string) => {
    const p = normalizePhone(v);
    if (p && !out.phones.includes(p)) out.phones.push(p);
  };
  const addE = (v?: string) => {
    const e = normalizeEmail(v);
    if (e && !out.emails.includes(e)) out.emails.push(e);
  };
  let display = c.name;
  if (c.platform === 'whatsapp') {
    const m = /^(\d{6,15})@s\.whatsapp\.net$/.exec(c.remoteId);
    if (m) addP('+' + m[1]);
    if (c.handle?.startsWith('+')) addP(c.handle);
  } else if (c.platform === 'imessage') {
    const ident = (c.remoteId.includes(';-;') ? c.remoteId.split(';-;')[1] : c.handle ?? '').replace(/\((filtered|smsft)\)$/, '');
    if (ident.includes('@')) addE(ident);
    else addP(ident);
    if (c.handle?.startsWith('+')) addP(c.handle);
  } else if (MAIL.has(c.platform)) {
    const addr = normalizeEmail(c.handle);
    display = '';
    if (addr) {
      out.mailAddr = addr;
      out.emails.push(addr);
      if (!AUTOMATED_MAIL.test(addr)) {
        const p = c.participants?.find((x) => normalizeEmail(x.handle ?? x.id) === addr);
        if (p?.name && !p.name.includes('@')) display = p.name;
      }
    }
  } else if (c.handle?.startsWith('+')) addP(c.handle);
  const meta = c.meta ?? {};
  if (typeof meta.phone === 'string') addP(meta.phone);
  if (USERNAME_PLATFORMS.has(c.platform) && c.handle?.startsWith('@')) {
    const u = normalizeUsername(c.handle);
    if (u) out.users.push(u);
  }
  if (display && hasLetters(display)) {
    out.display = display.trim();
    out.name = nameKey(display);
  }
  return out;
}

export const personChat = (c: Chat): PersonChat => ({ id: c.id, accountId: c.accountId, platform: c.platform, name: c.name, handle: c.handle, avatarUrl: c.avatarUrl, lastMessageAt: c.lastMessageAt });

export function bestName(list: Array<{ name: string; platform: Platform }>): string {
  const full = (s: string) => (s.trim().split(/\s+/).length >= 2 ? 0 : 1);
  const ok = list.filter((d) => hasLetters(d.name)).sort((x, y) => full(x.name) - full(y.name) || (NAME_RANK[x.platform] ?? 5) - (NAME_RANK[y.platform] ?? 5) || y.name.length - x.name.length);
  return ok[0]?.name ?? list[0]?.name ?? 'Kişi';
}

/** Kişi adı önerisi (sohbetlerin görünen adlarından; e-postada karşı tarafın adı) */
export const defaultPersonName = (chats: Chat[]) => bestName(chats.map((c) => ({ name: chatIdentity(c).display ?? c.name, platform: c.platform })));

export const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

interface Unit {
  uid: string;
  personId?: string;
  chats: Chat[];
  platforms: Set<Platform>;
  keys: Map<string, 'ph' | 'em' | 'un' | 'nm'>;
  display: Array<{ name: string; platform: Platform }>;
  lastAt: number;
}

const SCORE = { ph: 0.97, em: 0.95, un: 0.75, nm: 0.6 } as const;
const BUCKET_MAX = { ph: 12, em: 12, un: 6, nm: 6 } as const;
const COMPONENT_MAX = 8;

function hashKey(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1234567;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 + s.charCodeAt(i), 2654435761);
  }
  return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(16, '0').slice(0, 16);
}

/** Öneriler: links = sohbet → kişi, dismissed = reddedilen sohbet çiftleri (pairKey), personName = kişi adı */
export function computeSuggestions(chats: Chat[], links: Map<string, string>, dismissed: Set<string>, personName: (id: string) => string | undefined): PersonSuggestion[] {
  const units: Unit[] = [];
  const byUid = new Map<string, Unit>();
  const personMail = new Map<string, string>();
  const direct = chats.filter((c) => c.kind === 'direct' && !PEOPLE_EXCLUDED.has(c.platform));
  const idents = new Map(direct.map((c) => [c.id, chatIdentity(c)]));
  for (const c of direct) {
    const id = idents.get(c.id)!;
    if (links.has(c.id) && id.mailAddr) personMail.set(id.mailAddr, links.get(c.id)!);
  }
  for (const c of direct) {
    const id = idents.get(c.id)!;
    const pid = links.get(c.id) ?? (id.mailAddr ? personMail.get(id.mailAddr) : undefined);
    const uid = pid ? `p:${pid}` : id.mailAddr ? `e:${id.mailAddr}` : `c:${c.id}`;
    let u = byUid.get(uid);
    if (!u) {
      u = { uid, personId: pid, chats: [], platforms: new Set(), keys: new Map(), display: [], lastAt: 0 };
      byUid.set(uid, u);
      units.push(u);
    }
    u.chats.push(c);
    u.platforms.add(c.platform);
    for (const p of id.phones) u.keys.set(`ph:${p}`, 'ph');
    for (const e of id.emails) u.keys.set(`em:${e}`, 'em');
    for (const x of id.users) u.keys.set(`un:${x}`, 'un');
    if (id.name) u.keys.set(`nm:${id.name}`, 'nm');
    if (id.display) u.display.push({ name: id.display, platform: c.platform });
    u.lastAt = Math.max(u.lastAt, c.lastMessageAt);
  }
  const buckets = new Map<string, number[]>();
  units.forEach((u, i) => {
    for (const k of u.keys.keys()) buckets.set(k, [...(buckets.get(k) ?? []), i]);
  });
  type Edge = { a: number; b: number; parts: Map<string, number>; strong: boolean };
  const edges = new Map<string, Edge>();
  const blocked = new Set<string>();
  const disjoint = (a: Unit, b: Unit) => [...a.platforms].every((p) => !b.platforms.has(p));
  const isDismissed = (a: Unit, b: Unit) => a.chats.some((x) => b.chats.some((y) => dismissed.has(pairKey(x.id, y.id))));
  for (const [k, list] of buckets) {
    const kind = k.slice(0, 2) as keyof typeof BUCKET_MAX;
    if (list.length < 2 || list.length > BUCKET_MAX[kind]) continue;
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) {
        const [a, b] = [Math.min(list[x], list[y]), Math.max(list[x], list[y])];
        if ((kind === 'nm' || kind === 'un') && !disjoint(units[a], units[b])) continue;
        const ek = `${a}|${b}`;
        if (blocked.has(ek)) continue;
        let e = edges.get(ek);
        if (!e) {
          if (isDismissed(units[a], units[b])) {
            blocked.add(ek);
            continue;
          }
          e = { a, b, parts: new Map(), strong: false };
          edges.set(ek, e);
        }
        const v = k.slice(3);
        const label = kind === 'ph' ? 'Aynı telefon numarası' : kind === 'em' ? 'Aynı e-posta adresi' : kind === 'un' ? `Aynı kullanıcı adı (@${v})` : 'Aynı ad';
        e.parts.set(label, SCORE[kind]);
        if (kind === 'ph' || kind === 'em') e.strong = true;
      }
  }
  const live = [...edges.values()];
  const scoreOf = (e: Edge) => Math.min(0.99, 1 - [...e.parts.values()].reduce((p, s) => p * (1 - s), 1));
  const components = (list: Edge[]): number[][] => {
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      while (parent.get(x) !== x) x = parent.get(x)!;
      return x;
    };
    for (const e of list) {
      if (!parent.has(e.a)) parent.set(e.a, e.a);
      if (!parent.has(e.b)) parent.set(e.b, e.b);
      const ra = find(e.a);
      const rb = find(e.b);
      if (ra !== rb) parent.set(ra, rb);
    }
    const g = new Map<number, number[]>();
    for (const x of parent.keys()) g.set(find(x), [...(g.get(find(x)) ?? []), x]);
    return [...g.values()];
  };
  const out: PersonSuggestion[] = [];
  const build = (members: number[], list: Edge[]) => {
    const set = new Set(members);
    const inner = list.filter((e) => set.has(e.a) && set.has(e.b));
    const sg = components(inner.filter((e) => e.strong));
    const best = new Map<number, number>();
    const reasons = new Map<string, number>();
    for (const e of inner) {
      const s = scoreOf(e);
      best.set(e.a, Math.max(best.get(e.a) ?? 0, s));
      best.set(e.b, Math.max(best.get(e.b) ?? 0, s));
      for (const [r, v] of e.parts) reasons.set(r, Math.max(reasons.get(r) ?? 0, v));
    }
    const us = members.map((i) => units[i]).sort((a, b) => b.lastAt - a.lastAt);
    const pcs = us.flatMap((u) => u.chats.map(personChat)).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    const person = us.find((u) => u.personId);
    out.push({
      key: hashKey(us.map((u) => u.uid).sort().join('\n')),
      score: Math.round(Math.min(...members.map((i) => best.get(i) ?? 0)) * 100) / 100,
      strong: sg.length === 1 && sg[0].length === members.length,
      reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r),
      name: (person?.personId && personName(person.personId)) || bestName(us.flatMap((u) => u.display)),
      personId: person?.personId,
      chatIds: pcs.map((c) => c.id),
      chats: pcs,
    });
  };
  for (const comp of components(live)) {
    const set = new Set(comp);
    const strongOnly = live.filter((e) => e.strong && set.has(e.a) && set.has(e.b));
    const subs = components(strongOnly).filter((s) => s.length >= 2);
    if (!subs.length || (subs.length === 1 && subs[0].length === comp.length)) {
      if (comp.length <= COMPONENT_MAX) build(comp, live);
      continue;
    }
    for (const sub of subs) if (sub.length <= COMPONENT_MAX) build(sub, strongOnly);
  }
  return out.sort((a, b) => Number(b.strong) - Number(a.strong) || b.score - a.score || (b.chats[0]?.lastMessageAt ?? 0) - (a.chats[0]?.lastMessageAt ?? 0));
}
