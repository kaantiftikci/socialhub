/**
 * "Senin tarzında taslak": kullanıcının kendi yazdığı mesajlardan yerel üslup profili.
 * Hiçbir yere gönderilmez; yalnızca AI taslak isteminde ve arayüzdeki "Tarzın" satırında kullanılır.
 */
export interface StyleProfile {
  /** İncelenen mesaj sayısı */
  samples: number;
  /** Ortalama uzunluk (karakter) */
  avgLength: number;
  /** Emoji içeren mesaj oranı (0-1) */
  emojiRate: number;
  /** En sık kullanılan emojiler */
  topEmojis: string[];
  /** Küçük harfle başlayan mesaj oranı */
  lowercaseRate: number;
  /** Nokta/ünlem/soru işaretiyle biten mesaj oranı */
  punctuationRate: number;
  /** Ünlem kullanan mesaj oranı */
  exclaimRate: number;
  /** Hitap: 'siz' (resmî), 'sen' (samimi) ya da belirsiz */
  address: 'siz' | 'sen' | 'mixed';
  /** Mesajların çoğu hangi dilde */
  language: 'tr' | 'en' | 'mixed';
  /** Sık açılış kalıpları ("Merhaba", "Selam") */
  greetings: string[];
  /** Sık kapanış kalıpları ("Teşekkürler", "İyi çalışmalar") */
  signoffs: string[];
}

const EMOJI = /\p{Extended_Pictographic}/gu;
const SIZ = /\b(siz|size|sizin|sizi|sizden|sizinle)\b|(?:[ıiuü]n[ıiuü]z|s[ıiuü]n[ıiuü]z|yorsunuz|abilir misiniz|ebilir misiniz|misiniz|mısınız|musunuz|müsünüz)\b/i;
const SEN = /\b(sen|sana|senin|seni|senden|seninle|kanka|abi|abla|kardeşim)\b|(?:yorsun|misin|mısın|musun|müsün|abilir misin|ebilir misin)\b/i;
const TR = /[çğıöşüÇĞİÖŞÜ]|\b(ve|bir|bu|için|ama|evet|hayır|tamam|merhaba|selam|teşekkür|olur|değil|nasıl)\b/i;
const EN = /\b(the|and|you|is|are|thanks|thank|hi|hello|ok|okay|sure|will|can|please|yes|no)\b/i;
const GREET = /^(merhaba(lar)?|selam(lar)?|slm|mrb|iyi (günler|akşamlar|sabahlar)|günaydın|hey|hi|hello|dear)\b/i;
const SIGNOFF = /(teşekkür(ler| ederim)|tşk|sağ ?ol(un)?|iyi (çalışmalar|günler|akşamlar)|görüşürüz|kolay gelsin|sevgiler|saygılar(ımla)?|thanks|cheers|best|regards)[\s!.🙏😊]*$/i;

const cap = (w: string) => w[0].toLocaleUpperCase('tr') + w.slice(1).toLocaleLowerCase('tr');
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

function top(counts: Map<string, number>, n: number, min = 2): string[] {
  return [...counts.entries()]
    .filter(([, c]) => c >= min)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

export function analyzeStyle(texts: string[]): StyleProfile {
  const list = texts.map((t) => t.trim()).filter((t) => t.length > 0 && !/^https?:\/\/\S+$/.test(t));
  const n = list.length || 1;
  const emojis = new Map<string, number>();
  const greets = new Map<string, number>();
  const signs = new Map<string, number>();
  let len = 0, withEmoji = 0, lower = 0, punct = 0, exclaim = 0, siz = 0, sen = 0, tr = 0, en = 0;
  for (const t of list) {
    len += t.length;
    const em = t.match(EMOJI);
    if (em) {
      withEmoji++;
      for (const e of em) bump(emojis, e);
    }
    const first = t.match(/\p{L}/u)?.[0];
    if (first && first === first.toLocaleLowerCase('tr') && first !== first.toLocaleUpperCase('tr')) lower++;
    if (/[.!?…]\s*\p{Extended_Pictographic}*\s*$/u.test(t)) punct++;
    if (t.includes('!')) exclaim++;
    if (SIZ.test(t)) siz++;
    if (SEN.test(t)) sen++;
    if (TR.test(t)) tr++;
    else if (EN.test(t)) en++;
    const g = t.match(GREET)?.[0];
    if (g) bump(greets, cap(g));
    const s = t.match(SIGNOFF)?.[1];
    if (s) bump(signs, cap(s));
  }
  return {
    samples: list.length,
    avgLength: Math.round(len / n),
    emojiRate: withEmoji / n,
    topEmojis: top(emojis, 4),
    lowercaseRate: lower / n,
    punctuationRate: punct / n,
    exclaimRate: exclaim / n,
    address: siz > sen * 2 ? 'siz' : sen > siz * 2 ? 'sen' : 'mixed',
    language: tr > en * 3 ? 'tr' : en > tr * 3 ? 'en' : 'mixed',
    greetings: top(greets, 3),
    signoffs: top(signs, 3),
  };
}

/** Profili kısa Türkçe maddelere çevir (istem ve arayüz için). Yeterli örnek yoksa boş liste. */
export function describeStyle(p: StyleProfile): string[] {
  if (p.samples < 5) return [];
  const out: string[] = [];
  out.push(p.avgLength < 40 ? 'çok kısa yazar' : p.avgLength < 110 ? 'kısa-orta uzunlukta yazar' : 'uzun, ayrıntılı yazar');
  if (p.address === 'siz') out.push('"siz" diye hitap eder (resmî)');
  else if (p.address === 'sen') out.push('"sen" diye hitap eder (samimi)');
  if (p.emojiRate >= 0.25) out.push(`sık emoji kullanır${p.topEmojis.length ? ` (${p.topEmojis.join(' ')})` : ''}`);
  else if (p.emojiRate >= 0.08) out.push(`ara sıra emoji kullanır${p.topEmojis.length ? ` (${p.topEmojis.slice(0, 2).join(' ')})` : ''}`);
  else out.push('emoji kullanmaz');
  if (p.lowercaseRate >= 0.6) out.push('cümleye küçük harfle başlar');
  if (p.punctuationRate < 0.3) out.push('mesaj sonuna genelde noktalama koymaz');
  if (p.exclaimRate >= 0.3) out.push('ünlem işaretini sever');
  if (p.greetings.length) out.push(`açılışta "${p.greetings.join('", "')}" der`);
  if (p.signoffs.length) out.push(`kapanışta "${p.signoffs.join('", "')}" der`);
  if (p.language === 'en') out.push('çoğunlukla İngilizce yazar');
  else if (p.language === 'mixed') out.push('Türkçe ve İngilizce karışık yazar');
  return out;
}
