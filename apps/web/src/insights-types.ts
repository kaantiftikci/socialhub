import type { Attachment, Platform } from './types';

/* Raporum (packages/core/src/stats.ts) ve Medya kütüphanesi (packages/core/src/library.ts) sözleşmesi — çekirdektekiyle aynı kalmalı */

export type StatsRange = 'month' | 'year' | 'all';

export interface WrappedPerson {
  chatId: string;
  name: string;
  platform: Platform;
  avatarUrl?: string;
  sent: number;
  received: number;
  total: number;
  medianReplyMs?: number;
}

export interface WrappedStats {
  range: StatsRange;
  platform?: string | null;
  at: string;
  label: string;
  from: number;
  to: number;
  current: boolean;
  computedAt: number;
  tookMs: number;
  totals: { sent: number; received: number; total: number; chats: number; people: number; activeDays: number; days: number };
  platforms: Array<{ platform: Platform; sent: number; received: number; total: number }>;
  people: WrappedPerson[];
  groups: WrappedPerson[];
  reply: { count: number; avgMs: number; medianMs: number; fastest?: WrappedPerson } | null;
  /** 7×24: gün×24 + saat, gün 0 = Pazartesi */
  heat: number[];
  cells?: Array<{ sent: number; platforms: Array<{ platform: string; n: number }>; people: Array<{ chatId: string; name: string; platform: string; avatarUrl?: string; kind: string; n: number }> } | null>;
  busiestHour: { hour: number; count: number } | null;
  busiestDay: { day: number; count: number } | null;
  streak: { longest: number; from?: string; to?: string; current: number };
  emojis: Array<{ emoji: string; count: number }>;
  night: { hour: number | null; count: number; share: number };
  profile: { kind: 'night' | 'early' | 'day'; nightShare: number; morningShare: number };
  change: { total: number | null; sent: number | null; received: number | null; prevTotal: number; prevLabel: string } | null;
  waiting: number;
}

export type LibKind = 'image' | 'video' | 'audio' | 'file' | 'link';

export interface LibItem {
  id: string;
  messageId: string;
  chatId: string;
  accountId: string;
  platform: Platform;
  kind: LibKind;
  ts: number;
  name: string;
  att: Attachment;
  senderName: string;
  fromMe: boolean;
  chatName: string;
  chatKind: string;
}

export interface LibQuery {
  kind?: LibKind;
  platform?: Platform;
  chat?: string;
  q?: string;
  before?: string;
  limit?: number;
}

export interface LibPage {
  items: LibItem[];
  next: string | null;
}

export interface LibFacets {
  kinds: Partial<Record<LibKind, number>>;
  platforms: Array<{ platform: Platform; count: number }>;
  chats: Array<{ chatId: string; name: string; platform: Platform; kind: string; count: number; lastTs: number }>;
  progress: { ready: boolean; pct: number; pending: number };
}

export function libQueryString(q: LibQuery): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  return sp.toString();
}

/** Ekin kütüphane türü (çekirdekteki kindOfAttachment ile aynı) */
export function libKindOf(a: Attachment): LibKind | undefined {
  if (!a || !(a.url || a.link || a.page)) return undefined;
  if (a.kind === 'image' || a.kind === 'video' || a.kind === 'audio') return a.kind;
  if (a.kind === 'file') return 'file';
  const target = a.page ?? a.link ?? '';
  return /^https?:\/\//i.test(target) && !/\.(pdf|zip|docx?|xlsx?|pptx?|csv|txt)(\?|$)/i.test(target) ? 'link' : 'file';
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
/** Metindeki bağlantılar (çekirdekteki extractLinks'in sade kopyası; demo için) */
export function linksOf(text: string, exclude: Set<string>): string[] {
  if (!text || !text.includes('http')) return [];
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;:!?]+$/, '');
    if (u.length < 12 || exclude.has(u) || out.includes(u)) continue;
    out.push(u);
    if (out.length >= 8) break;
  }
  return out;
}
