import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ADD_JXA, LIST_JXA, addToDeviceCalendar, deviceCalendarApp } from '../src/calendar-device.js';

/** Takvim uygulamasının JXA nesne modeli taklidi (Calendar.app sözlüğü: calendars(), writable(), name(), events.push, Event()) */
function fakeCalendar() {
  const added: Array<{ cal: string; props: Record<string, unknown> }> = [];
  const mk = (name: string, writable: boolean) => ({ name: () => name, writable: () => writable, events: { push: (e: { props: Record<string, unknown> }) => added.push({ cal: name, props: e.props }) } });
  const cals = [mk('Doğum günleri', false), mk('Kişisel', true), mk('İş', true)];
  const calendars = Object.assign(() => cals, { whose: (q: { name: string }) => () => cals.filter((c) => c.name() === q.name) });
  const App = () => ({ calendars, Event: (props: Record<string, unknown>) => ({ props }) });
  return { App, added };
}

test('takvim (JXA): yazılabilir takvimler listelenir; etkinlik seçilen takvime, değerler argümanla (enjeksiyonsuz) eklenir', () => {
  const { App, added } = fakeCalendar();
  const ctx = vm.createContext({ Application: App, JSON, Date });
  vm.runInContext(LIST_JXA, ctx);
  assert.deepEqual(JSON.parse(vm.runInContext('run([])', ctx) as string), ['Kişisel', 'İş']);

  vm.runInContext(ADD_JXA, ctx);
  const title = `Görüşme "tırnak" '); do shell script "rm -rf ~" --`;
  const args = { title, y: 2026, mo: 9, d: 2, h: 14, mi: 30, dur: 45, allDay: false, notes: 'Ayşe: Perşembe 14:30', calendar: 'İş' };
  ctx.argv = [JSON.stringify(args)];
  assert.equal(vm.runInContext('run(argv)', ctx), 'İş');
  const ev = added[0];
  assert.equal(ev.cal, 'İş');
  assert.equal(ev.props.summary, title, 'başlık olduğu gibi (betik metnine gömülmez)');
  assert.equal((ev.props.startDate as Date).getHours(), 14);
  assert.equal(((ev.props.endDate as Date).getTime() - (ev.props.startDate as Date).getTime()) / 60000, 45);
  assert.equal(ev.props.description, 'Ayşe: Perşembe 14:30');

  // tüm gün + bilinmeyen takvim adı → ilk yazılabilir takvim
  ctx.argv = [JSON.stringify({ ...args, allDay: true, calendar: 'Yok', notes: undefined })];
  assert.equal(vm.runInContext('run(argv)', ctx), 'Kişisel');
  const all = added[1].props;
  assert.equal(all.alldayEvent, true);
  assert.equal((all.endDate as Date).getDate(), 3);
});

test('takvim: desteklenmeyen sistemde anlaşılır hata (arayüz .ics ile açar)', async () => {
  if (process.platform === 'darwin' || process.platform === 'win32') return;
  assert.equal(deviceCalendarApp(), null);
  await assert.rejects(addToDeviceCalendar({ title: 'x', start: '2026-10-02T10:00' }), (e: Error & { code?: string }) => e.code === 'unsupported');
});
