// Arayüz eşitleme birleştirmeleri (apps/web/src/sync-merge.ts): bayat önbellek, refresh anlık görüntüsü yarışı, okundu
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAccount, applyRead, mergeAccountsSnapshot, mergeChatsSnapshot, mergeFresh, newTouched } from '../../../apps/web/src/sync-merge.ts';

const msg = (id: string, ts: number, o: Record<string, unknown> = {}) =>
  ({ id: `c1#${id}`, chatId: 'c1', remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text: 'x', ts, status: 'sent', ...o }) as never;
const acc = (id: string, status: string) => ({ id, platform: 'imessage', label: id, status }) as never;
const chat = (id: string, accountId: string, lastPreview = '') => ({ id, accountId, lastPreview }) as never;

test('mergeFresh: pencere içindeki silinmiş local- kaydı geri gelmez, daha eski sayfa korunur', () => {
  const cached = [msg('old1', 100), msg('a', 1000), msg('local-1', 1500), msg('b', 2000)];
  const fresh = [msg('a', 1000), msg('real-1', 1400), msg('b', 2000)];
  const out = mergeFresh(cached, fresh, 'c1').map((m: { remoteId: string }) => m.remoteId);
  assert.deepEqual(out, ['old1', 'a', 'real-1', 'b']);
});

test('mergeFresh: pencereden yeni gerçek kayıt (okuma sürerken WS) korunur, yeni local- kaydı düşer', () => {
  const prev = [msg('a', 1000), msg('live', 3000), msg('local-9', 3100)];
  const out = mergeFresh(prev, [msg('a', 1000), msg('real-9', 2900)], 'c1').map((m: { remoteId: string }) => m.remoteId);
  assert.deepEqual(out, ['a', 'real-9', 'live']);
});

test('mergeFresh: başka sohbetin kaydı karışmaz; taze boşsa eldekiler kalır', () => {
  const other = { ...(msg('z', 5) as object), chatId: 'c2' } as never;
  assert.deepEqual(mergeFresh([other, msg('a', 1)], [], 'c1').map((m: { remoteId: string }) => m.remoteId), ['a']);
});

test('mergeFresh: dolu pencerenin alt sınırıyla aynı damgalı eski kayıt korunur (albüm kesilmesi)', () => {
  const cached = [msg('al1', 1000), msg('al2', 1000), msg('b', 2000)];
  const fresh = [msg('al2', 1000), msg('b', 2000)];
  assert.deepEqual(mergeFresh(cached, fresh, 'c1', 2).map((m: { remoteId: string }) => m.remoteId), ['al1', 'al2', 'b']);
  // pencere dolu değilse sohbetin tamamıdır: aynı damgalı eksik kayıt silinmiştir
  assert.deepEqual(mergeFresh(cached, fresh, 'c1', 100).map((m: { remoteId: string }) => m.remoteId), ['al2', 'b']);
});

test('applyRead: değişiklik yoksa aynı dizi döner', () => {
  const prev = [msg('a', 1, { status: 'read' }), msg('b', 2, { fromMe: false })];
  assert.equal(applyRead(prev, 10), prev);
  const next = applyRead([msg('c', 5)], 10) as Array<{ status: string }>;
  assert.equal(next[0].status, 'read');
});

test('applyAccount: aynı içerikte önceki dizi döner', () => {
  const prev = [acc('a', 'connected')];
  assert.equal(applyAccount(prev, acc('a', 'connected')), prev);
  assert.notEqual(applyAccount(prev, acc('a', 'error')), prev);
});

test('refresh anlık görüntüsü uçuşta gelen hesap durumunu ezmez', () => {
  const t = newTouched();
  // uçuşta: a bağlandı, b kaldırıldı, c eklendi
  t.acc.add('a');
  t.acc.add('b');
  t.removedAcc.add('b');
  t.acc.add('c');
  const prev = [acc('a', 'connected'), acc('c', 'connecting')];
  const snap = [acc('a', 'disconnected'), acc('b', 'disconnected'), acc('d', 'connected')];
  const out = mergeAccountsSnapshot(prev, snap, t) as Array<{ id: string; status: string }>;
  assert.deepEqual(out.map((x) => `${x.id}:${x.status}`), ['a:connected', 'd:connected', 'c:connecting']);
});

test('refresh anlık görüntüsü uçuşta gelen sohbeti ezmez; silinen/kaldırılan hesabın sohbeti gelmez', () => {
  const t = newTouched();
  t.chats.add('x'); // yeni önizlemeyle güncellendi
  t.chats.add('y'); // silindi (prev'de yok)
  t.removedAcc.add('acc2');
  const prev = new Map([['x', chat('x', 'acc1', 'yeni')]]);
  const out = mergeChatsSnapshot(prev as never, [chat('x', 'acc1', 'eski'), chat('y', 'acc1'), chat('z', 'acc2'), chat('w', 'acc1')], t);
  assert.deepEqual([...out.keys()].sort(), ['w', 'x']);
  assert.equal((out.get('x') as { lastPreview: string }).lastPreview, 'yeni');
});
