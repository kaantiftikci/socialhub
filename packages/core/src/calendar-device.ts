import { execFile } from 'node:child_process';
import { IS_MAC, IS_WINDOWS } from './platform.js';
import { parseStart, type CalendarEvent } from './calendar.js';

/**
 * Cihazın kendi takvimine doğrudan ekleme (indirme / .ics açma yok):
 * - macOS: Takvim uygulaması (JXA / Apple Events). İlk kullanımda macOS "Mivelo, Takvim'i denetlemek istiyor" izni sorar
 *   (Info.plist NSAppleEventsUsageDescription). Takvim içeriği okunmaz; yalnız yazılabilir takvimlerin adları listelenir.
 * - Windows: Outlook (klasik, COM). Yeni Outlook / Outlook yoksa çağıran .ics dosyasını takvim uygulamasında açar.
 * - Diğer: desteklenmez (çağıran .ics'e düşer).
 * Değerler betiğe metin olarak gömülmez; JSON argüman / ortam değişkeniyle geçer (enjeksiyon yok).
 */
export type DeviceCalendarError = Error & { code?: 'denied' | 'unsupported' | 'no-calendar' | 'failed' };

const err = (code: NonNullable<DeviceCalendarError['code']>, message: string): DeviceCalendarError => Object.assign(new Error(message), { code });

export function deviceCalendarApp(): string | null {
  if (IS_MAC) return 'Takvim';
  if (IS_WINDOWS) return 'Outlook';
  return null;
}

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeout: number }): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: opts.timeout, env: opts.env ?? process.env, windowsHide: true, maxBuffer: 1 << 20 }, (e, out, stderr) => {
      if (e) reject(Object.assign(new Error(String(stderr || e.message).trim()), { killed: (e as { killed?: boolean }).killed }));
      else resolve(String(out).trim());
    }),
  );
}

/** macOS Apple Events izni reddedildi mi (-1743 / errAEEventNotPermitted) */
const isDenied = (m: string) => /-1743|not authori[sz]ed|izin verilmedi|yetkili değil/i.test(m);

export const LIST_JXA = `function run(argv) {
  var C = Application('Calendar');
  var out = [];
  var cals = C.calendars();
  for (var i = 0; i < cals.length; i++) { try { if (cals[i].writable()) out.push(cals[i].name()); } catch (e) {} }
  return JSON.stringify(out);
}`;

export const ADD_JXA = `function run(argv) {
  var a = JSON.parse(argv[0]);
  var C = Application('Calendar');
  var cal = null;
  if (a.calendar) { var m = C.calendars.whose({ name: a.calendar })(); for (var j = 0; j < m.length; j++) { try { if (m[j].writable()) { cal = m[j]; break; } } catch (e) {} } }
  if (!cal) { var all = C.calendars(); for (var i = 0; i < all.length; i++) { try { if (all[i].writable()) { cal = all[i]; break; } } catch (e) {} } }
  if (!cal) throw new Error('NO_CALENDAR');
  var s = new Date(a.y, a.mo, a.d, a.h, a.mi);
  var e = a.allDay ? new Date(a.y, a.mo, a.d + 1) : new Date(s.getTime() + a.dur * 60000);
  var p = { summary: a.title, startDate: s, endDate: e, alldayEvent: a.allDay };
  if (a.notes) p.description = a.notes;
  if (a.location) p.location = a.location;
  cal.events.push(C.Event(p));
  return cal.name();
}`;

/** Yazılabilir takvimlerin adları (macOS). İlk çağrıda macOS izin penceresi çıkar; kullanıcı yanıtlayana dek bekler. */
export async function listDeviceCalendars(): Promise<string[]> {
  if (IS_MAC) {
    try {
      const out = await run('osascript', ['-l', 'JavaScript', '-e', LIST_JXA], { timeout: 120_000 });
      const names = JSON.parse(out || '[]') as string[];
      return [...new Set(names.filter((n) => typeof n === 'string' && n.trim()))];
    } catch (e) {
      const m = (e as Error).message;
      if (isDenied(m)) throw err('denied', 'Takvim izni verilmedi');
      throw err('failed', `Takvimler okunamadı: ${m.slice(0, 160)}`);
    }
  }
  if (IS_WINDOWS) return ['Outlook'];
  throw err('unsupported', 'Bu sistemde cihaz takvimine doğrudan ekleme yok');
}

/** Etkinliği cihaz takvimine ekle; eklenen takvimin adını döndürür */
export async function addToDeviceCalendar(ev: CalendarEvent, calendar?: string): Promise<string> {
  const p = parseStart(ev.start);
  if (!p) throw err('failed', 'Geçersiz tarih');
  const d = p.date;
  const dur = Math.max(5, Math.min(24 * 60, ev.durationMin ?? 60));
  const title = ev.title.trim().slice(0, 200) || 'Etkinlik';
  if (IS_MAC) {
    const args = { title, y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), dur, allDay: p.allDay, notes: ev.notes?.slice(0, 2000), location: ev.location?.slice(0, 200), calendar };
    try {
      return (await run('osascript', ['-l', 'JavaScript', '-e', ADD_JXA, JSON.stringify(args)], { timeout: 120_000 })) || calendar || 'Takvim';
    } catch (e) {
      const m = (e as Error).message;
      if (isDenied(m)) throw err('denied', 'Takvim izni verilmedi');
      if (/NO_CALENDAR/.test(m)) throw err('no-calendar', 'Takvim uygulamasında yazılabilir takvim yok');
      throw err('failed', m.slice(0, 200));
    }
  }
  if (IS_WINDOWS) {
    const pad = (n: number) => String(n).padStart(2, '0');
    const start = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$a = $env:MIVELO_EVENT | ConvertFrom-Json',
      '$o = New-Object -ComObject Outlook.Application',
      '$i = $o.CreateItem(1)',
      '$i.Subject = $a.title',
      "$i.Start = [datetime]::ParseExact($a.start, 'yyyy-MM-dd HH:mm', $null)",
      'if ($a.allDay) { $i.AllDayEvent = $true } else { $i.Duration = [int]$a.dur }',
      'if ($a.notes) { $i.Body = $a.notes }',
      'if ($a.location) { $i.Location = $a.location }',
      '$i.Save()',
      "'Outlook'",
    ].join('; ');
    try {
      return await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        timeout: 60_000,
        env: { ...process.env, MIVELO_EVENT: JSON.stringify({ title, start, dur, allDay: p.allDay, notes: ev.notes?.slice(0, 2000) ?? '', location: ev.location?.slice(0, 200) ?? '' }) },
      });
    } catch (e) {
      throw err('failed', `Outlook'a eklenemedi: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  throw err('unsupported', 'Bu sistemde cihaz takvimine doğrudan ekleme yok');
}
