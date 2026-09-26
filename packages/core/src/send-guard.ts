import fs from 'node:fs';
import type { Platform } from './model.js';

/**
 * Gönderim güvenlik ağı (ban önleme). Resmi olmayan kanallarda hesabı kısıtlatan en yaygın desenler:
 * aynı metni kısa sürede çok kişiye göndermek (toplu/soğuk mesaj) ve günlük aşırı hacim. Normal kullanım bu
 * sınırlara yaklaşmaz; aşılırsa gönderim durdurulur ve kullanıcıya nedeni söylenir. E-posta ve pazaryeri (resmi
 * API) kanallarında uygulanmaz.
 */
/**
 * İki ayrı risk, iki ayrı sınır:
 * - NEW_LIMIT: karşı tarafın HİÇ yazmadığı sohbete giden mesajlar (soğuk mesaj / ilk temas). Platformların asıl kısıtladığı davranış
 *   bu (LinkedIn araçlarının güvenli önerisi günde ~30–50 yeni konuşma; WhatsApp/Telegram'da kişi olmayanlara ilk mesaj en sık kısıtlama
 *   nedeni). Sayı: o gün ilk mesaj atılan farklı sohbet.
 * - DAILY_LIMIT: tüm gönderimler (yanıtlar dahil) için yalnız güvenlik ağı — normal yazışma buna yaklaşmaz; hatalı bir döngüyü ya da
 *   olağandışı hacmi durdurur.
 */
export const DAILY_LIMIT: Partial<Record<Platform, number>> = {
  linkedin: 250,
  x: 300,
  instagram: 400,
  messenger: 400,
  imessage: 1000,
  whatsapp: 1500,
  telegram: 1500,
  slack: 3000,
};
export const NEW_LIMIT: Partial<Record<Platform, number>> = {
  linkedin: 30,
  telegram: 30, // kişi olmayanlara ilk mesaj Telegram'da "spam kısıtı"nın başlıca nedeni
  x: 50,
  instagram: 50,
  messenger: 50,
  whatsapp: 50,
  imessage: 100,
  slack: 200,
};
/** Aynı metin bu süre içinde en çok bu kadar farklı sohbete gidebilir */
export const DUP_WINDOW_MS = 30 * 60_000;
export const DUP_MAX_CHATS = 5;
/** Bu uzunluğun altındaki kısa metinler ("tamam", "teşekkürler") tekrar sayılmaz */
const DUP_MIN_LEN = 16;

export class SendBlocked extends Error {}

type Rec = { day: string; count: number; fresh: string[] };
const daily = new Map<string, Rec>(); // accountId → bugünkü sayılar
const recent = new Map<string, Array<{ at: number; chat: string }>>(); // accountId|metin → gönderimler
let dirty = () => undefined as void;

const norm = (t: string) => t.toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim().replace(/[.!?…,:;\s]+$/g, '');
/** Yerel takvim günü (Türkiye'de gece 00:00'da döner; eskiden UTC → 03:00) */
const dayOf = (now: number) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Gönderimden ÖNCE çağrılır: kurala takılırsa SendBlocked fırlatır, değilse gönderimi kaydeder.
 * isNew: karşı taraf bu sohbette hiç yazmamış (ilk temas) — sunucu depodaki mesajlardan belirler.
 */
export function checkSend(o: { accountId: string; platform: Platform; chatId: string; text?: string; now?: number; isNew?: boolean }): void {
  const limit = DAILY_LIMIT[o.platform];
  if (limit === undefined) return;
  const now = o.now ?? Date.now();
  const day = dayOf(now);
  const d = daily.get(o.accountId);
  const rec: Rec = d && d.day === day ? d : { day, count: 0, fresh: [] };
  const name = platformName(o.platform);
  if (rec.count >= limit) throw new SendBlocked(`Bugün bu hesaptan ${limit} mesaj gönderildi. Hesabının kısıtlanmaması için ${name} gönderimleri gece yarısına kadar durduruldu.`);
  const newLimit = NEW_LIMIT[o.platform];
  const firstToChat = !!o.isNew && !rec.fresh.includes(o.chatId);
  if (firstToChat && newLimit !== undefined && rec.fresh.length >= newLimit)
    throw new SendBlocked(
      `Bugün ${newLimit} farklı kişiye ilk mesaj (sana hiç yazmamış kişiler) gönderildi. ${name} bu tür soğuk mesajları kısıtlıyor; yeni kişilere gece yarısından sonra devam et. Sana yazan kişilere yanıt vermeye devam edebilirsin.`,
    );
  const text = o.text ? norm(o.text) : '';
  let key = '';
  let list: Array<{ at: number; chat: string }> = [];
  if (text.length >= DUP_MIN_LEN) {
    key = `${o.accountId}|${text}`;
    list = (recent.get(key) ?? []).filter((r) => now - r.at < DUP_WINDOW_MS);
    const chats = new Set(list.map((r) => r.chat));
    if (!chats.has(o.chatId) && chats.size >= DUP_MAX_CHATS)
      throw new SendBlocked(`Aynı mesaj son 30 dakikada ${chats.size} farklı kişiye gönderildi. Toplu mesaj ${name} hesabının kısıtlanmasına yol açabilir; metni kişiye göre değiştir ya da biraz bekle.`);
  }
  rec.count += 1;
  if (firstToChat) rec.fresh.push(o.chatId);
  daily.set(o.accountId, rec);
  if (key) {
    list.push({ at: now, chat: o.chatId });
    recent.set(key, list);
  }
  // bellek sınırı: eski kayıtları ara sıra temizle
  if (recent.size > 2000) for (const [k, v] of recent) if (!v.some((r) => now - r.at < DUP_WINDOW_MS)) recent.delete(k);
  dirty();
}

/** Bugünkü kullanım (arayüz/tanı için) */
export function sendUsage(accountId: string, platform: Platform, now = Date.now()): { sent: number; limit?: number; newChats: number; newLimit?: number } {
  const d = daily.get(accountId);
  const rec = d && d.day === dayOf(now) ? d : undefined;
  return { sent: rec?.count ?? 0, limit: DAILY_LIMIT[platform], newChats: rec?.fresh.length ?? 0, newLimit: NEW_LIMIT[platform] };
}

/**
 * Sayaçlar dosyada kalıcı (yeniden başlatma sınırı sıfırlamasın). Yazım 2 sn toplanır; yalnız bugünün kayıtları ve
 * 30 dk içindeki tekrar kayıtları saklanır.
 */
export function persistSendGuard(file: string): void {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { daily?: Array<[string, Rec]>; recent?: Array<[string, Array<{ at: number; chat: string }>]> };
    const today = dayOf(Date.now());
    for (const [k, v] of raw.daily ?? []) if (v?.day === today) daily.set(k, { day: v.day, count: v.count ?? 0, fresh: v.fresh ?? [] });
    for (const [k, v] of raw.recent ?? []) recent.set(k, v.filter((r) => Date.now() - r.at < DUP_WINDOW_MS));
  } catch {
    /* ilk çalıştırma */
  }
  let timer: NodeJS.Timeout | undefined;
  dirty = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const now = Date.now();
      const out = {
        daily: [...daily].filter(([, v]) => v.day === dayOf(now)),
        recent: [...recent].map(([k, v]) => [k, v.filter((r) => now - r.at < DUP_WINDOW_MS)] as const).filter(([, v]) => v.length),
      };
      fs.writeFile(file, JSON.stringify(out), { mode: 0o600 }, () => undefined);
    }, 2000);
    timer.unref?.();
  };
}

/** Testler için sıfırla */
export function resetSendGuard(): void {
  daily.clear();
  recent.clear();
}

function platformName(p: Platform): string {
  return ({ linkedin: 'LinkedIn', x: 'X', instagram: 'Instagram', messenger: 'Messenger', whatsapp: 'WhatsApp', telegram: 'Telegram', imessage: 'iMessage', slack: 'Slack' } as Partial<Record<Platform, string>>)[p] ?? p;
}
