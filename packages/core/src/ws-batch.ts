import type { Chat, CoreEvent, Message } from './model.js';

/**
 * Arayüze (WS) giden olay demeti. Geçmiş eşitlemesinde çekirdek saniyede binlerce olay üretir; eskiden her biri ayrı
 * çerçeveydi ve her `message.upsert` sohbetin TAMAMINI (büyük gruplarda yüzlerce katılımcı) taşıyordu → WS tamponu 8 MB'ı
 * aşıp arayüz bağlantısı düşüyor, arayüz yeniden bağlanıp tüm listeyi baştan çekiyordu ("kendini sürekli eşitliyor" görüntüsü)
 * ve olay döngüsü JSON üretmekle kilitleniyordu. Demet: kısa pencerede (≈40 ms) biriken olaylar tek çerçevede, her sohbet
 * en son haliyle yalnız BİR kez; mesaj olayları sohbetsiz; aynı hesabın durum/ilerleme olaylarından yalnız sonuncusu.
 */
export interface WsBatch {
  type: 'batch';
  /** Değişen sohbetler (son hali, sohbet başına bir kez) */
  chats: Chat[];
  /** Silinen sohbet kimlikleri */
  deletes: string[];
  /** Sıralı diğer olaylar; message.upsert burada `chat` alanı OLMADAN gelir (sohbet `chats` içinde ya da arayüzde zaten var) */
  events: Array<CoreEvent | { type: 'message.upsert'; message: Message; live?: boolean }>;
  /** Bu demette çok sayıda geçmiş mesajı yazılan sohbetler: açıksa arayüz mesajları depodan yeniden okusun */
  refetch?: string[];
}

/** Bir demette tek tek gönderilecek en çok geçmiş (canlı olmayan) mesaj olayı; fazlası `refetch` ile özetlenir */
export const QUIET_MSG_MAX = 150;
/** Demet başına en çok günlük satırı (eşitlemede günlük de patlıyor) */
const LOG_MAX = 80;

export class EventBatcher {
  private chats = new Map<string, Chat>();
  private deletes = new Set<string>();
  private events: Array<WsBatch['events'][number] | null> = [];
  /** Birleştirilen olayların (hesap durumu, ilerleme, yazıyor) demetteki yeri: yenisi gelince eskisi silinir */
  private slots = new Map<string, number>();
  private refetch = new Set<string>();
  private quiet = 0;
  private logs = 0;
  /** Bu demette `messages.read` gelen sohbetler: sohbetin son hali olayların SONUNA da eklenir (take) */
  private readChats = new Set<string>();

  get empty(): boolean {
    return !this.chats.size && !this.deletes.size && !this.events.length && !this.refetch.size;
  }

  /** Aynı anahtarlı önceki olayı düşür, yenisini sona ekle (sıra: en son olay en sonda) */
  private replace(key: string, ev: WsBatch['events'][number]): void {
    const at = this.slots.get(key);
    if (at !== undefined) this.events[at] = null;
    this.slots.set(key, this.events.length);
    this.events.push(ev);
  }

  push(ev: CoreEvent): void {
    switch (ev.type) {
      case 'chat.upsert':
        this.chats.set(ev.chat.id, ev.chat);
        this.deletes.delete(ev.chat.id);
        return;
      case 'chat.delete':
        this.chats.delete(ev.chatId);
        this.deletes.add(ev.chatId);
        return;
      case 'message.upsert': {
        this.chats.set(ev.chat.id, ev.chat);
        this.deletes.delete(ev.chat.id);
        if (ev.live) {
          this.events.push({ type: 'message.upsert', message: ev.message, live: true });
          return;
        }
        // aynı mesajın (durum/tepki güncellemesi) önceki olayı bu demette varsa yalnız sonuncusu gider
        const key = `m:${ev.message.id}`;
        if (this.slots.has(key)) {
          this.replace(key, { type: 'message.upsert', message: ev.message });
          return;
        }
        if (this.quiet >= QUIET_MSG_MAX) {
          this.refetch.add(ev.message.chatId);
          return;
        }
        this.quiet++;
        this.replace(key, { type: 'message.upsert', message: ev.message });
        return;
      }
      case 'account.status':
        this.replace(`a:${ev.account.id}`, ev);
        return;
      case 'account.sync':
        this.replace(`s:${ev.accountId}`, ev);
        return;
      case 'chat.typing':
        this.replace(`t:${ev.chatId}`, ev);
        return;
      case 'people.update':
        this.replace('people', ev);
        return;
      case 'messages.read':
        this.readChats.add(ev.chatId);
        this.events.push(ev);
        return;
      case 'log':
        if (this.logs >= LOG_MAX) return;
        this.logs++;
        this.events.push(ev);
        return;
      default:
        this.events.push(ev);
    }
  }

  /** Biriken demeti al ve sıfırla (boşsa undefined) */
  take(): WsBatch | undefined {
    if (this.empty) return undefined;
    // Arayüz demeti "önce sohbetler, sonra olaylar" diye açar; messages.read işleyicisi sohbeti arayüzdeki (henüz güncellenmemiş)
    // ESKİ halinden alıp "görüldü" tikiyle yeniden yazıyor → aynı demetteki taze sohbet (yeni önizleme/okunmamış) eziliyordu.
    // Tek tek olay döneminde sıra read → chat.upsert idi (taze hal sonda kazanıyordu): aynı sıra olayların sonuna eklenerek korunur.
    for (const id of this.readChats) {
      const c = this.chats.get(id);
      if (c) this.events.push({ type: 'chat.upsert', chat: c });
    }
    const batch: WsBatch = {
      type: 'batch',
      chats: [...this.chats.values()],
      deletes: [...this.deletes],
      events: this.events.filter((e): e is WsBatch['events'][number] => e !== null),
    };
    if (this.refetch.size) batch.refetch = [...this.refetch];
    this.chats.clear();
    this.deletes.clear();
    this.events = [];
    this.slots.clear();
    this.refetch.clear();
    this.readChats.clear();
    this.quiet = 0;
    this.logs = 0;
    return batch;
  }
}
