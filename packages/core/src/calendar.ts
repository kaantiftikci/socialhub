import crypto from 'node:crypto';

/**
 * "Takvime ekle": tek etkinlikli .ics (RFC 5545). Mac'te Takvim, Windows'ta Outlook/Takvim dosyayı açınca
 * etkinliği kullanıcı onayıyla ekler; hiçbir takvim hesabına doğrudan erişilmez.
 */
export interface CalendarEvent {
  title: string;
  /** Yerel saat "YYYY-MM-DDTHH:mm" ya da tüm gün "YYYY-MM-DD" */
  start: string;
  /** Dakika (tüm gün değilse); varsayılan 60 */
  durationMin?: number;
  notes?: string;
  location?: string;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** 75 sekizliği aşan satırları katla (RFC 5545 §3.1) */
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) {
      out.push(cur);
      cur = ' ' + ch;
    } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Yerel saat (kayan zaman; TZID'siz): takvim uygulaması kullanıcının saat diliminde yorumlar */
const local = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const day = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

export function parseStart(start: string): { date: Date; allDay: boolean } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(start.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0));
  if (Number.isNaN(date.getTime()) || date.getMonth() !== Number(mo) - 1) return null;
  return { date, allDay: h === undefined };
}

export function buildIcs(ev: CalendarEvent, now = new Date()): string {
  const p = parseStart(ev.start);
  if (!p) throw new Error('Geçersiz tarih');
  const title = ev.title.trim().slice(0, 200) || 'Etkinlik';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mivelo//TR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT'];
  lines.push(`UID:${crypto.randomUUID()}@mivelo`);
  lines.push(`DTSTAMP:${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`);
  if (p.allDay) {
    const end = new Date(p.date);
    end.setDate(end.getDate() + 1);
    lines.push(`DTSTART;VALUE=DATE:${day(p.date)}`, `DTEND;VALUE=DATE:${day(end)}`);
  } else {
    const end = new Date(p.date.getTime() + Math.max(5, Math.min(24 * 60, ev.durationMin ?? 60)) * 60_000);
    lines.push(`DTSTART:${local(p.date)}`, `DTEND:${local(end)}`);
  }
  lines.push(`SUMMARY:${esc(title)}`);
  if (ev.location) lines.push(`LOCATION:${esc(ev.location.slice(0, 200))}`);
  if (ev.notes) lines.push(`DESCRIPTION:${esc(ev.notes.slice(0, 2000))}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
