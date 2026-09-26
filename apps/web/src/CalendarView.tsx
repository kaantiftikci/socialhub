import { useEffect, useMemo, useState } from 'react';
import { api, type DeviceCalendars } from './api';
import { PLATFORMS, type CalEvent, type CalendarDraft, type Chat } from './types';
import { Chip, Icon } from './ui';

/* ───────────────────────── yardımcılar ───────────────────────── */

const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s: string) => {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
};
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const WEEKDAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
const timeOf = (e: CalEvent) => (e.allDay || !e.start.includes('T') ? '' : e.start.slice(11, 16));
const endTime = (e: CalEvent) => {
  if (e.allDay || !e.start.includes('T')) return '';
  const [h, m] = e.start.slice(11, 16).split(':').map(Number);
  const t = h * 60 + m + (e.durationMin ?? 60);
  return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`;
};
const REMIND: Array<[number | null, string]> = [
  [null, 'Yok'],
  [0, 'Başlarken'],
  [5, '5 dk önce'],
  [10, '10 dk önce'],
  [15, '15 dk önce'],
  [30, '30 dk önce'],
  [60, '1 saat önce'],
  [1440, '1 gün önce'],
];
const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* yok */
  }
};
const CAL_CONSENT = 'mivelo.calConsent';
const CAL_NAME = 'mivelo.calName';
const CAL_DEVICE = 'mivelo.calDevice';

/* ───────────────────────── Etkinlik düzenleyici ───────────────────────── */

/**
 * Etkinlik ekle / düzenle. Etkinlik Mivelo takvimine kaydedilir (Takvim görünümü, hatırlatma bildirimi).
 * "Cihaz takvimine de ekle" seçiliyse Mac Takvim / Outlook'a da yazılır: ilk seferde uygulama içi onay, sonra sistem izni.
 */
export function EventEditor({
  initial,
  notify,
  onClose,
}: {
  initial: CalendarDraft & { id?: string; remindMin?: number; location?: string; deviceCalendar?: string };
  notify: (t: string, err?: boolean) => void;
  onClose: () => void;
}) {
  const editing = !!initial.id;
  const [title, setTitle] = useState(initial.title);
  const [date, setDate] = useState(initial.start.slice(0, 10));
  const [time, setTime] = useState(initial.start.slice(11, 16));
  const [duration, setDuration] = useState(initial.durationMin ?? 60);
  const [remind, setRemind] = useState<number | null>(editing ? initial.remindMin ?? null : initial.start.includes('T') ? 15 : null);
  const [location, setLocation] = useState(initial.location ?? '');
  const [notes, setNotes] = useState(initial.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [dev, setDev] = useState<DeviceCalendars | null>(null);
  const [consent, setConsent] = useState(() => lsGet(CAL_CONSENT) === '1');
  const [toDevice, setToDevice] = useState(() => !editing && lsGet(CAL_DEVICE) === '1');
  const [asking, setAsking] = useState(false);
  const [calName, setCalName] = useState(() => lsGet(CAL_NAME) ?? '');
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .calendars(consent)
      .then((d) => {
        if (!alive) return;
        setDev(d);
        if (d.calendars?.length && !d.calendars.includes(calName)) setCalName(d.calendars[0]);
      })
      .catch(() => alive && setDev({ supported: false }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const deviceOk = !!dev?.supported && !initial.deviceCalendar;
  const valid = () => {
    if (!title.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return notify('Başlık ve tarih gerekli', true), false;
    return true;
  };

  async function save(withDevice = toDevice && deviceOk, cal = calName) {
    if (!valid()) return;
    setBusy(true);
    try {
      const r = await api.saveEvent({
        id: initial.id,
        title: title.trim(),
        start: time ? `${date}T${time}` : date,
        durationMin: duration,
        remindMin: remind ?? undefined,
        location: location.trim() || undefined,
        notes: notes.trim() || undefined,
        chatId: initial.chatId,
        messageId: initial.messageId,
        device: withDevice,
        calendar: withDevice ? cal || undefined : undefined,
      });
      if (withDevice && cal) lsSet(CAL_NAME, cal);
      const when = new Date(parseYmd(date)).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' });
      if (r.device?.added) notify(`Takvime eklendi · ${when}${time ? ' ' + time : ''} · ${dev?.app ?? 'Cihaz'}: ${r.device.calendar}`);
      else if (r.device && r.device.denied) notify(`Mivelo takvimine eklendi. ${dev?.app ?? 'Cihaz'} takvimi izni kapalı: Sistem Ayarları → Gizlilik ve Güvenlik → Otomasyon → Mivelo → Takvim`, true);
      else if (r.device) notify(`Mivelo takvimine eklendi; cihaz takvimine eklenemedi (${r.device.error ?? 'hata'})`, true);
      else notify(editing ? 'Etkinlik güncellendi' : `Takvime eklendi · ${when}${time ? ' ' + time : ''}`);
      onClose();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  /** Uygulama içi onay → sistem izni (macOS bir kez sorar) → takvim adları → kaydet */
  async function allowAndSave() {
    if (!valid()) return;
    lsSet(CAL_CONSENT, '1');
    setConsent(true);
    setAsking(false);
    setBusy(true);
    try {
      const d = await api.calendars(true);
      setDev(d);
      const cal = d.calendars?.includes(calName) ? calName : d.calendars?.[0] ?? '';
      setCalName(cal);
      await save(!d.denied, cal);
      if (d.denied) notify(`${d.app ?? 'Cihaz'} takvimi izni verilmedi; etkinlik yalnız Mivelo takviminde`, true);
    } finally {
      setBusy(false);
    }
  }
  function submit() {
    if (toDevice && deviceOk && !consent) return setAsking(true);
    void save();
  }
  async function exportIcs() {
    if (!valid()) return;
    try {
      const r = await api.calendar({ title: title.trim(), start: time ? `${date}T${time}` : date, durationMin: duration, notes: notes.trim() || undefined, mode: 'file' });
      if (r.opened) notify('Takvim dosyası takvim uygulamasında açıldı');
      else {
        const url = URL.createObjectURL(new Blob([r.ics], { type: 'text/calendar' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `${title.trim().replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60) || 'etkinlik'}.ics`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  async function remove() {
    if (!initial.id) return;
    try {
      await api.deleteEvent(initial.id);
      notify('Etkinlik silindi' + (initial.deviceCalendar ? ` (${dev?.app ?? 'cihaz'} takvimindeki kopyayı oradan sil)` : ''));
      onClose();
    } catch (e) {
      notify((e as Error).message, true);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal cal-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={editing ? 'Etkinliği düzenle' : 'Takvime ekle'} onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), onClose())}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="calendar" size={20} color="var(--v)" />
          <h2 style={{ fontSize: 20 }}>{editing ? 'Etkinliği düzenle' : 'Takvime ekle'}</h2>
          <span style={{ flexGrow: 1 }} />
          <button className="btn icon b b2" onClick={onClose} aria-label="Kapat">
            <Icon name="x" size={15} sw={2} />
          </button>
        </div>
        <label className="fld">
          <span>Başlık</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </label>
        <div className="fld-row">
          <label className="fld">
            <span>Tarih</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="fld">
            <span>Saat</span>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <label className="fld">
            <span>Süre</span>
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} disabled={!time}>
              {[15, 30, 45, 60, 90, 120, 180, 240].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} dk` : `${m / 60} sa`}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!time && <span className="hint">Saat boşsa tüm gün etkinlik olarak eklenir.</span>}
        <div className="fld-row">
          <label className="fld">
            <span>Hatırlat</span>
            <select value={remind === null ? '' : String(remind)} onChange={(e) => setRemind(e.target.value === '' ? null : Number(e.target.value))} disabled={!time}>
              {REMIND.map(([v, l]) => (
                <option key={l} value={v === null ? '' : String(v)}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="fld" style={{ flex: 2 }}>
            <span>Konum</span>
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="İsteğe bağlı (adres, Zoom…)" />
          </label>
        </div>
        <label className="fld">
          <span>Not</span>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="İsteğe bağlı" />
        </label>
        {deviceOk && (
          <label className="cal-dev">
            <input type="checkbox" checked={toDevice} onChange={(e) => (setToDevice(e.target.checked), lsSet(CAL_DEVICE, e.target.checked ? '1' : '0'))} />
            <span>
              <b>{dev?.app === 'Outlook' ? 'Outlook takvimine' : 'Cihazın Takvim uygulamasına'} de ekle</b>
              <em>{consent ? 'Telefonuna da eşitlenir (iCloud / Google hesabı takvimlerinde)' : 'İlk seferde izin istenir'}</em>
            </span>
            {toDevice && consent && (dev?.calendars?.length ?? 0) > 1 && (
              <select value={calName} onChange={(e) => (setCalName(e.target.value), lsSet(CAL_NAME, e.target.value))} onClick={(e) => e.stopPropagation()}>
                {dev!.calendars!.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </label>
        )}
        {initial.deviceCalendar && <span className="hint">Cihaz takviminde de var: {initial.deviceCalendar} (değişiklikler oraya yansımaz)</span>}
        {asking && (
          <div className="cal-consent" role="alertdialog" aria-label="Takvim izni">
            <Icon name="shield" size={18} color="var(--v)" />
            <div>
              <b>Etkinlikler {dev?.app === 'Outlook' ? 'Outlook takvimine' : 'cihazının Takvim uygulamasına'} de eklensin mi?</b>
              <span>
                {dev?.app === 'Outlook' ? 'Mivelo etkinliği Outlook takvimine de kaydeder.' : 'macOS bir kez “Mivelo, Takvim’i denetlemek istiyor” diye soracak; İzin Ver de.'} Takvimdeki etkinlikler okunmaz, hiçbir yere
                gönderilmez; yalnız takvim adları seçim için listelenir. Onay bu cihazda hatırlanır.
              </span>
              <div className="cal-consent-bar">
                <button className="btn ghost sm b" onClick={() => (setAsking(false), setToDevice(false), void save(false))} disabled={busy}>
                  Yalnız Mivelo'ya ekle
                </button>
                <button className="btn primary sm b b2" onClick={() => void allowAndSave()} disabled={busy}>
                  {busy ? <span className="spin" /> : <Icon name="check" size={14} sw={2} />} İzin ver ve ekle
                </button>
              </div>
            </div>
          </div>
        )}
        {!asking && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {editing &&
              (confirmDel ? (
                <button className="btn sm b danger-solid" onClick={() => void remove()}>
                  Sil — emin misin?
                </button>
              ) : (
                <button className="btn ghost sm b" style={{ color: 'var(--danger)' }} onClick={() => setConfirmDel(true)}>
                  <Icon name="trash" size={14} /> Sil
                </button>
              ))}
            <button className="btn ghost sm b" onClick={() => void exportIcs()} title=".ics dosyası (başka takvime aktarmak için)">
              Dışa aktar
            </button>
            <span style={{ flexGrow: 1 }} />
            <button className="btn b b2" onClick={onClose}>
              Vazgeç
            </button>
            <button className="btn primary b b2" onClick={submit} disabled={busy}>
              {busy ? <span className="spin" /> : <Icon name={editing ? 'check' : 'calendar'} size={14} />} {editing ? 'Kaydet' : 'Takvime ekle'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── Takvim görünümü ───────────────────────── */

/**
 * Mivelo takvimi: ay görünümü + seçili günün ajandası. Mesajlardan "Takvime ekle" ile gelenler sohbet bağlantısıyla
 * görünür ("Sohbete git"); buradan elle de etkinlik eklenir / düzenlenir / silinir.
 */
export function CalendarView({
  chats,
  notify,
  onOpenChat,
  onMenu,
  refreshKey,
}: {
  chats: Map<string, Chat>;
  notify: (t: string, err?: boolean) => void;
  onOpenChat: (chatId: string, messageId?: string) => void;
  onMenu?: () => void;
  refreshKey: number;
}) {
  const today = ymd(new Date());
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [sel, setSel] = useState(today);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [edit, setEdit] = useState<(CalendarDraft & { id?: string; remindMin?: number; location?: string; deviceCalendar?: string }) | null>(null);

  // ızgara: pazartesiden başlayan 6 hafta
  const cells = useMemo(() => {
    const first = new Date(month);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [month]);
  const from = ymd(cells[0]);
  const to = ymd(new Date(cells[41].getFullYear(), cells[41].getMonth(), cells[41].getDate() + 1));
  useEffect(() => {
    let alive = true;
    api
      .events(from, to)
      .then((l) => alive && setEvents(l))
      .catch((e) => notify((e as Error).message, true));
    return () => {
      alive = false;
    };
  }, [from, to, refreshKey, notify]);

  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of events) m.set(e.start.slice(0, 10), [...(m.get(e.start.slice(0, 10)) ?? []), e]);
    for (const l of m.values()) l.sort((a, b) => Number(!a.allDay) - Number(!b.allDay) || a.start.localeCompare(b.start));
    return m;
  }, [events]);
  const dayEvents = byDay.get(sel) ?? [];
  const upcoming = useMemo(() => events.filter((e) => e.start.slice(0, 10) >= today).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 6), [events, today]);

  const go = (delta: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));
  const goToday = () => {
    const d = new Date();
    setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    setSel(today);
  };
  const newAt = (day: string) => setEdit({ title: '', start: `${day}T09:00`, durationMin: 60 });
  const openEvent = (e: CalEvent) => setEdit({ id: e.id, title: e.title, start: e.start, durationMin: e.durationMin, notes: e.notes, remindMin: e.remindMin, location: e.location, deviceCalendar: e.deviceCalendar, chatId: e.chatId, messageId: e.messageId });
  const selDate = parseYmd(sel);

  // klavye: ← → ay, T bugün, N yeni
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (edit || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key.toLowerCase() === 't') goToday();
      else if (e.key.toLowerCase() === 'n') (e.preventDefault(), newAt(sel));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const chip = (e: CalEvent) => {
    const c = e.chatId ? chats.get(e.chatId) : undefined;
    return (
      <button key={e.id} type="button" className={`cv-chip ${e.allDay ? 'all' : ''}`} title={`${timeOf(e) ? timeOf(e) + ' ' : ''}${e.title}`} onClick={(ev) => (ev.stopPropagation(), setSel(e.start.slice(0, 10)), openEvent(e))}>
        {c && <Chip platform={c.platform} size={12} />}
        {timeOf(e) && <time>{timeOf(e)}</time>}
        <span>{e.title}</span>
      </button>
    );
  };

  return (
    <section className="calview" aria-label="Takvim">
      <div className="cv-head">
        {onMenu && (
          <button className="btn icon b b2" aria-label="Menü" title="Menü" onClick={onMenu}>
            <Icon name="grip" size={16} sw={2} />
          </button>
        )}
        <h1>
          {MONTHS[month.getMonth()]} <em>{month.getFullYear()}</em>
        </h1>
        <div className="cv-nav">
          <button className="btn icon sm b b2" aria-label="Önceki ay" title="Önceki ay (←)" onClick={() => go(-1)}>
            <Icon name="chev" size={14} sw={2} />
          </button>
          <button className="btn sm b b2" onClick={goToday} title="Bugün (T)">
            Bugün
          </button>
          <button className="btn icon sm b b2 next" aria-label="Sonraki ay" title="Sonraki ay (→)" onClick={() => go(1)}>
            <Icon name="chev" size={14} sw={2} />
          </button>
        </div>
        <span style={{ flexGrow: 1 }} />
        <button className="btn primary b" onClick={() => newAt(sel)} title="Yeni etkinlik (N)">
          <Icon name="plus" size={15} sw={2} /> Etkinlik ekle
        </button>
      </div>

      <div className="cv-body">
        <div className="cv-month" role="grid" aria-label={`${MONTHS[month.getMonth()]} ${month.getFullYear()}`}>
          {WEEKDAYS.map((w) => (
            <div key={w} className="cv-wd" role="columnheader">
              {w}
            </div>
          ))}
          {cells.map((d) => {
            const k = ymd(d);
            const list = byDay.get(k) ?? [];
            const out = d.getMonth() !== month.getMonth();
            return (
              <div
                key={k}
                role="gridcell"
                tabIndex={0}
                aria-selected={k === sel}
                className={`cv-cell ${out ? 'out' : ''} ${k === today ? 'today' : ''} ${k === sel ? 'sel' : ''} ${d.getDay() === 0 || d.getDay() === 6 ? 'we' : ''}`}
                onClick={() => setSel(k)}
                onDoubleClick={() => newAt(k)}
                onKeyDown={(e) => e.key === 'Enter' && newAt(k)}
              >
                <span className="cv-n">{d.getDate()}</span>
                <div className="cv-evs">
                  {list.slice(0, 3).map(chip)}
                  {list.length > 3 && <span className="cv-more">+{list.length - 3} daha</span>}
                </div>
              </div>
            );
          })}
        </div>

        <aside className="cv-side">
          <div className="cv-day">
            <div className="cv-day-h">
              <span>
                <b>{selDate.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' })}</b>
                <em>{selDate.toLocaleDateString('tr-TR', { weekday: 'long' })}{sel === today ? ' · bugün' : ''}</em>
              </span>
              <button className="btn icon sm b b2" aria-label="Bu güne etkinlik ekle" title="Bu güne etkinlik ekle" onClick={() => newAt(sel)}>
                <Icon name="plus" size={14} sw={2} />
              </button>
            </div>
            {dayEvents.length === 0 ? (
              <div className="cv-empty">
                <span>Bu gün boş.</span>
                <button className="btn soft sm b" onClick={() => newAt(sel)}>
                  Etkinlik ekle
                </button>
              </div>
            ) : (
              dayEvents.map((e) => <AgendaItem key={e.id} e={e} chat={e.chatId ? chats.get(e.chatId) : undefined} onEdit={() => openEvent(e)} onOpenChat={onOpenChat} />)
            )}
          </div>
          <div className="cv-up">
            <span className="cv-up-h">Yaklaşan</span>
            {upcoming.length === 0 && <span className="cv-muted">Yaklaşan etkinlik yok. Bir mesajın üstüne gelip 📅 ile ekleyebilirsin.</span>}
            {upcoming.map((e) => {
              const d = parseYmd(e.start);
              const c = e.chatId ? chats.get(e.chatId) : undefined;
              return (
                <button key={e.id} type="button" className="cv-up-row" onClick={() => (setSel(e.start.slice(0, 10)), setMonth(new Date(d.getFullYear(), d.getMonth(), 1)))}>
                  <span className="cv-date">
                    <b>{d.getDate()}</b>
                    <em>{MONTHS[d.getMonth()].slice(0, 3)}</em>
                  </span>
                  <span className="cv-up-t">
                    <b>{e.title}</b>
                    <em>
                      {timeOf(e) ? `${timeOf(e)}–${endTime(e)}` : 'Tüm gün'}
                      {c ? ` · ${c.name}` : ''}
                    </em>
                  </span>
                  {c && <Chip platform={c.platform} size={15} />}
                </button>
              );
            })}
          </div>
        </aside>
      </div>
      {edit && <EventEditor initial={edit} notify={notify} onClose={() => setEdit(null)} />}
    </section>
  );
}

function AgendaItem({ e, chat, onEdit, onOpenChat }: { e: CalEvent; chat?: Chat; onEdit: () => void; onOpenChat: (chatId: string, messageId?: string) => void }) {
  return (
    <div className="cv-item" role="button" tabIndex={0} onClick={onEdit} onKeyDown={(k) => k.key === 'Enter' && onEdit()}>
      <span className="cv-bar" />
      <div className="cv-item-b">
        <span className="cv-time">{timeOf(e) ? `${timeOf(e)} – ${endTime(e)}` : 'Tüm gün'}</span>
        <b>{e.title}</b>
        {e.location && (
          <span className="cv-meta">
            <Icon name="pin" size={12} /> {e.location}
          </span>
        )}
        {e.notes && <span className="cv-notes">{e.notes}</span>}
        <span className="cv-tags">
          {e.remindMin !== undefined && (
            <span className="cv-tag">
              <Icon name="bell" size={11} /> {REMIND.find(([v]) => v === e.remindMin)?.[1] ?? `${e.remindMin} dk önce`}
            </span>
          )}
          {e.deviceCalendar && (
            <span className="cv-tag">
              <Icon name="calendar" size={11} /> {e.deviceCalendar}
            </span>
          )}
          {chat && (
            <button type="button" className="cv-tag go" onClick={(ev) => (ev.stopPropagation(), onOpenChat(chat.id, e.messageId))}>
              <Chip platform={chat.platform} size={12} /> {chat.name} · {PLATFORMS[chat.platform].name}
              <Icon name="arrow" size={11} />
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
