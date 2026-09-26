import type { CalendarDraft, Chat, DraftResult, Message } from './types';
import { guessWhen } from './when';

/**
 * Herkese açık demo için örnek AI: gerçek model çağrısı yok. Sohbetin son mesajlarından "senin tarzında" taslak,
 * özet, aksiyonlar ve tarihli olaylar üretir. Öne çıkan sohbetlerde elle yazılmış yanıtlar, diğerlerinde anahtar
 * kelimeye göre şablon. Arayüz gerçek çekirdekteki AI ile aynı akışı gösterir.
 */
export const DEMO_STYLE = ['kısa-orta uzunlukta yazar', '"siz" diye hitap eder (resmî)', 'ara sıra emoji kullanır (🙏 😊)', 'açılışta "Merhaba" der', 'kapanışta "Teşekkürler" der'];
const TEAM_STYLE = ['kısa yazar', '"sen" diye hitap eder (samimi)', 'emoji kullanmaz', 'cümleye küçük harfle başlar'];

type Tone = 'default' | 'short' | 'formal' | 'en';
interface Curated { draft: string; short?: string; en?: string; actions?: string[] }

/** Öne çıkan demo sohbetleri: `${platform}:${remoteId}` */
const CURATED: Record<string, Curated> = {
  'whatsapp:ayse': {
    draft: 'Merhaba Ayşe Hanım, kargonuz bugün Yurtiçi ile çıkıyor. Takip numarasını hemen buradan iletiyorum 🙏',
    short: 'Bugün Yurtiçi ile çıkıyor, takip no birazdan burada 🙏',
    en: 'Hi Ayşe, your order ships with Yurtiçi today. I’ll send the tracking number here shortly 🙏',
    actions: ['Takip numarasını Ayşe Demir’e ilet', 'Demir Studio adına e-faturayı yarın kes'],
  },
  'whatsapp:ekip': {
    draft: 'metni bu akşam kapatıyorum, KETEN15 kuponuyla gidiyoruz. yarın 10:00 gönderimden önce son okumayı yapıp haber veririm',
    short: 'metin bu akşam hazır, yarın 10:00’da çıkıyoruz',
    en: 'I’ll wrap the copy tonight, we go with KETEN15. Final read before the 10:00 send tomorrow.',
    actions: ['Kampanya metnini bu akşam bitir', 'Yarın 10:00 gönderiminden önce son okuma'],
  },
  'trendyol:soru-kalip': {
    draft: 'Merhaba Deniz Hanım, 170 cm / 62 kg için 38 beden rahat olur. Siparişinizi bu akşam verirseniz yarın kargoda 😊',
    short: '38 beden rahat olur, bu akşamki sipariş yarın kargoda 😊',
    en: 'Hi Deniz, size 38 will fit you well at 170 cm / 62 kg. Order tonight and it ships tomorrow 😊',
    actions: ['Deniz K. siparişi geçince 38 bedeni ayır'],
  },
  'trendyol:soru-kargo': {
    draft: 'Merhaba Nisa Hanım, siparişiniz Trendyol Express ile kargoya verildi. Ada Studio adına faturayı bugün kesip PDF olarak buraya bırakıyorum 🙏',
    short: 'Kargoya verildi; fatura bugün buraya PDF olarak gelecek 🙏',
    en: 'Hi Nisa, your order has shipped with Trendyol Express. I’ll issue the Ada Studio invoice today and drop the PDF here 🙏',
    actions: ['Ada Studio adına kurumsal faturayı bugün kes', 'Fatura PDF’ini Nisa A.’ya ilet'],
  },
  'gmail:fatura': {
    draft: 'Merhaba, Eylül faturası ve döküm için teşekkürler. Ödemeyi cuma günü yapıp dekontu bu yazışmaya ekleyeceğim.',
    short: 'Teşekkürler, ödeme cuma; dekontu buraya eklerim.',
    en: 'Thanks for the September invoice and breakdown. I’ll pay on Friday and attach the receipt to this thread.',
    actions: ['Eylül faturasını cuma öde (1.250 TL)', 'Dekontu yazışmaya ekle'],
  },
  'instagram:selin': {
    draft: 'Merhaba Selin, harika fikir 😊 Keten seriden S ve M bedenleri çarşamba kargoluyorum, kapak karesini de yayın öncesi onayına sunarım.',
    short: 'Çarşamba S ve M kargoda, kapak karesini onayına sunarım 😊',
    en: 'Hi Selin, love it 😊 I’ll ship S and M from the linen line on Wednesday and send the cover shot for approval.',
    actions: ['Keten seriden S ve M’yi çarşamba kargola', 'Kapak karesini yayın öncesi onaya gönder'],
  },
};

const TEAMISH = (c: Chat) => c.tags.includes('ekip') || c.tags.includes('kişisel') || c.kind !== 'direct';
const firstName = (c: Chat) => {
  const n = (c.handle && !/^[+@]|@/.test(c.handle) ? c.handle : c.name).replace(/^(Müşteri sorusu|Sipariş|Soru|İade|Alıcı)[^·]*·\s*/i, '');
  return n.split(/[\s.]/)[0] || c.name;
};

/** Anahtar kelimeye göre şablon yanıt (öne çıkmayan sohbetler) */
function templated(chat: Chat, last: string): Curated {
  const t = last.toLocaleLowerCase('tr');
  const casual = TEAMISH(chat);
  const hi = casual ? '' : `Merhaba ${firstName(chat)} Hanım/Bey, `;
  const pick = (formal: string, informal: string) => (casual ? informal : hi + formal);
  if (/kargo|ne zaman çıkar|takip/.test(t)) return { draft: pick('siparişiniz bugün kargoya veriliyor. Takip numarasını hemen buradan iletiyorum 🙏', 'bugün kargoda, takip no birazdan burada'), actions: [`${chat.name}: takip numarasını ilet`] };
  if (/fatura|dekont|ödeme/.test(t)) return { draft: pick('faturanızı bugün kesip PDF olarak buraya bırakıyorum. Teşekkürler.', 'faturayı bugün kesip atıyorum'), actions: [`${chat.name}: faturayı kes ve gönder`] };
  if (/beden|kalıp|ölçü/.test(t)) return { draft: pick('ölçülerinize göre bir beden büyüğü rahat olur; beden tablosunu da iletiyorum 😊', 'bir beden büyüğü rahat olur, tabloyu atıyorum'), actions: [] };
  if (/iade|değişim|çatla|hasar/.test(t)) return { draft: pick('yaşadığınız sorun için üzgünüz. İadenizi başlattım; ücret 3 iş günü içinde kartınıza yansır.', 'iadeyi başlattım, 3 iş günü içinde yansır'), actions: [`${chat.name}: iadeyi onayla`] };
  if (/stok|var mı|renk/.test(t)) return { draft: pick('ürün stokta; bugün verilen siparişler yarın kargoya çıkıyor 😊', 'stokta var, yarın kargoda'), actions: [] };
  if (/toplantı|görüş|saat|yarın|bugün/.test(t)) return { draft: pick('uygun; belirttiğiniz saatte görüşelim. Teşekkürler.', 'olur, o saatte görüşelim'), actions: [] };
  if (/teşekkür|sağ ?ol/.test(t)) return { draft: pick('rica ederim, iyi günlerde kullanın 😊', 'ne demek, kolay gelsin'), actions: [] };
  return { draft: pick('mesajınız için teşekkürler, konuyu kontrol edip bugün içinde dönüş yapıyorum.', 'bakıyorum, bugün dönerim'), actions: [] };
}

/** Sohbetin son müşteri mesajlarından 2–3 maddelik özet (hazır özeti olmayan sohbetler için) */
function summarize(chat: Chat, msgs: Message[]): string[] {
  const ready = Array.isArray(chat.meta?.summary) ? (chat.meta.summary as string[]) : [];
  if (ready.length) return ready;
  const lines = msgs.filter((m) => m.text.trim()).slice(-8);
  const out: string[] = [];
  for (const m of lines.reverse()) {
    const s = m.text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0].slice(0, 90);
    if (s.length > 12 && !out.some((o) => o.slice(0, 20) === s.slice(0, 20))) out.push((m.fromMe ? 'Sen: ' : '') + s);
    if (out.length === 3) break;
  }
  return out.reverse();
}

/** Mesajlarda geçen tarih/saatlerden takvim önerisi */
function events(chat: Chat, msgs: Message[]): CalendarDraft[] {
  const out: CalendarDraft[] = [];
  for (const m of msgs.slice(-10)) {
    if (!/yarın|bugün|pazartesi|salı|çarşamba|perşembe|cuma|cumartesi|pazar|\d{1,2}[:.]\d{2}|\d{1,2} (ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık)/i.test(m.text)) continue;
    const w = guessWhen(m.text);
    if (!w.found) continue;
    out.push({ title: `${chat.name}: ${m.text.replace(/\s+/g, ' ').slice(0, 60)}`, start: w.time ? `${w.date}T${w.time}` : w.date });
  }
  return out.slice(-2);
}

export function demoDraft(chat: Chat, msgs: Message[], tone: Tone = 'default'): DraftResult {
  const incoming = msgs.filter((m) => !m.fromMe && m.text.trim());
  const last = incoming.at(-1)?.text ?? '';
  const c = CURATED[`${chat.platform}:${chat.remoteId}`] ?? templated(chat, last);
  let draft = c.draft;
  if (tone === 'short') draft = c.short ?? draft.split(/(?<=[.!?])\s/)[0];
  else if (tone === 'en') draft = c.en ?? 'Thanks for your message, I’ll check and get back to you today.';
  else if (tone === 'formal') draft = draft.replace(/\s?[🙏😊]/gu, '').replace(/^merhaba/i, 'Merhaba').replace(/^([a-zçğıöşü])/, (x) => x.toLocaleUpperCase('tr'));
  return { draft, summary: summarize(chat, msgs), actions: c.actions ?? [], events: events(chat, msgs), style: TEAMISH(chat) ? TEAM_STYLE : DEMO_STYLE };
}
