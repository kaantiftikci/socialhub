import type { Chat, CoreEvent, Message } from './types';
import type { IndexStatus, MessageTranslation, MlModel, MlSettings, MlStatus, ModelKey, SemanticResult, Transcript } from './ml-api';
import { demoPeopleSource } from './static-demo';
import { detectLanguage, LANG_NAMES } from './lang-detect';

/**
 * Statik demo (demo.mivelo.app): yerel AI model indirmeden taklit edilir. Modeller "indirilmiş" görünür; örnek sesli mesajın
 * hazır metni, eşanlamlı/anahtar kelime eşleşmesiyle "anlamsal" arama, yabancı müşteri mesajları için hazır çeviriler.
 * Kayıtla gelen yeni üye (fresh) örnek veri görmediği için burada da boş sonuç döner.
 */
let emitter: ((ev: CoreEvent) => void) | null = null;
export function setDemoMlEmitter(fn: (ev: CoreEvent) => void): void {
  emitter = fn;
}
const emit = (ev: CoreEvent) => emitter?.(ev);

const SIZES: Record<ModelKey, [string, string, number]> = {
  whisper: ['Xenova/whisper-small', 'Konuşma tanıma (Whisper small)', 250],
  embed: ['Xenova/multilingual-e5-small', 'Anlamsal arama (multilingual-e5-small)', 135],
};
const state: Record<ModelKey, { state: MlModel['state']; pct: number }> = { whisper: { state: 'ready', pct: 100 }, embed: { state: 'ready', pct: 100 } };

const SET_KEY = 'mivelo.mlDemo';
function settings(): MlSettings {
  const d: MlSettings = { autoTranscribe: true, semanticIndex: true, translateTarget: 'tr' };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(SET_KEY) || '{}') as Partial<MlSettings>) };
  } catch {
    return d;
  }
}

/** Örnek sesli mesajların (dosya adına göre) hazır metni */
const VOICE_TEXT: Record<string, string> = {
  'sesli-mesaj.wav': 'Merhaba, bir de şunu soracaktım: gömleğin bedeni dar gelirse değişim yapabiliyor muyuz? Faturayı da şirket adına kesersiniz değil mi, unvanı birazdan yazarım.',
};
const VOICE_FALLBACK = 'Bu sesli mesaj masaüstü uygulamasında cihazında yazıya dökülür; metin burada görünür ve aramada bulunur.';
const transcripts = new Map<string, Transcript>();

const voiceText = (m: Message): string | undefined => {
  const a = m.attachments?.find((x) => x.kind === 'audio');
  if (!a) return undefined;
  const file = Object.keys(VOICE_TEXT).find((f) => (a.link ?? '').includes(f.replace('.wav', '')));
  return file ? VOICE_TEXT[file] : VOICE_FALLBACK;
};

/** Hazır çeviriler (demo sohbetlerindeki yabancı müşteri mesajları) */
const TRANSLATIONS: Record<string, string> = {
  'Hi! I love the gold ring. Is it available in size 7 (US)?': 'Merhaba! Altın yüzüğe bayıldım. 7 numara (ABD ölçüsü) var mı?',
  'Hi Emma! Yes, size 7 is in stock. It ships within 2 business days.': 'Merhaba Emma! Evet, 7 numara stokta. 2 iş günü içinde kargoya verilir.',
  'Great! Do you ship to Germany, and how long does delivery usually take?': 'Harika! Almanya’ya gönderim yapıyor musunuz, teslimat genelde ne kadar sürüyor?',
  'Also, could you add a small gift note? It is a birthday present for my sister.': 'Bir de küçük bir hediye notu ekleyebilir misiniz? Kız kardeşime doğum günü hediyesi.',
};

/** Satıcı yanıtları için küçük sözlük (demo "Çevir ve gönder": gerçek uygulamada model çevirir) */
const PHRASES: Record<string, Array<[string, string]>> = {
  en: [
    ['merhaba', 'Hi'], ['teşekkür(ler| ederiz| ederim)', 'thank you'], ['almanya.?ya', 'to Germany'], ['gönderiyoruz|gönderim yapıyoruz', 'we ship'],
    ['evet', 'yes'], ['hayır', 'no'], ['teslimat', 'delivery'], ['kargo(ya)?', 'shipping'], ['genelde', 'usually'], ['iş günü', 'business days'],
    ['sürüyor|sürer', 'takes'], ['hediye notu', 'gift note'], ['ekleriz|ekleyeceğiz|ekliyoruz', "we'll add"], ['ücretsiz', 'free of charge'],
    ['yarın', 'tomorrow'], ['bugün', 'today'], ['stokta', 'in stock'], ['sipariş(iniz)?', 'your order'], ['takip numarası', 'tracking number'],
    ['ile', 'with'], ['ve', 'and'], ['de|da', 'too'], ['iyi günler', 'have a nice day'], ['memnuniyetle', 'happily'],
  ],
  de: [
    ['merhaba', 'Hallo'], ['teşekkür(ler| ederiz| ederim)', 'vielen Dank'], ['evet', 'ja'], ['kargo(ya)?', 'Versand'], ['yarın', 'morgen'],
    ['iş günü', 'Werktage'], ['hediye notu', 'Geschenknotiz'], ['ücretsiz', 'kostenlos'], ['sipariş(iniz)?', 'Ihre Bestellung'], ['ve', 'und'],
  ],
};

/** Demo akışındaki olası satıcı yanıtları: anahtar kelimelere göre akıcı hazır çeviri (gerçekte model çevirir) */
const REPLIES: Array<{ keys: string[]; en: string; de: string }> = [
  {
    keys: ['almanya', 'hediye'],
    en: 'Hi! Yes, we ship to Germany; delivery usually takes about 5 business days. We will gladly add a gift note free of charge.',
    de: 'Hallo! Ja, wir versenden nach Deutschland; die Lieferung dauert in der Regel etwa 5 Werktage. Eine Geschenknotiz legen wir gerne kostenlos bei.',
  },
  { keys: ['almanya'], en: 'Hi! Yes, we ship to Germany; delivery usually takes about 5 business days.', de: 'Hallo! Ja, wir versenden nach Deutschland; die Lieferung dauert in der Regel etwa 5 Werktage.' },
  { keys: ['hediye'], en: 'Of course! We will add a gift note free of charge.', de: 'Natürlich! Wir legen kostenlos eine Geschenknotiz bei.' },
  { keys: ['kargo', 'yarın'], en: 'Your order will be shipped tomorrow; I will send you the tracking number.', de: 'Ihre Bestellung wird morgen versendet; ich schicke Ihnen die Sendungsnummer.' },
];

function demoTranslate(text: string, target: string): string {
  const known = TRANSLATIONS[text.trim()];
  if (known && target === 'tr') return known;
  const low = text.toLocaleLowerCase('tr-TR');
  const reply = REPLIES.find((r) => r.keys.every((k) => low.includes(k)));
  if (reply && (target === 'en' || target === 'de')) return reply[target];
  const table = PHRASES[target];
  if (!table) return text;
  let out = text;
  // kelime sınırı Türkçe harflerle (\b yalnız ASCII): "ve" "veriyoruz"un içinde değişmesin
  for (const [pat, to] of table) out = out.replace(new RegExp(`(?<!\\p{L})(?:${pat})(?!\\p{L})`, 'giu'), to);
  return out.charAt(0).toUpperCase() + out.slice(1);
}

const norm = (s: string) => s.toLocaleLowerCase('tr-TR');
/** Eşanlamlı kümeleri: "anlamsal" eşleşme taklidi (Türkçe + İngilizce) */
const SYN: string[][] = [
  ['fatura', 'invoice', 'e-fatura', 'dekont', 'ödeme', 'havale', 'iban', 'makbuz', 'payment', 'mutabakat'],
  ['kargo', 'teslimat', 'takip', 'gönderi', 'shipping', 'delivery', 'ship', 'paket', 'kurye'],
  ['toplantı', 'meeting', 'görüşme', 'zoom', 'lansman'],
  ['iade', 'değişim', 'return', 'refund', 'çatlak', 'hasarlı'],
  ['beden', 'size', 'ölçü', 'kalıp', 'numara'],
  ['hediye', 'gift', 'doğum', 'birthday'],
  ['fiyat', 'ücret', 'price', 'indirim', 'kupon', 'teklif'],
  ['sipariş', 'order'],
  ['stok', 'stock'],
];
function expand(word: string): string[] {
  const w = norm(word);
  const group = SYN.find((g) => g.some((x) => w.startsWith(x.slice(0, Math.max(4, x.length - 2))) || x.startsWith(w)));
  return group ?? [w];
}

const DAY = 86400e3;
function dateHint(q: string, now = new Date()): { from?: number; to?: number; label?: string; rest: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const rules: Array<[RegExp, () => [number, number], string]> = [
    [/\bbugün\b/, () => [today, now.getTime()], 'bugün'],
    [/\bdün\b/, () => [today - DAY, today - 1], 'dün'],
    [/\bbu hafta\b/, () => [today - 7 * DAY, now.getTime()], 'bu hafta'],
    [/\bgeçen hafta\b/, () => [today - 14 * DAY, today - 7 * DAY], 'geçen hafta'],
    [/\bgeçen ay\b/, () => [new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), new Date(now.getFullYear(), now.getMonth(), 1).getTime() - 1], 'geçen ay'],
  ];
  let rest = norm(q);
  for (const [re, fn, label] of rules) {
    if (re.test(rest)) {
      const [from, to] = fn();
      return { from, to, label, rest: rest.replace(re, ' ') };
    }
  }
  return { rest };
}

const STOP = new Set(['ve', 'ile', 'bir', 'bu', 'şu', 'mesaj', 'mesajı', 'gönderdiği', 'attığı', 'yazdığı', 'hakkında', 'olan', 'için', 'the', 'a', 'of']);

function indexStatus(): IndexStatus {
  const n = demoPeopleSource.fresh() ? 0 : demoPeopleSource.messages().filter((m) => m.text.trim().length >= 12).length;
  return { enabled: settings().semanticIndex, ready: state.embed.state === 'ready', indexed: n, total: n, pct: 100, running: false };
}

/** Demo: Google anahtarı yalnız bellekte (hiçbir yere gönderilmez) */
let demoGoogle: string | null = null;

function status(): MlStatus {
  return {
    demo: true,
    models: (Object.keys(SIZES) as ModelKey[]).map((key) => ({ key, id: SIZES[key][0], title: SIZES[key][1], state: state[key].state, pct: state[key].pct, sizeMb: SIZES[key][2], approx: true })),
    runtime: { ready: true, approxMb: 36 },
    settings: settings(),
    index: indexStatus(),
    translate: { engine: 'google', ai: false, google: { set: !!demoGoogle, hint: demoGoogle ? `…${demoGoogle.slice(-4)}` : null } },
    languages: LANG_NAMES,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const demoMlApi = {
  status: async (): Promise<MlStatus> => status(),
  saveSettings: async (s: Partial<MlSettings>): Promise<MlStatus> => {
    try {
      localStorage.setItem(SET_KEY, JSON.stringify({ ...settings(), ...s }));
    } catch {
      /* depolama kapalı */
    }
    emit({ type: 'ml.status' });
    return status();
  },
  download: async (key: ModelKey): Promise<MlModel> => {
    // indirme taklidi: ~3 sn'de %100 (gerçekte Hugging Face'ten)
    state[key] = { state: 'downloading', pct: 0 };
    const tick = () => {
      state[key].pct = Math.min(100, state[key].pct + 9 + Math.round(Math.random() * 8));
      if (state[key].pct >= 100) state[key] = { state: 'ready', pct: 100 };
      else setTimeout(tick, 280);
      emit({ type: 'ml.status' });
    };
    setTimeout(tick, 280);
    return status().models.find((m) => m.key === key)!;
  },
  cancel: async (key: ModelKey): Promise<MlStatus> => {
    state[key] = { state: 'absent', pct: 0 };
    emit({ type: 'ml.status' });
    return status();
  },
  remove: async (key: ModelKey): Promise<MlStatus> => {
    state[key] = { state: 'absent', pct: 0 };
    emit({ type: 'ml.status' });
    return status();
  },
  transcripts: async (chatId: string): Promise<Record<string, Transcript>> => {
    const out: Record<string, Transcript> = {};
    const auto = settings().autoTranscribe && state.whisper.state === 'ready';
    for (const m of demoPeopleSource.messages()) {
      if (m.chatId !== chatId) continue;
      const t = transcripts.get(m.id);
      if (t) out[m.id] = t;
      else if (auto && !m.fromMe) {
        const text = voiceText(m);
        if (text) out[m.id] = { messageId: m.id, status: 'done', text, lang: 'tr', seconds: 5, updatedAt: m.ts };
      }
    }
    return out;
  },
  transcribe: async (messageId: string): Promise<Transcript> => {
    if (state.whisper.state !== 'ready') throw new Error('Sesli mesajı yazıya dökmek için önce modeli indir: Ayarlar → Yerel AI modelleri → Konuşma tanıma');
    const m = demoPeopleSource.messages().find((x) => x.id === messageId);
    const text = m ? voiceText(m) : undefined;
    if (!m || !text) throw new Error('Bu mesajda yazıya dökülebilecek ses yok');
    const pending: Transcript = { messageId, status: 'pending', text: '', updatedAt: Date.now() };
    transcripts.set(messageId, pending);
    void wait(1400).then(() => {
      const done: Transcript = { messageId, status: 'done', text, lang: 'tr', seconds: 5, updatedAt: Date.now() };
      transcripts.set(messageId, done);
      emit({ type: 'transcript.update', chatId: m.chatId, messageId, transcript: done });
    });
    return pending;
  },
  search: async (q: string, limit = 60): Promise<SemanticResult> => {
    if (demoPeopleSource.fresh()) return { hits: [], mode: 'semantic', hints: { people: [] }, index: indexStatus() };
    await wait(250);
    const chats = demoPeopleSource.chats();
    const byId = new Map(chats.map((c) => [c.id, c]));
    const hint = dateHint(q);
    const words = hint.rest.split(/[^\p{L}\p{N}'’]+/u).filter((w) => w.length >= 2 && !STOP.has(w));
    // kişi: sohbet adının ilk kelimesiyle başlayan kelime ("ayşe'nin" → Ayşe Demir)
    const people: string[] = [];
    const personChats = new Set<string>();
    for (const w of [...words]) {
      const base = w.split(/['’]/)[0];
      // ekli özel isim ("ayşe'nin") ya da konu kelimesi olmayan tek kelime; e-posta/pazaryeri konu başlıkları kişi sayılmaz
      if (!/['’]/.test(w) && SYN.some((g) => g.includes(base))) continue;
      const hit = chats.filter((c) => !['gmail', 'outlook', 'icloud', 'yahoo', 'yandex', 'imap', 'trendyol', 'hepsiburada', 'n11', 'etsy', 'shopify', 'amazon', 'pttavm', 'shopier'].includes(c.platform) && norm(c.name).split(/[\s·]+/)[0] === base && base.length >= 3);
      if (hit.length) {
        people.push(base);
        hit.forEach((c) => personChats.add(c.id));
        words.splice(words.indexOf(w), 1);
      }
    }
    const groups = words.map((w) => expand(w.split(/['’]/)[0]));
    const scored: Array<{ m: Message; chat: Chat; score: number; via: 'semantic' | 'text' | 'both'; transcript?: string }> = [];
    for (const m of demoPeopleSource.messages()) {
      if (hint.from !== undefined && (m.ts < hint.from || m.ts > (hint.to ?? Infinity))) continue;
      if (personChats.size && !personChats.has(m.chatId)) continue;
      const chat = byId.get(m.chatId);
      if (!chat) continue;
      const transcript = voiceText(m);
      const hay = norm(`${m.text} ${transcript ?? ''} ${(m.attachments ?? []).map((a) => a.name ?? '').join(' ')}`);
      let score = 0;
      let exact = false;
      for (const g of groups) {
        if (hay.includes(g[0])) (score += 1), (exact = true);
        else if (g.some((x) => hay.includes(x))) score += 0.8;
      }
      if (!groups.length && (personChats.size || hint.from !== undefined)) score = 0.5;
      if (score > 0) scored.push({ m, chat, score, via: exact ? 'both' : 'semantic', ...(transcript ? { transcript } : {}) });
    }
    scored.sort((a, b) => b.score - a.score || b.m.ts - a.m.ts);
    return {
      hits: scored.slice(0, limit).map((s) => ({ message: s.m, chat: s.chat, score: s.score, via: s.via, ...(s.transcript ? { transcript: s.transcript } : {}) })),
      mode: 'semantic',
      hints: { dateLabel: hint.label, people },
      index: indexStatus(),
    };
  },
  setGoogleKey: async (key: string | null) => {
    if (key && !/^AIza[0-9A-Za-z_-]{30,60}$/.test(key.trim())) throw new Error('Geçersiz Google API anahtarı (AIza… ile başlamalı)');
    demoGoogle = key?.trim() || null;
    await wait(300);
    return status();
  },
  translate: async (messageId: string, target = 'tr', force = false): Promise<MessageTranslation> => {
    const m = demoPeopleSource.messages().find((x) => x.id === messageId);
    if (!m) throw new Error('Mesaj bulunamadı');
    const g = detectLanguage(m.text);
    if (!force && g.lang === target) return { messageId, lang: target, source: g.lang, text: m.text, same: true };
    await wait(450);
    return { messageId, lang: target, source: g.lang, text: demoTranslate(m.text, target), engine: 'google' };
  },
  translateText: async (text: string, target: string, source?: string | null) => {
    await wait(500);
    return { text: demoTranslate(text, target), source: source ?? detectLanguage(text).lang ?? 'tr', target, engine: 'google' as const };
  },
};
