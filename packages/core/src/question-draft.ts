import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_MODEL } from './config.js';
import { AiError, aiEnabled, aiKey } from './ai.js';

/**
 * Pazaryeri müşteri sorusuna AI yanıt taslağı. Ürün bilgisi (meta.question + siparişlerden fiyat), aynı ürüne daha önce verilmiş
 * cevaplar, satıcının üslubu (style.ts) ve pazaryeri kuralları modele verilir; çıktı yapılandırılmış (json_schema). Taslak yalnız
 * kompozöre konur — otomatik gönderim YOK. Model çıktısı yine de süzülür: telefon, e-posta ve harici bağlantı silinir
 * (Trendyol/Hepsiburada/n11 kuralları: alıcıyı pazaryeri dışına yönlendirmek yasak, hesap kısıtlanır).
 */

export interface QuestionDraftInput {
  platform: string;
  question: string;
  /** Sorunun sohbetindeki önceki satırlar (varsa: HB konuşmalı sorular) */
  conversation?: Array<{ fromMe: boolean; text: string }>;
  customerName?: string;
  product?: { name?: string; id?: string; url?: string; subject?: string; price?: string; orderNumber?: string };
  /** Aynı ürüne daha önce verilmiş cevaplar */
  sameProduct: Array<{ question: string; answer: string }>;
  /** Satıcının bu pazaryerindeki gerçek soru → cevap örnekleri */
  sellerAnswers: Array<{ them: string; me: string }>;
  /** style.ts describeStyle satırları */
  style: string[];
}

export interface QuestionDraftResult {
  draft: string;
  /** Satıcının doldurması gereken belirsizlikler ("stok bilgisi eklenmeli" gibi) */
  notes: string[];
  /** Süzgeçten silinenler (telefon/e-posta/bağlantı) */
  removed: string[];
  style: string[];
  sameProduct: number;
}

const PLATFORM_NAME: Record<string, string> = {
  trendyol: 'Trendyol',
  hepsiburada: 'Hepsiburada',
  n11: 'n11',
  amazon: 'Amazon',
  etsy: 'Etsy',
  shopify: 'Shopify',
  shopier: 'Shopier',
  pttavm: 'ePttAVM',
};

/** Pazaryeri kuralları (istemde madde madde; testler bu listeyi denetler) */
export const MARKET_RULES: readonly string[] = [
  'Kısa ve net yaz: 1-3 cümle, en fazla 500 karakter.',
  'Nazik ve saygılı ol; "siz" diye hitap et. Kaba, alaycı ya da suçlayıcı ifade kullanma.',
  'Telefon numarası, e-posta adresi, web sitesi, sosyal medya hesabı ya da WhatsApp/Instagram gibi başka bir kanal VERME ve müşteriyi pazaryeri dışına yönlendirme.',
  'Harici bağlantı (URL) paylaşma; ürün sayfasına da bağlantı verme.',
  'Bilmediğin bilgiyi (stok, kargo tarihi, ölçü, malzeme, fiyat, kampanya) uydurma; emin değilsen satıcının dolduracağı kısa bir boşluk bırak ve notes listesine yaz.',
  'İade, değişim, garanti ya da indirim sözü verme; yalnız ürün bilgisinde ya da önceki cevaplarda açıkça geçiyorsa aynen aktar.',
  'Rakip mağaza ya da başka pazaryeri adı anma; siparişi pazaryeri dışında almayı önerme.',
  'Müşterinin kişisel bilgilerini (ad soyad, adres, telefon) cevapta tekrarlama; cevaplar herkese açık görünebilir.',
  'Emoji kullanma (pazaryeri cevaplarında resmî dil).',
];

const SYSTEM = `Sen bir e-ticaret satıcısının müşteri sorularını yanıtlayan asistanısın. Pazaryerindeki bir ürün/sipariş sorusuna
satıcı adına gönderilecek cevap TASLAĞI yazıyorsun; satıcı okuyup düzenleyecek ve kendisi gönderecek.
Kurallar:
${MARKET_RULES.map((r) => `- ${r}`).join('\n')}
Aynı ürüne daha önce verilmiş cevaplar en güvenilir bilgi kaynağıdır: tutarlı ol, çelişme. Satıcının üslup profilini
(uzunluk, açılış/kapanış kalıpları) koru ama kurallar her zaman önce gelir.
draft: yalnız cevap metni (tırnaksız, imzasız). notes: satıcının göndermeden önce doğrulaması/doldurması gerekenler (yoksa boş liste).`;

const SCHEMA = {
  type: 'object',
  properties: {
    draft: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['draft', 'notes'],
  additionalProperties: false,
} as const;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Model isteği (sistem + kullanıcı metni); saf — testte doğrudan denetlenir */
export function buildQuestionPrompt(input: QuestionDraftInput): { system: string; user: string } {
  const p = input.product ?? {};
  const productLines = [
    p.name ? `Ürün: ${clip(p.name, 200)}` : 'Ürün adı bilinmiyor.',
    p.id ? `Ürün kodu: ${clip(p.id, 60)}` : '',
    p.price ? `Satış fiyatı (son siparişlerden): ${p.price}` : '',
    p.subject ? `Soru konusu: ${clip(p.subject, 120)}` : '',
    p.orderNumber ? `Soru bir siparişe bağlı: #${clip(p.orderNumber, 40)}` : '',
  ].filter(Boolean);
  const prev = input.sameProduct.length
    ? `Bu ürüne daha önce verilmiş cevaplar (soru → satıcının cevabı):\n${input.sameProduct
        .slice(0, 8)
        .map((x) => `- "${clip(x.question.replace(/\s+/g, ' '), 200)}" → "${clip(x.answer.replace(/\s+/g, ' '), 400)}"`)
        .join('\n')}`
    : 'Bu ürüne daha önce verilmiş cevap yok.';
  const seller = input.sellerAnswers.length
    ? `Satıcının bu mağazadaki başka cevap örnekleri (üslup için):\n${input.sellerAnswers
        .slice(0, 6)
        .map((x) => `- "${clip(x.them.replace(/\s+/g, ' '), 160)}" → "${clip(x.me.replace(/\s+/g, ' '), 300)}"`)
        .join('\n')}`
    : 'Satıcının cevap örneği yok.';
  const convo = (input.conversation ?? [])
    .filter((m) => m.text.trim())
    .slice(-8)
    .map((m) => `${m.fromMe ? 'SATICI' : 'MÜŞTERİ'}: ${clip(m.text.replace(/\s+/g, ' '), 400)}`)
    .join('\n');
  const user = `Pazaryeri: ${PLATFORM_NAME[input.platform] ?? input.platform}.
${productLines.join('\n')}
${prev}
${seller}
Satıcının üslubu: ${input.style.length ? input.style.join('; ') : 'yeterli veri yok, kısa ve resmî yaz'}.
${convo ? `Soru yazışması:\n${convo}\n` : ''}
Müşterinin sorusu: "${clip(input.question.replace(/\s+/g, ' '), 1200)}"

Bu soruya kurallara uyan bir cevap taslağı üret.`;
  return { system: SYSTEM, user };
}

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|com\.tr|net\.tr|org\.tr|io|co|shop|store|app|me|tr)(?:\/\S*)?/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
// Türkiye telefon biçimi (0532 123 45 67, +90 532…, (212) 123-45-67); sipariş numarası (#1042931001, 405-…) telefon sayılmaz:
// önek (+90/0) ya da en az iki ayırıcı şart, önünde # olmamalı
const PHONE_RE = /(?<![#\d])(?:\+?90|0)?[\s.-]?\(?[2-5]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}(?!\d)/g;
const looksPhone = (m: string) => /^\s*(\+?90|0)/.test(m) || (m.trim().match(/[\s.()-]/g) ?? []).length >= 2;
const HANDLE_RE = /(^|\s)@[a-z0-9_.]{3,}/gi;

/** Taslaktan telefon, e-posta, bağlantı ve @kullanıcı adını sil; silinenlerin türünü döndür */
export function sanitizeAnswer(text: string): { text: string; removed: string[] } {
  const removed = new Set<string>();
  let t = text.replace(EMAIL_RE, () => (removed.add('e-posta adresi'), ''));
  t = t.replace(URL_RE, () => (removed.add('bağlantı'), ''));
  t = t.replace(PHONE_RE, (m) => (looksPhone(m) ? (removed.add('telefon numarası'), m.match(/^\s/) ? ' ' : '') : m));
  t = t.replace(HANDLE_RE, (_m, pre: string) => (removed.add('sosyal medya hesabı'), pre));
  t = t
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .trim();
  return { text: t, removed: [...removed] };
}

/** Model çağrısı (test sahte işlev verir) */
export type CreateFn = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
let client: Anthropic | undefined;
let clientKey = '';
const defaultCreate: CreateFn = (params) => {
  const k = aiKey();
  if (!client || clientKey !== k) {
    client = new Anthropic({ apiKey: k });
    clientKey = k;
  }
  return client.messages.create(params);
};

function aiError(e: unknown): Error {
  if (!(e instanceof Anthropic.APIError)) return e as Error;
  const st = e.status;
  if (st === 401 || st === 403) return new AiError(400, 'Anthropic API anahtarı geçersiz ya da yetkisiz (Ayarlar → AI özellikleri)');
  if (st === 429) return new AiError(429, 'Anthropic hız/kota sınırı aşıldı; biraz sonra yeniden dene');
  if (st === 529 || st === 503) return new AiError(503, 'Anthropic şu an yoğun; biraz sonra yeniden dene');
  return new AiError(502, `AI yanıt vermedi${st ? ` (${st})` : ''}: ${e.message.split('\n')[0].slice(0, 160)}`);
}

/** Taslak üret. Anahtar yoksa (ve sahte işlev verilmediyse) null. */
export async function questionDraft(input: QuestionDraftInput, create?: CreateFn): Promise<QuestionDraftResult | null> {
  if (!create && !aiEnabled()) return null;
  const { system, user } = buildQuestionPrompt(input);
  const res = await (create ?? defaultCreate)({
    model: ANTHROPIC_MODEL,
    max_tokens: 4000,
    system,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: user }],
  }).catch((e: unknown) => {
    throw aiError(e);
  });
  if (res.stop_reason === 'refusal') throw new AiError(422, 'AI bu soru için taslak üretmeyi reddetti');
  const raw = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  let draft = raw.trim();
  let notes: string[] = [];
  try {
    const parsed = JSON.parse(raw) as { draft?: unknown; notes?: unknown };
    draft = typeof parsed.draft === 'string' ? parsed.draft : '';
    notes = Array.isArray(parsed.notes) ? parsed.notes.filter((n): n is string => typeof n === 'string' && !!n.trim()).slice(0, 5) : [];
  } catch {
    /* düz metin geldiyse olduğu gibi */
  }
  const clean = sanitizeAnswer(draft);
  return { draft: clean.text.slice(0, 2000), notes, removed: clean.removed, style: input.style, sameProduct: input.sameProduct.length };
}
