// Arayüz eşitleme birleştirmeleri (saf işlevler; App.tsx kullanır, birim testi packages/core/test/web-sync-merge.test.ts)
import type { Account, Chat, Message } from './types';

/**
 * Depodan taze okunan pencereyi (`fresh`, en yeni N mesaj) eldeki mesajlarla birleştirir. Eldekilerden yalnız taze
 * pencereden DAHA ESKİ olanlar ("Daha eski mesajlar" ile yüklenenler) ve pencereden daha yeni gerçek kayıtlar (okuma
 * sürerken WS'den gelenler) korunur. Pencerenin içine düşüp taze sonuçta olmayan kayıt çekirdekte silinmiştir (yerini
 * gerçek kaydın aldığı `local-` gönderim, WhatsApp ikizi…): geri getirilirse aynı metinli iki balon görünürdü.
 */
export function mergeFresh(prev: Message[], fresh: Message[], chatId: string, limit = 100): Message[] {
  const ids = new Set(fresh.map((x) => x.id));
  let floor = Infinity;
  let ceil = -Infinity;
  for (const x of fresh) {
    if (x.ts < floor) floor = x.ts;
    if (x.ts > ceil) ceil = x.ts;
  }
  // Pencere dolu geldiyse (limit) alt sınır aynı zaman damgalı bir kümenin ortasından kesilmiş olabilir (saniye hassasiyetli
  // WhatsApp/Telegram albümü): o damgadaki pencere dışı kayıtlar silinmiş değildir, korunur
  const cut = fresh.length >= limit;
  const keep = prev.filter((x) => x.chatId === chatId && !ids.has(x.id) && (x.ts < floor || (cut && x.ts === floor) || (x.ts > ceil && !x.remoteId.startsWith('local-'))));
  return [...keep, ...fresh].sort((x, y) => x.ts - y.ts);
}

/** Okundu alındısı: değişen mesaj yoksa aynı dizi döner (gereksiz yeniden çizim olmasın) */
export function applyRead(prev: Message[], before: number): Message[] {
  if (!prev.some((m) => m.fromMe && m.ts <= before && m.status !== 'read')) return prev;
  return prev.map((m) => (m.fromMe && m.ts <= before && m.status !== 'read' ? { ...m, status: 'read' as const } : m));
}

/** Hesap durumu olayı: içerik aynıysa önceki dizi döner */
export function applyAccount(prev: Account[], acc: Account): Account[] {
  const i = prev.findIndex((x) => x.id === acc.id);
  if (i < 0) return [...prev, acc];
  if (JSON.stringify(prev[i]) === JSON.stringify(acc)) return prev;
  const next = [...prev];
  next[i] = acc;
  return next;
}

/** refresh() uçuştayken WS'den dokunulan kimlikler: anlık görüntü bunları eski halleriyle ezmesin */
export interface Touched {
  acc: Set<string>;
  chats: Set<string>;
  removedAcc: Set<string>;
}
export const newTouched = (): Touched => ({ acc: new Set(), chats: new Set(), removedAcc: new Set() });

/**
 * /api/accounts anlık görüntüsü + uçuş sırasında gelen olaylar: dokunulan hesapta güncel (prev) sürüm kalır, uçuşta
 * silinen geri gelmez, uçuşta eklenen korunur.
 */
export function mergeAccountsSnapshot(prev: Account[], snap: Account[], t: Touched): Account[] {
  const byId = new Map(prev.map((p) => [p.id, p]));
  const out: Account[] = [];
  for (const x of snap) {
    if (t.removedAcc.has(x.id)) continue;
    if (t.acc.has(x.id)) {
      const cur = byId.get(x.id);
      if (cur) out.push(cur);
      continue;
    }
    out.push(x);
  }
  for (const p of prev) if (t.acc.has(p.id) && !t.removedAcc.has(p.id) && !out.some((o) => o.id === p.id)) out.push(p);
  return out;
}

/** /api/chats anlık görüntüsü + uçuş sırasında gelen sohbet olayları (aynı kural) */
export function mergeChatsSnapshot(prev: Map<string, Chat>, snap: Chat[], t: Touched): Map<string, Chat> {
  const n = new Map<string, Chat>();
  for (const x of snap) if (!t.removedAcc.has(x.accountId)) n.set(x.id, x);
  for (const id of t.chats) {
    const cur = prev.get(id);
    if (cur && !t.removedAcc.has(cur.accountId)) n.set(id, cur);
    else n.delete(id);
  }
  return n;
}
