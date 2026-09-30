import { call, USE_STATIC } from './api';
import { demoPeopleApi } from './demo-people';
import type { Message, Platform } from './types';

/** Kişi birleştirme istemcisi (çekirdek packages/core/src/people.ts; statik demoda demo-people.ts) */

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
  /** bağlı birebir sohbetler, en yeni yazışma önce */
  chats: PersonChat[];
}

export interface PersonSuggestion {
  key: string;
  /** 0-1 güven */
  score: number;
  /** yalnız telefon/e-posta eşleşmesi ("Tümünü birleştir" yalnız bunlar) */
  strong: boolean;
  reasons: string[];
  name: string;
  personId?: string;
  chatIds: string[];
  chats: PersonChat[];
}

export type TimelineMessage = Message & { platform: Platform; accountId: string };
export interface Timeline {
  messages: TimelineMessage[];
  hasMore: boolean;
  chats: PersonChat[];
}

const enc = encodeURIComponent;

const livePeopleApi = {
  list: () => call<Person[]>('GET', '/people'),
  suggestions: () => call<{ suggestions: PersonSuggestion[]; computedAt: number }>('GET', '/people/suggestions'),
  merge: (chatIds: string[], opts: { personId?: string; name?: string } = {}) => call<Person>('POST', '/people', { chatIds, ...opts }),
  mergeSuggestion: (key: string) => call<Person>('POST', `/people/suggestions/${enc(key)}/merge`),
  mergeAllStrong: () => call<{ merged: number }>('POST', '/people/suggestions/merge-strong'),
  dismiss: (key: string) => call<{ ok: boolean }>('POST', `/people/suggestions/${enc(key)}/dismiss`),
  unlink: (personId: string, chatId: string) => call<{ person: Person | null }>('POST', `/people/${enc(personId)}/unlink`, { chatId }),
  rename: (personId: string, name: string) => call<Person>('POST', `/people/${enc(personId)}`, { name }),
  timeline: (personId: string, before?: number, limit = 100) => call<Timeline>('GET', `/people/${enc(personId)}/timeline?limit=${limit}${before ? `&before=${before}` : ''}`),
};

export type PeopleApi = typeof livePeopleApi;
export const peopleApi: PeopleApi = USE_STATIC ? demoPeopleApi : livePeopleApi;
