/**
 * Hafif dil algılama (model yok, ağ yok): önce yazı sistemi (Kiril, Arap, CJK…), Latin alfabesinde dile özgü harfler +
 * sık kullanılan kısa kelimeler puanlanır. Çeviri "yabancı mı?" kararı ve yanıtın hangi dile çevrileceği için yeterli;
 * kısa/kararsız metinde null döner (çağıran varsayılanı — Türkçe — kullanır).
 * Arayüzde birebir kopyası var: apps/web/src/lang-detect.ts (ikisi AYNI kalmalı; test karşılaştırır).
 */

export interface LangGuess {
  /** ISO 639-1 kodu; karar verilemezse null */
  lang: string | null;
  /** 0..1 */
  confidence: number;
}

/** Arayüzde gösterilen Türkçe dil adları (çeviri hedefleri de bunlar) */
export const LANG_NAMES: Record<string, string> = {
  tr: 'Türkçe', en: 'İngilizce', de: 'Almanca', fr: 'Fransızca', es: 'İspanyolca', it: 'İtalyanca', pt: 'Portekizce', nl: 'Felemenkçe',
  pl: 'Lehçe', ro: 'Rumence', sv: 'İsveççe', az: 'Azerbaycan Türkçesi', id: 'Endonezce', ru: 'Rusça', uk: 'Ukraynaca', bg: 'Bulgarca',
  el: 'Yunanca', ar: 'Arapça', fa: 'Farsça', he: 'İbranice', zh: 'Çince', ja: 'Japonca', ko: 'Korece', hi: 'Hintçe', th: 'Tayca', ka: 'Gürcüce', hy: 'Ermenice',
};

// dile özgü sık kelimeler (yalnız ayırt edici olanlar; ortak "a", "o" gibi harfler yok)
const WORDS: Record<string, string[]> = {
  tr: ['ve', 'bir', 'bu', 'da', 'de', 'için', 'ile', 'ne', 'mi', 'mı', 'mu', 'mü', 'çok', 'ama', 'gibi', 'var', 'yok', 'ben', 'sen', 'biz', 'siz', 'olan', 'daha', 'şu', 'evet', 'hayır', 'tamam', 'merhaba', 'teşekkürler', 'nasıl', 'neden', 'kadar', 'sonra', 'önce', 'şimdi', 'yarın', 'bugün', 'abi', 'hocam', 'lütfen', 'olur', 'değil', 'benim', 'senin', 'iyi', 'hafta', 'sonu', 'akşam', 'sabah', 'saat', 'gün', 'şey', 'ki', 'hadi', 'artık', 'hemen', 'geliyor', 'gidiyor', 'misin', 'mısın', 'musun', 'müsün', 'miyiz', 'mıyız', 'muyuz', 'müyüz', 'sipariş', 'kargo', 'ürün', 'fiyat'],
  en: ['the', 'and', 'is', 'are', 'you', 'to', 'of', 'in', 'it', 'that', 'for', 'this', 'with', 'have', 'was', 'not', 'what', 'can', 'will', 'your', 'my', 'please', 'thanks', 'thank', 'hello', 'hi', 'would', 'could', 'order', 'when', 'how', 'where', 'did', 'does', 'be', 'at', 'on', 'we', 'they', 'just', 'yes', 'no', 'there', 'any', 'again', 'update', 'still', 'received', 'shipping', 'ship', 'item', 'product', 'price', 'send', 'sent', 'about', 'from', 'if', 'or', 'but', 'so'],
  de: ['und', 'ich', 'die', 'der', 'das', 'ist', 'nicht', 'sie', 'es', 'mit', 'für', 'ein', 'eine', 'auf', 'zu', 'den', 'dem', 'wir', 'haben', 'bitte', 'danke', 'hallo', 'wann', 'wie', 'meine', 'mein', 'noch', 'auch', 'aber', 'kann', 'bestellung', 'ja', 'nein', 'schon', 'wird', 'sind', 'guten', 'tag'],
  fr: ['le', 'la', 'les', 'et', 'est', 'je', 'vous', 'pas', 'une', 'un', 'des', 'du', 'que', 'qui', 'pour', 'avec', 'mon', 'ma', 'mes', 'merci', 'bonjour', 'oui', 'non', 'dans', 'sur', 'ce', 'cette', 'commande', 'quand', 'comment', 'nous', 'il', 'elle', 'suis', 'avez'],
  es: ['el', 'la', 'los', 'las', 'y', 'es', 'que', 'de', 'en', 'por', 'para', 'con', 'una', 'un', 'mi', 'gracias', 'hola', 'sí', 'pero', 'pedido', 'cuándo', 'cómo', 'está', 'estoy', 'muy', 'qué', 'usted', 'nosotros', 'del', 'al', 'se', 'lo'],
  it: ['il', 'lo', 'la', 'gli', 'e', 'è', 'che', 'di', 'per', 'con', 'una', 'un', 'mio', 'mia', 'grazie', 'ciao', 'buongiorno', 'sì', 'ma', 'ordine', 'quando', 'come', 'sono', 'non', 'del', 'della', 'questo', 'questa', 'anche'],
  pt: ['o', 'os', 'as', 'e', 'é', 'que', 'de', 'em', 'para', 'com', 'uma', 'um', 'meu', 'minha', 'obrigado', 'obrigada', 'olá', 'sim', 'não', 'mas', 'pedido', 'quando', 'como', 'você', 'do', 'da', 'estou', 'está', 'muito'],
  nl: ['de', 'het', 'een', 'en', 'is', 'ik', 'je', 'niet', 'van', 'dat', 'met', 'voor', 'op', 'mijn', 'bedankt', 'dank', 'hallo', 'ja', 'nee', 'maar', 'bestelling', 'wanneer', 'hoe', 'wij', 'zijn', 'wat', 'ook'],
  pl: ['i', 'jest', 'nie', 'się', 'na', 'że', 'do', 'to', 'jak', 'dziękuję', 'dzień', 'dobry', 'tak', 'ale', 'moje', 'zamówienie', 'kiedy', 'czy', 'proszę', 'jestem'],
  ro: ['și', 'este', 'nu', 'la', 'cu', 'pe', 'pentru', 'mulțumesc', 'bună', 'da', 'dar', 'comanda', 'când', 'cum', 'sunt', 'meu', 'mea'],
  sv: ['och', 'är', 'jag', 'inte', 'det', 'att', 'en', 'ett', 'med', 'för', 'på', 'tack', 'hej', 'ja', 'nej', 'men', 'min', 'mitt', 'beställning', 'när', 'hur'],
  az: ['və', 'bir', 'bu', 'üçün', 'ilə', 'nə', 'çox', 'amma', 'mən', 'sən', 'biz', 'siz', 'salam', 'təşəkkür', 'edirəm', 'bəli', 'xeyr', 'necə', 'niyə', 'sonra', 'indi', 'sabah', 'bugün'],
  id: ['dan', 'yang', 'ini', 'itu', 'saya', 'anda', 'tidak', 'dengan', 'untuk', 'ada', 'terima', 'kasih', 'halo', 'ya', 'tapi', 'pesanan', 'kapan', 'bagaimana', 'kami', 'sudah', 'belum'],
};

// dile özgü harfler (bir tanesi bile güçlü işaret)
const CHARS: Array<[string, RegExp, number]> = [
  ['tr', /[ğış]/g, 3],
  ['tr', /[çöü]/g, 0.6],
  ['az', /[ə]/g, 4],
  ['de', /[ß]/g, 3],
  ['de', /[äöü]/g, 0.8],
  ['fr', /[àâæçéèêëîïôœùûÿ]/g, 1],
  ['es', /[ñ¿¡áéíóú]/g, 1],
  ['pt', /[ãõâêôçáéíóú]/g, 0.9],
  ['it', /[àèéìòù]/g, 0.6],
  ['pl', /[ąćęłńśźż]/g, 3],
  ['ro', /[ăâîșț]/g, 2],
  ['sv', /[åäö]/g, 1],
  ['nl', /\bij/g, 0.5],
];

function scriptOf(text: string): LangGuess | null {
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  const letters = count(/\p{L}/gu);
  if (!letters) return null;
  const share = (n: number) => n / letters;
  const cyr = count(/\p{Script=Cyrillic}/gu);
  if (share(cyr) > 0.4) {
    if (/[їєі]/iu.test(text)) return { lang: 'uk', confidence: 0.8 };
    if (/[ъ]/iu.test(text) && !/[ыэё]/iu.test(text)) return { lang: 'bg', confidence: 0.6 };
    return { lang: 'ru', confidence: 0.85 };
  }
  const arab = count(/\p{Script=Arabic}/gu);
  if (share(arab) > 0.4) return { lang: /[پچژگ]/u.test(text) ? 'fa' : 'ar', confidence: 0.8 };
  if (share(count(/\p{Script=Hebrew}/gu)) > 0.4) return { lang: 'he', confidence: 0.9 };
  if (share(count(/\p{Script=Greek}/gu)) > 0.4) return { lang: 'el', confidence: 0.9 };
  const kana = count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const han = count(/\p{Script=Han}/gu);
  const hangul = count(/\p{Script=Hangul}/gu);
  if (share(kana + han + hangul) > 0.3) {
    if (hangul >= kana && hangul >= han) return { lang: 'ko', confidence: 0.9 };
    if (kana > 0) return { lang: 'ja', confidence: 0.85 };
    return { lang: 'zh', confidence: 0.85 };
  }
  if (share(count(/\p{Script=Thai}/gu)) > 0.4) return { lang: 'th', confidence: 0.9 };
  if (share(count(/\p{Script=Devanagari}/gu)) > 0.4) return { lang: 'hi', confidence: 0.85 };
  if (share(count(/\p{Script=Georgian}/gu)) > 0.4) return { lang: 'ka', confidence: 0.9 };
  if (share(count(/\p{Script=Armenian}/gu)) > 0.4) return { lang: 'hy', confidence: 0.9 };
  return null;
}

/** Metnin dili. Bağlantı, e-posta adresi, @kullanıcı, emoji ve rakamlar yok sayılır. */
export function detectLanguage(input: string): LangGuess {
  const text = input
    .replace(/https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+|[@#]\w+/gi, ' ')
    .replace(/[\p{N}\p{Extended_Pictographic}]/gu, ' ')
    .trim();
  if (!text) return { lang: null, confidence: 0 };
  const script = scriptOf(text);
  if (script) return script;
  // Türkçe küçültme "Is" → "ıs" yapar (İngilizce kelimeler kaçar); dile özgü harfler zaten metinde yazılı olduğu gibi durur.
  // Türkçe/Azerice kelimeler tr küçültmesiyle, diğerleri genel küçültmeyle karşılaştırılır.
  const lower = text.toLowerCase().normalize('NFC').replace(/i\u0307/g, 'i');
  const lowerTr = text.toLocaleLowerCase('tr-TR').normalize('NFC');
  const words = lower.split(/[^\p{L}']+/u).filter(Boolean);
  const wordsTr = lowerTr.split(/[^\p{L}']+/u).filter(Boolean);
  const letters = (lower.match(/\p{L}/gu) ?? []).length;
  if (letters < 6 || words.length < 2) return { lang: null, confidence: 0 };
  const score: Record<string, number> = {};
  const add = (l: string, n: number) => (score[l] = (score[l] ?? 0) + n);
  for (const [lang, list] of Object.entries(WORDS)) {
    const set = new Set(list);
    let n = 0;
    for (const w of lang === 'tr' || lang === 'az' ? wordsTr : words) if (set.has(w) || set.has(w.split("'")[0])) n++;
    if (n) add(lang, n * 1.2);
  }
  // İngilizce/Almanca 'I' (büyük i) Türkçe küçültmede ı olur; ayrıca İngilizce "i" zamiri
  if (/\bI\b/.test(text)) add('en', 1);
  for (const [lang, re, w] of CHARS) {
    const n = (lower.match(re) ?? []).length;
    if (n) add(lang, Math.min(6, n * w));
  }
  // Türkçe ekler (apostrof sonrası ya da sık son ekler)
  const trSuffix = wordsTr.filter((w) => /(lar|ler|dır|dir|dur|dür|mış|miş|yor|yoruz|acak|ecek|sın|sin|ım|im|um|üm|dan|den|tan|ten|yız|yiz|yuz|yüz|nız|niz)$/.test(w)).length;
  if (trSuffix) add('tr', trSuffix * 0.5);
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { lang: null, confidence: 0 };
  const [top, second] = ranked;
  const total = ranked.reduce((s, [, v]) => s + v, 0);
  const confidence = Math.max(0, Math.min(1, (top[1] - (second?.[1] ?? 0)) / Math.max(total, 1) + Math.min(0.3, top[1] / 20)));
  // tek zayıf işaret: karar verme
  if (top[1] < 1.2 || confidence < 0.15) return { lang: null, confidence };
  return { lang: top[0], confidence };
}

/** Birden çok mesajdan baskın dil (son gelen mesajlar → yanıtın çevrileceği dil). Metin uzunluğuyla ağırlıklı. */
export function dominantLanguage(texts: string[]): LangGuess {
  const w: Record<string, number> = {};
  let total = 0;
  for (const t of texts) {
    const g = detectLanguage(t);
    if (!g.lang) continue;
    const weight = Math.min(200, t.length) * (0.5 + g.confidence);
    w[g.lang] = (w[g.lang] ?? 0) + weight;
    total += weight;
  }
  const top = Object.entries(w).sort((a, b) => b[1] - a[1])[0];
  if (!top || !total) return { lang: null, confidence: 0 };
  return { lang: top[0], confidence: top[1] / total };
}
