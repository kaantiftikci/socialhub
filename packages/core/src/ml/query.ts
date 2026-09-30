/**
 * Doğal dil arama sorgusundan basit ipuçları: tarih aralığı ("dün", "geçen ay", "son 2 hafta", "mart 2025") ve kişi
 * ("Ahmet'in", "Ahmet'ten", "Ahmet ile"). Kalan kelimeler anlamsal + tam metin aramaya gider. Bilerek basit: yanlış
 * yakalanan ipucu sonucu boşaltmasın diye kişi ancak gerçek bir sohbet/katılımcı adıyla eşleşirse filtre olur (çağıran karar verir).
 */

export interface QueryHints {
  /** ms (dahil) */
  from?: number;
  /** ms (dahil) */
  to?: number;
  /** Aday kişi adları (küçük harf, eksiz) */
  people: string[];
  /** İpuçları çıkarılmış sorgu */
  rest: string;
  /** Tanınan zaman ifadesi (arayüzde "geçen ay" rozetleri) */
  dateLabel?: string;
}

const MONTHS = ['ocak', 'şubat', 'mart', 'nisan', 'mayıs', 'haziran', 'temmuz', 'ağustos', 'eylül', 'ekim', 'kasım', 'aralık'];
const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Sorguda anlam taşımayan dolgu kelimeleri (tam metin aramayı daraltmasın) */
export const STOPWORDS = new Set([
  've', 'ile', 'bir', 'bu', 'şu', 'o', 'da', 'de', 'mi', 'mı', 'ne', 'için', 'gibi', 'olan', 'olarak', 'hakkında', 'ilgili', 'dair',
  'mesaj', 'mesajı', 'mesajlar', 'mesajları', 'mesajını', 'yazdığı', 'yazdıkları', 'gönderdiği', 'gönderdiğim', 'attığı', 'attığım', 'yolladığı',
  'paylaştığı', 'dediği', 'söylediği', 'bahsettiği', 'konuştuğumuz', 'konuştuğu', 'bana', 'benim', 'bize', 'hani', 'şey', 'şeyi', 'o',
  'the', 'a', 'an', 'of', 'from', 'about', 'sent', 'message', 'messages',
]);

const DAY = 86400e3;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Türkçe ek atılmış kelime kökü: "ahmet'in" → "ahmet", "ayşe'den" → "ayşe" */
export function stripSuffix(w: string): string {
  const i = w.search(/['’]/);
  return i > 0 ? w.slice(0, i) : w;
}

export function parseQuery(q: string, now = new Date()): QueryHints {
  let s = ` ${q.toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ')} `;
  const out: QueryHints = { people: [], rest: '' };
  const take = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    const m = re.exec(s);
    if (!m) return false;
    fn(m);
    s = s.replace(m[0], ' ');
    return true;
  };
  const today = startOfDay(now);
  const setRange = (from: number, to: number, label: string) => {
    if (out.from !== undefined) return;
    out.from = from;
    out.to = to;
    out.dateLabel = label;
  };
  const mondayOf = (t: number) => {
    const d = new Date(t);
    const wd = (d.getDay() + 6) % 7; // pazartesi = 0
    return t - wd * DAY;
  };
  take(/ (bugün|bugünkü|today) /, () => setRange(today, now.getTime(), 'bugün'));
  take(/ (dün|dünkü|yesterday) /, () => setRange(today - DAY, today - 1, 'dün'));
  take(/ (evvelsi gün|önceki gün) /, () => setRange(today - 2 * DAY, today - DAY - 1, 'önceki gün'));
  take(/ son (\d{1,3}) (gün|gündür|hafta|haftada|ay|ayda|yıl|yılda)\w* /, (m) => {
    const n = Number(m[1]);
    const unit = m[2].startsWith('gün') ? DAY : m[2].startsWith('hafta') ? 7 * DAY : m[2].startsWith('ay') ? 30 * DAY : 365 * DAY;
    setRange(now.getTime() - n * unit, now.getTime(), `son ${n} ${m[2].replace(/(da|dür)$/, '')}`);
  });
  take(/ (bu hafta|this week)\w* /, () => setRange(mondayOf(today), now.getTime(), 'bu hafta'));
  take(/ (geçen hafta|last week)\w* /, () => {
    const mon = mondayOf(today);
    setRange(mon - 7 * DAY, mon - 1, 'geçen hafta');
  });
  take(/ (bu ay|this month)\w* /, () => setRange(new Date(now.getFullYear(), now.getMonth(), 1).getTime(), now.getTime(), 'bu ay'));
  take(/ (geçen ay|last month)\w* /, () =>
    setRange(new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), new Date(now.getFullYear(), now.getMonth(), 1).getTime() - 1, 'geçen ay'),
  );
  take(/ (bu yıl|bu sene|this year)\w* /, () => setRange(new Date(now.getFullYear(), 0, 1).getTime(), now.getTime(), 'bu yıl'));
  take(/ (geçen yıl|geçen sene|last year)\w* /, () =>
    setRange(new Date(now.getFullYear() - 1, 0, 1).getTime(), new Date(now.getFullYear(), 0, 1).getTime() - 1, 'geçen yıl'),
  );
  // "mart 2025", "martta", "mart ayında", "2024"
  const monthRe = new RegExp(` (${[...MONTHS, ...MONTHS_EN].join('|')})(?:['’]?(?:ta|te|da|de|ında|inde|unda|ünde|ayında|ayi|ayı))?(?: ayında| ayı)?(?: (\\d{4}))? `);
  take(monthRe, (m) => {
    let mi = MONTHS.indexOf(m[1]);
    if (mi < 0) mi = MONTHS_EN.indexOf(m[1]);
    let y = m[2] ? Number(m[2]) : now.getFullYear();
    // yıl verilmemiş ve ay henüz gelmemişse geçen yılın o ayı
    if (!m[2] && mi > now.getMonth()) y--;
    setRange(new Date(y, mi, 1).getTime(), new Date(y, mi + 1, 1).getTime() - 1, `${MONTHS[mi]} ${y}`);
  });
  take(/ (20\d{2})(?:['’]?(?:de|da|te|ta|yılında|senesinde))? /, (m) => {
    const y = Number(m[1]);
    setRange(new Date(y, 0, 1).getTime(), new Date(y + 1, 0, 1).getTime() - 1, String(y));
  });
  // kişi: ek almış özel isim ("ahmet'in", "ayşe'den", "mehmet'le") ya da "X ile" / "X'e"
  const words = s.split(' ').filter(Boolean);
  const rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^[\p{L}]{2,}['’](in|ın|un|ün|nin|nın|nun|nün|den|dan|ten|tan|le|la|e|a|ye|ya|ne|na|i|ı|u|ü|yi|yı|yu|yü)$/u.test(w)) {
      out.people.push(stripSuffix(w));
      continue;
    }
    if (words[i + 1] === 'ile' && i + 1 < words.length && !STOPWORDS.has(w) && w.length >= 3) {
      out.people.push(w);
      i++;
      continue;
    }
    rest.push(w);
  }
  out.rest = rest.join(' ').trim();
  return out;
}

/** Tam metin arama için anlamlı kelimeler (dolgu kelimeleri ve tek harfler atılır) */
export function keywords(rest: string): string[] {
  return rest
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}
