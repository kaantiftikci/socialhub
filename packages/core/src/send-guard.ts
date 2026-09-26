import type { Platform } from './model.js';

/**
 * Gönderim güvenlik ağı (ban önleme). Resmi olmayan kanallarda hesabı kısıtlatan en yaygın desenler:
 * aynı metni kısa sürede çok kişiye göndermek (toplu/soğuk mesaj) ve günlük aşırı hacim. Normal kullanım bu
 * sınırlara yaklaşmaz; aşılırsa gönderim durdurulur ve kullanıcıya nedeni söylenir. E-posta ve pazaryeri (resmi
 * API) kanallarında uygulanmaz.
 */
export const DAILY_LIMIT: Partial<Record<Platform, number>> = {
  linkedin: 100, // LinkedIn Kullanıcı Sözleşmesi 8.2; profesyonel araçların güvenli üst sınırı ~100–150/gün
  x: 100, // X günlük DM tavanı 500; yeni kişilere çok daha az sürdürülebilir
  instagram: 150,
  messenger: 150,
  whatsapp: 500,
  telegram: 500,
  imessage: 300,
  slack: 1000,
};
/** Aynı metin bu süre içinde en çok bu kadar farklı sohbete gidebilir */
export const DUP_WINDOW_MS = 30 * 60_000;
export const DUP_MAX_CHATS = 5;
/** Bu uzunluğun altındaki kısa metinler ("tamam", "teşekkürler") tekrar sayılmaz */
const DUP_MIN_LEN = 16;

export class SendBlocked extends Error {}

type Rec = { day: string; count: number };
const daily = new Map<string, Rec>(); // accountId → bugünkü sayı
const recent = new Map<string, Array<{ at: number; chat: string }>>(); // accountId|metin → gönderimler

const norm = (t: string) => t.toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim().replace(/[.!?…,:;\s]+$/g, '');
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Gönderimden ÖNCE çağrılır: kurala takılırsa SendBlocked fırlatır, değilse gönderimi kaydeder. */
export function checkSend(o: { accountId: string; platform: Platform; chatId: string; text?: string; now?: number }): void {
  const limit = DAILY_LIMIT[o.platform];
  if (limit === undefined) return;
  const now = o.now ?? Date.now();
  const day = dayOf(now);
  const d = daily.get(o.accountId);
  const count = d && d.day === day ? d.count : 0;
  if (count >= limit)
    throw new SendBlocked(`Bugün bu hesaptan ${limit} mesaj gönderildi. Hesabının kısıtlanmaması için ${platformName(o.platform)} gönderimleri yarına kadar durduruldu.`);
  const text = o.text ? norm(o.text) : '';
  let key = '';
  let list: Array<{ at: number; chat: string }> = [];
  if (text.length >= DUP_MIN_LEN) {
    key = `${o.accountId}|${text}`;
    list = (recent.get(key) ?? []).filter((r) => now - r.at < DUP_WINDOW_MS);
    const chats = new Set(list.map((r) => r.chat));
    if (!chats.has(o.chatId) && chats.size >= DUP_MAX_CHATS)
      throw new SendBlocked(`Aynı mesaj son 30 dakikada ${chats.size} farklı kişiye gönderildi. Toplu mesaj ${platformName(o.platform)} hesabının kısıtlanmasına yol açabilir; metni kişiye göre değiştir ya da biraz bekle.`);
  }
  daily.set(o.accountId, { day, count: count + 1 });
  if (key) {
    list.push({ at: now, chat: o.chatId });
    recent.set(key, list);
  }
  // bellek sınırı: eski kayıtları ara sıra temizle
  if (recent.size > 2000) for (const [k, v] of recent) if (!v.some((r) => now - r.at < DUP_WINDOW_MS)) recent.delete(k);
}

/** Testler için sıfırla */
export function resetSendGuard(): void {
  daily.clear();
  recent.clear();
}

function platformName(p: Platform): string {
  return ({ linkedin: 'LinkedIn', x: 'X', instagram: 'Instagram', messenger: 'Messenger', whatsapp: 'WhatsApp', telegram: 'Telegram', imessage: 'iMessage', slack: 'Slack' } as Partial<Record<Platform, string>>)[p] ?? p;
}
