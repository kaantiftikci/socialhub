import { ANTHROPIC_API_KEY, ANTHROPIC_MODEL } from './config.js';
import type { Chat, Message } from './model.js';

/**
 * "Senin tarzında taslak": sohbetin son mesajları + kullanıcının aynı sohbette
 * daha önce yazdığı mesajlar (üslup örnekleri) modele verilir. Anahtar yoksa null döner;
 * arayüz taslak alanını gizler. İleride bu katman yerel bir modele (llama.cpp / MLX) bağlanabilir.
 */
export interface DraftInput {
  chat: Chat;
  messages: Message[];
  mySamples: string[];
  tone?: 'default' | 'short' | 'formal' | 'en';
}

export interface DraftResult {
  draft: string;
  summary: string[];
  actions: string[];
}

export const aiEnabled = (): boolean => Boolean(ANTHROPIC_API_KEY);

export async function draftReply(input: DraftInput): Promise<DraftResult | null> {
  if (!aiEnabled()) return null;
  const toneLine = {
    default: 'Doğal, samimi ama profesyonel.',
    short: 'Çok kısa, en fazla iki cümle.',
    formal: 'Resmî ve ölçülü.',
    en: 'Yanıtı İngilizce yaz.',
  }[input.tone ?? 'default'];

  const transcript = input.messages
    .slice(-20)
    .map((m) => `${m.fromMe ? 'BEN' : m.senderName}: ${m.text}`)
    .join('\n');
  const samples = input.mySamples.length ? `Kullanıcının bu kişiye daha önce yazdığı mesajlar (üslubu bunlardan öğren):\n${input.mySamples.map((s) => `- ${s}`).join('\n')}` : '';

  const system = `Sen bir mesajlaşma asistanısın. Kullanıcı adına, ${input.chat.platform} üzerinden "${input.chat.name}" ile yapılan sohbete cevap taslağı yazıyorsun.
Kurallar: kullanıcının üslubunu taklit et, uydurma bilgi ekleme, karşı tarafın sorduğu her soruya değin, emoji kullanma. ${toneLine}
Yalnızca şu JSON'u döndür: {"draft": "...", "summary": ["...", "..."], "actions": ["..."]}
summary: sohbetin 2-3 maddelik özeti. actions: mesajlardan çıkan somut yapılacaklar (tarih/saat varsa ekle), yoksa boş liste.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: `${samples}\n\nSohbet:\n${transcript}\n\nSon mesaja cevap taslağı üret.` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const text = data.content.find((c) => c.type === 'text')?.text ?? '';
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const parsed = JSON.parse(json) as Partial<DraftResult>;
    return { draft: parsed.draft ?? '', summary: parsed.summary ?? [], actions: parsed.actions ?? [] };
  } catch {
    return { draft: text.trim(), summary: [], actions: [] };
  }
}
