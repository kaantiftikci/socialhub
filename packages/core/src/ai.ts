import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, ANTHROPIC_MODEL } from './config.js';
import { getSecret, setSecret } from './secrets.js';
import type { Chat, Message } from './model.js';
import { describeStyle, type StyleProfile } from './style.js';

/**
 * "Senin tarzında taslak": sohbetin son mesajları + kullanıcının üslup profili (style.ts; tüm sohbetlerdeki kendi
 * mesajlarından yerelde çıkarılır) + gerçek "gelen mesaj → benim yanıtım" örnek çiftleri modele verilir.
 * Anahtar yoksa null döner; arayüz taslak alanını gizler. İleride bu katman yerel bir modele (llama.cpp / MLX) bağlanabilir.
 */
export interface DraftInput {
  chat: Chat;
  messages: Message[];
  /** Karşı tarafın mesajı → benim yanıtım (önce bu sohbetten, sonra diğerlerinden) */
  pairs: Array<{ them: string; me: string }>;
  style: StyleProfile;
  tone?: 'default' | 'short' | 'formal' | 'en';
}

/** Mesajlardan çıkan takvim etkinliği ("Takvime ekle"); start yerel saat "YYYY-MM-DDTHH:mm" ya da tüm gün "YYYY-MM-DD" */
export interface DraftEvent {
  title: string;
  start: string;
}

export interface DraftResult {
  draft: string;
  summary: string[];
  actions: string[];
  events: DraftEvent[];
  /** Arayüzde "Tarzın: …" satırı */
  style: string[];
}

/**
 * Anahtar kaynağı: önce kullanıcının Ayarlar'dan girdiği (Anahtar Zinciri/DPAPI), yoksa ANTHROPIC_API_KEY ortam değişkeni.
 * Paketli uygulama ortam değişkeni almadığı için asıl yol Ayarlar.
 */
let stored: string | null | undefined;
const storedKey = () => (stored === undefined ? (stored = getSecret('anthropic-key')) : stored);
export const aiKey = (): string => storedKey() || ANTHROPIC_API_KEY;
export const aiKeySource = (): 'settings' | 'env' | null => (storedKey() ? 'settings' : ANTHROPIC_API_KEY ? 'env' : null);
export const aiEnabled = (): boolean => Boolean(aiKey());
export function setAiKey(key: string | null): void {
  setSecret('anthropic-key', key);
  stored = key;
  client = undefined;
}

let client: Anthropic | undefined;

const SCHEMA = {
  type: 'object',
  properties: {
    draft: { type: 'string' },
    summary: { type: 'array', items: { type: 'string' } },
    actions: { type: 'array', items: { type: 'string' } },
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, start: { type: 'string' } },
        required: ['title', 'start'],
        additionalProperties: false,
      },
    },
  },
  required: ['draft', 'summary', 'actions', 'events'],
  additionalProperties: false,
} as const;

// Sabit sistem istemi (önbelleğe uygun); sohbete özgü her şey kullanıcı mesajında
const SYSTEM = `Sen bir mesajlaşma asistanısın. Kullanıcı adına, sohbetteki son mesaja gönderilecek bir yanıt taslağı yazıyorsun.
Kullanıcıya "senin tarzında" taslak sunmak ana hedef: verilen üslup profilini ve gerçek yanıt örneklerini birebir taklit et —
uzunluk, hitap (sen/siz), emoji alışkanlığı, büyük/küçük harf, noktalama, açılış ve kapanış kalıpları. Örneklerde emoji yoksa
emoji kullanma; varsa aynı sıklıkta ve aynı emojilerle kullan. Uydurma bilgi, tarih, fiyat ya da söz ekleme; bilmediğin şeyi
kullanıcının dolduracağı şekilde kısa bırak. Karşı tarafın sorduğu her soruya değin.
summary: sohbetin 2-3 maddelik özeti. actions: mesajlardan çıkan somut yapılacaklar, yoksa boş liste.
events: mesajlarda kesinleşmiş ya da önerilen buluşma/teslim/toplantı gibi tarihli olaylar; bugünün tarihine göre
göreli ifadeleri ("yarın 14:00", "cuma") çöz ve start'ı yerel saatle "YYYY-MM-DDTHH:mm" (saat yoksa "YYYY-MM-DD") yaz; yoksa boş liste.`;

export async function draftReply(input: DraftInput): Promise<DraftResult | null> {
  if (!aiEnabled()) return null;
  client ??= new Anthropic({ apiKey: aiKey() });
  const toneLine = {
    default: 'Ek ton isteği yok: tamamen kullanıcının kendi tarzı.',
    short: 'Ek ton isteği: çok kısa, en fazla iki cümle (kullanıcının tarzını koruyarak).',
    formal: 'Ek ton isteği: resmî ve ölçülü ("siz" hitabı).',
    en: 'Ek ton isteği: yanıtı İngilizce yaz (kullanıcının tarzını koruyarak).',
  }[input.tone ?? 'default'];

  const style = describeStyle(input.style);
  const transcript = input.messages
    .slice(-20)
    .map((m) => `${m.fromMe ? 'BEN' : m.senderName}: ${m.text}`)
    .join('\n');
  const pairs = input.pairs.length
    ? `Kullanıcının gerçek yanıt örnekleri (gelen → kullanıcının yanıtı):\n${input.pairs.map((p) => `- "${p.them.slice(0, 200)}" → "${p.me.slice(0, 300)}"`).join('\n')}`
    : 'Kullanıcının yanıt örneği yok.';
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${now.toLocaleDateString('tr-TR', { weekday: 'long' })}`;
  const user = `Platform: ${input.chat.platform}. Sohbet: "${input.chat.name}". Bugün: ${today}.
Üslup profili: ${style.length ? style.join('; ') : 'yeterli veri yok, doğal ve kısa yaz'}.
${pairs}
${toneLine}

Sohbet:
${transcript}

Son mesaja yanıt taslağı üret.`;

  const res = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: user }],
  });
  if (res.stop_reason === 'refusal') throw new Error('AI bu sohbet için taslak üretmeyi reddetti');
  const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  try {
    const parsed = JSON.parse(text) as Partial<DraftResult>;
    return {
      draft: parsed.draft ?? '',
      summary: parsed.summary ?? [],
      actions: parsed.actions ?? [],
      events: (parsed.events ?? []).filter((e) => e.title && /^\d{4}-\d{2}-\d{2}/.test(e.start)),
      style,
    };
  } catch {
    return { draft: text.trim(), summary: [], actions: [], events: [], style };
  }
}
