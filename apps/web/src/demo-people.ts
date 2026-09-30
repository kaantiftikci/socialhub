import { demoPeopleSource as src } from './static-demo';
import { computeSuggestions, defaultPersonName, normalizeEmail, pairKey, PEOPLE_EXCLUDED, personChat } from './people-match';
import type { Person, PersonSuggestion, Timeline } from './people-api';
import type { Chat } from './types';

/**
 * Statik demoda kişi birleştirme (çekirdek yok): kişiler/bağlar/reddedilenler bu tarayıcıda (localStorage mivelo.demoPeople).
 * Örnek veride Ayşe Demir (WhatsApp + Instagram + Outlook) hazır birleşik gelir; öneriler people-match.ts ile hesaplanır.
 * Kayıtla gelen "fresh" üyede örnek sohbet olmadığından kişi/öneri de yoktur.
 */

interface DemoState {
  people: Array<{ id: string; name: string; createdAt: number }>;
  links: Array<[string, string]>;
  dismissed: string[];
  seeded?: boolean;
}

const KEY = 'mivelo.demoPeople';
let state: DemoState | null = null;
const MAIL = new Set(['gmail', 'outlook', 'yahoo', 'yandex', 'icloud', 'imap']);

function load(): DemoState {
  if (state) return state;
  try {
    state = JSON.parse(localStorage.getItem(KEY) || 'null') as DemoState | null;
  } catch {
    state = null;
  }
  state ??= { people: [], links: [], dismissed: [] };
  return state;
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* depolama kapalı: bu oturumda bellekte */
  }
}

const chatMap = () => new Map(src.chats().map((c) => [c.id, c]));

/** Örnek birleşik kişi (bir kez): Ayşe Demir */
function ensureSeed(): void {
  const s = load();
  if (s.seeded || src.fresh()) return;
  const all = src.chats();
  if (!all.length) return;
  const pick = (platform: string, remoteId: string) => all.find((c) => c.platform === platform && c.remoteId === remoteId)?.id;
  const ids = [pick('whatsapp', 'ayse'), pick('instagram', 'ayse-demir'), pick('outlook', 'teklif')].filter((x): x is string => !!x);
  s.seeded = true;
  if (ids.length >= 2) {
    const id = 'p_demo_ayse';
    s.people.push({ id, name: 'Ayşe Demir', createdAt: Date.now() });
    for (const c of ids) s.links.push([c, id]);
  }
  save();
}

function links(): Map<string, string> {
  const live = chatMap();
  return new Map(load().links.filter(([c]) => live.has(c)));
}

function list(): Person[] {
  ensureSeed();
  const s = load();
  const live = chatMap();
  const byPerson = new Map<string, Chat[]>();
  for (const [c, p] of links()) byPerson.set(p, [...(byPerson.get(p) ?? []), live.get(c)!]);
  return s.people
    .map((p) => {
      const chats = (byPerson.get(p.id) ?? []).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      return { id: p.id, name: p.name, createdAt: p.createdAt, avatarUrl: chats.find((c) => c.avatarUrl)?.avatarUrl, chats: chats.map(personChat) };
    })
    .filter((p) => p.chats.length >= 2);
}

function suggestions(): PersonSuggestion[] {
  ensureSeed();
  const s = load();
  return computeSuggestions(src.chats(), links(), new Set(s.dismissed), (id) => s.people.find((p) => p.id === id)?.name);
}

function changed(): void {
  save();
  src.emit({ type: 'people.update' });
}

function merge(chatIds: string[], opts: { personId?: string; name?: string } = {}): Person {
  ensureSeed();
  const s = load();
  const live = chatMap();
  const ids = [...new Set(chatIds)];
  for (const id of ids) {
    const c = live.get(id);
    if (!c) throw new Error('Sohbet yok');
    if (c.kind !== 'direct') throw new Error('Yalnız birebir sohbetler bir kişiye bağlanabilir');
    if (PEOPLE_EXCLUDED.has(c.platform)) throw new Error('Pazaryeri sohbetleri kişiye bağlanmaz');
  }
  // e-posta: aynı adresli diziler birlikte
  for (const id of [...ids]) {
    const c = live.get(id)!;
    const addr = MAIL.has(c.platform) ? normalizeEmail(c.handle) : undefined;
    if (addr) for (const o of live.values()) if (MAIL.has(o.platform) && o.kind === 'direct' && normalizeEmail(o.handle) === addr && !ids.includes(o.id)) ids.push(o.id);
  }
  const lk = links();
  const existing = new Set<string>([...(opts.personId ? [opts.personId] : []), ...ids.map((c) => lk.get(c)).filter((x): x is string => !!x)]);
  const target = opts.personId ?? [...existing][0] ?? `p_${Math.random().toString(36).slice(2, 10)}`;
  const current = [...lk].filter(([, p]) => p === target).map(([c]) => c);
  if (new Set([...ids, ...current]).size < 2) throw new Error('Birleştirmek için en az iki sohbet gerekli');
  if (!s.people.some((p) => p.id === target)) s.people.push({ id: target, name: opts.name?.trim() || defaultPersonName(ids.map((c) => live.get(c)!)), createdAt: Date.now() });
  const others = new Set([...existing].filter((p) => p !== target));
  s.links = s.links.map(([c, p]) => [c, others.has(p) ? target : p] as [string, string]).filter(([c]) => !ids.includes(c));
  for (const c of ids) s.links.push([c, target]);
  s.people = s.people.filter((p) => !others.has(p.id));
  changed();
  return list().find((p) => p.id === target)!;
}

function unlink(personId: string, chatId: string): Person | null {
  const s = load();
  const person = list().find((p) => p.id === personId);
  const chat = person?.chats.find((c) => c.id === chatId);
  if (!person || !chat) throw new Error('Sohbet bu kişiye bağlı değil');
  const addr = MAIL.has(chat.platform) ? normalizeEmail(chat.handle) : undefined;
  const gone = person.chats.filter((c) => c.id === chatId || (addr && MAIL.has(c.platform) && normalizeEmail(c.handle) === addr)).map((c) => c.id);
  const stay = person.chats.map((c) => c.id).filter((c) => !gone.includes(c));
  s.links = s.links.filter(([c]) => !gone.includes(c));
  for (const g of gone) for (const k of stay) s.dismissed.push(pairKey(g, k));
  if (stay.length < 2) {
    s.links = s.links.filter(([, p]) => p !== personId);
    s.people = s.people.filter((p) => p.id !== personId);
  }
  changed();
  return list().find((p) => p.id === personId) ?? null;
}

function dismiss(key: string): { ok: boolean } {
  const sg = suggestions().find((x) => x.key === key);
  if (!sg) return { ok: false };
  const s = load();
  const lk = links();
  // birim grupları: kişi → tüm sohbetleri; e-posta adresi → dizileri; diğerleri tek tek
  const groups = new Map<string, string[]>();
  for (const c of sg.chats) {
    const g = lk.get(c.id) ?? (MAIL.has(c.platform) && normalizeEmail(c.handle) ? `e:${normalizeEmail(c.handle)}` : c.id);
    groups.set(g, [...(groups.get(g) ?? []), c.id]);
  }
  const gs = [...groups.values()];
  for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) for (const x of gs[i]) for (const y of gs[j]) s.dismissed.push(pairKey(x, y));
  changed();
  return { ok: true };
}

function timeline(personId: string, before?: number, limit = 100): Timeline {
  const person = list().find((p) => p.id === personId);
  if (!person) throw new Error('Kişi yok');
  const ids = new Map(person.chats.map((c) => [c.id, c]));
  const all = src
    .messages()
    .filter((m) => ids.has(m.chatId) && (before == null || m.ts < before))
    .sort((a, b) => a.ts - b.ts);
  const page = all.slice(-limit).map((m) => ({ ...m, platform: ids.get(m.chatId)!.platform, accountId: ids.get(m.chatId)!.accountId }));
  return { messages: page, hasMore: all.length > limit, chats: person.chats };
}

export const demoPeopleApi = {
  list: async () => list(),
  suggestions: async () => ({ suggestions: suggestions(), computedAt: Date.now() }),
  merge: async (chatIds: string[], opts: { personId?: string; name?: string } = {}) => merge(chatIds, opts),
  mergeSuggestion: async (key: string) => {
    const s = suggestions().find((x) => x.key === key);
    if (!s) throw new Error('Öneri yok (listeyi yenileyin)');
    return merge(s.chatIds, { personId: s.personId });
  },
  mergeAllStrong: async () => {
    let merged = 0;
    for (const s of suggestions().filter((x) => x.strong)) {
      try {
        merge(s.chatIds, { personId: s.personId });
        merged++;
      } catch {
        /* değişmiş öneri */
      }
    }
    return { merged };
  },
  dismiss: async (key: string) => dismiss(key),
  unlink: async (personId: string, chatId: string) => ({ person: unlink(personId, chatId) }),
  rename: async (personId: string, name: string) => {
    const p = load().people.find((x) => x.id === personId);
    if (!p || !name.trim()) throw new Error('Kişi yok');
    p.name = name.trim().slice(0, 80);
    changed();
    return list().find((x) => x.id === personId)!;
  },
  timeline: async (personId: string, before?: number, limit = 100) => timeline(personId, before, limit),
};
