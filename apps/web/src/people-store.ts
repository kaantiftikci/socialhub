import { useSyncExternalStore } from 'react';
import { peopleApi, type Person, type PersonSuggestion } from './people-api';
import type { CoreEvent } from './types';

/**
 * Arayüzdeki kişi birleştirme durumu: kişiler, sohbet → kişi eşlemesi ve öneriler. App'in olay akışından `peopleOnEvent`
 * çağrılır (people.update → yeniden çek; zaman çizelgesi dinleyicileri message.upsert alır).
 */

export interface PeopleState {
  people: Person[];
  byChat: Map<string, Person>;
  suggestions: PersonSuggestion[];
  /** sohbet → o sohbeti içeren öneriler */
  suggestByChat: Map<string, PersonSuggestion[]>;
  loaded: boolean;
}

let state: PeopleState = { people: [], byChat: new Map(), suggestions: [], suggestByChat: new Map(), loaded: false };
const subs = new Set<() => void>();
const evSubs = new Set<(ev: CoreEvent) => void>();

function set(people: Person[], suggestions: PersonSuggestion[]): void {
  const byChat = new Map<string, Person>();
  for (const p of people) for (const c of p.chats) byChat.set(c.id, p);
  const suggestByChat = new Map<string, PersonSuggestion[]>();
  for (const s of suggestions) for (const c of s.chatIds) suggestByChat.set(c, [...(suggestByChat.get(c) ?? []), s]);
  state = { people, byChat, suggestions, suggestByChat, loaded: true };
  for (const fn of subs) fn();
}

let inflight: Promise<void> | null = null;
let again = false;
/** Kişileri ve önerileri yeniden çek (aynı anda tek istek; sürerken istenirse bitince bir kez daha) */
export function refreshPeople(): Promise<void> {
  if (inflight) {
    again = true;
    return inflight;
  }
  inflight = (async () => {
    try {
      do {
        again = false;
        const [people, sg] = await Promise.all([peopleApi.list(), peopleApi.suggestions().catch(() => ({ suggestions: state.suggestions }))]);
        set(people, sg.suggestions);
      } while (again);
    } catch {
      /* çekirdek eski sürüm ya da hazır değil: kişi özelliği sessizce boş kalır */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

let timer: number | undefined;
/** App'in olay işleyicisinden: kişi değişikliği ve zaman çizelgesi için mesaj olayları */
export function peopleOnEvent(ev: CoreEvent): void {
  if (ev.type === 'people.update' || ev.type === 'account.removed') {
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(() => void refreshPeople(), 250);
  }
  if (evSubs.size && (ev.type === 'message.upsert' || ev.type === 'message.delete' || ev.type === 'messages.read' || ev.type === 'messages.refetch'))
    for (const fn of evSubs) fn(ev);
}

/** Zaman çizelgesi gibi dinleyiciler için olay aboneliği */
export function onPeopleEvent(fn: (ev: CoreEvent) => void): () => void {
  evSubs.add(fn);
  return () => evSubs.delete(fn);
}

let started = false;
export function usePeople(): PeopleState {
  if (!started) {
    started = true;
    void refreshPeople();
  }
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => state,
  );
}
