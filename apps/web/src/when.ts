/**
 * "Takvime ekle" ön doldurma: mesaj metninden tarih/saat tahmini (Türkçe + temel İngilizce).
 * Yalnızca öneri; kullanıcı pencerede düzeltir. Bulamazsa yarın, saatsiz döner.
 */
const MONTHS = ['ocak', 'şubat', 'mart', 'nisan', 'mayıs', 'haziran', 'temmuz', 'ağustos', 'eylül', 'ekim', 'kasım', 'aralık'];
// Pazartesi = 1 … Pazar = 0 (Date.getDay ile aynı)
const DAYS: Record<string, number> = { pazar: 0, pazartesi: 1, salı: 2, çarşamba: 3, perşembe: 4, cuma: 5, cumartesi: 6 };

/** JS'in \b'si ı, ş, ç gibi harfleri tanımaz: Unicode harf/rakam sınırıyla değiştirip 'u' bayrağıyla derle */
const WB = '(?:(?<![\\p{L}\\d])(?=[\\p{L}\\d])|(?<=[\\p{L}\\d])(?![\\p{L}\\d]))';
const U = (r: RegExp | string) => new RegExp((typeof r === 'string' ? r : r.source).replaceAll('\\b', WB), 'u');

const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export interface GuessedWhen {
  date: string;
  time?: string;
  /** Metinde gerçekten bir tarih/saat bulundu mu (yoksa varsayılan) */
  found: boolean;
}

export function guessWhen(text: string, now = new Date()): GuessedWhen {
  const t = text.toLocaleLowerCase('tr');
  let date: Date | undefined;
  /** Tarih olarak okunan parça saat aramasından çıkarılır ("05.10" hem tarih hem 05:10 sanılmasın) */
  let rest = t;
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const plus = (n: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);

  if (U(/\b(öbür|ertesi) gün\b|\byarından sonra\b/).test(t)) date = plus(2);
  else if (U(/\byarın\b|\btomorrow\b/).test(t)) date = plus(1);
  else if (U(/\bbugün\b|\bbu akşam\b|\btoday\b|\btonight\b/).test(t)) date = plus(0);

  if (!date) {
    // "12 Ekim", "12 ekim 2026"
    const m = U(`\\b(\\d{1,2})\\s+(${MONTHS.join('|')})(?:\\s+(\\d{4}))?`).exec(t);
    if (m) {
      const y = m[3] ? Number(m[3]) : now.getFullYear();
      date = new Date(y, MONTHS.indexOf(m[2]), Number(m[1]));
      if (!m[3] && date < base) date = new Date(y + 1, MONTHS.indexOf(m[2]), Number(m[1]));
    }
  }
  if (!date) {
    // "12.10", "12/10/2026" (gün önce; saatle karışmasın diye ayraçtan sonra 1-12 ay ve saat bağlamı yoksa)
    // ondalık miktar/tutar ("2.5 kg", "1.5 yıl", "10.10 TL") tarih sayılmaz
    const m = U(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b(?!\s*'?(?:de|da|te|ta)\b)(?!\s*(?:kg|gr|g|lt|l|ml|km|m|cm|tl|₺|lira|\$|usd|eur|€|yıl|ay|hafta|gün|saat|dk|dakika|%)(?![a-zçğıöşü\d]))/).exec(t);
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[1]) <= 31 && (m[3] || !U(/\bsaat\b/).test(t))) {
      const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : now.getFullYear();
      const d = new Date(y, Number(m[2]) - 1, Number(m[1]));
      if (d.getMonth() === Number(m[2]) - 1) {
        date = !m[3] && d < base ? new Date(y + 1, Number(m[2]) - 1, Number(m[1])) : d;
        rest = t.replace(m[0], ' ');
      }
    }
  }
  if (!date) {
    const m = U(`\\b(haftaya\\s+)?(${Object.keys(DAYS).sort((a, b) => b.length - a.length).join('|')})\\b`).exec(t);
    if (m) {
      // "cuma" = önümüzdeki ilk cuma; "haftaya cuma" = gelecek haftanın (pazartesiyle başlayan) cuması
      const diff = m[1] ? ((8 - base.getDay()) % 7 || 7) + ((DAYS[m[2]] + 6) % 7) : (DAYS[m[2]] - base.getDay() + 7) % 7 || 7;
      date = plus(diff);
    }
  }

  // saat: "14:30", "14.30", "saat 9", "9'da", "akşam 8"
  let time: string | undefined;
  // tutarlar ("14.30 TL") saat değildir
  const hm = U(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b(?!\s*(?:tl|₺|lira|\$|usd|eur|€))/).exec(rest.replace(/\d{1,2}[./]\d{1,2}[./]\d{2,4}/g, ''));
  if (hm) time = `${pad(Number(hm[1]))}:${hm[2]}`;
  else {
    const h = U(/\b(?:saat\s+)?(sabah|öğleden sonra|öğlen|akşam|gece)?\s*(\d{1,2})\s*(?:'?(?:de|da|te|ta)\b|\s*gibi\b)/).exec(rest) ?? U(/\bsaat\s+(sabah|öğleden sonra|öğlen|akşam|gece)?\s*(\d{1,2})\b/).exec(rest);
    if (h && Number(h[2]) <= 23) {
      let hour = Number(h[2]);
      if (h[1] === 'gece') {
        // "gece 12" = 00:00, "gece 2" = 02:00, "gece 11" = 23:00
        if (hour === 12) hour = 0;
        else if (hour >= 6 && hour < 12) hour += 12;
      } else if (h[1] && U(/öğleden sonra|öğlen|akşam/).test(h[1]) && hour >= 1 && hour < 12) hour += 12;
      else if (!h[1] && hour >= 1 && hour <= 7) hour += 12; // "3'te" iş saati olarak 15:00
      time = `${pad(hour)}:00`;
    }
  }
  if (!date && time) date = plus(0);
  return { date: ymd(date ?? plus(1)), time, found: !!date };
}
