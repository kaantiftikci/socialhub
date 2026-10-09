import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Tarayıcı e-posta yolları (Gmail/Yahoo/Outlook/iCloud/Yandex) mesajları almak için diziyi açar → sağlayıcı okundu sayar; strateji
 * "okunmadı" geri alamazsa sonraki yoklama okunmamışı 0 yazıyor, Okunmamış sekmesi boş kalıyordu (readsOnOpen).
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-selfopen-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { BrowserConnector } = await import('../src/connectors/browser/bridge.js');
type Strategy = ConstructorParameters<typeof BrowserConnector>[2];

function setup(store: InstanceType<typeof Store>, readsOnOpen: boolean) {
  const account = { id: `gmail:${readsOnOpen ? 'a' : 'b'}`, platform: 'gmail' as const, label: 'ornek@example.com', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  const box = {
    thread: { id: 't1', name: 'Fatura', kind: 'direct' as const, unread: 1, lastTs: 1000, preview: 'Örnek: fatura ekte' },
  };
  const strategy = {
    home: 'https://example.com/',
    loginHint: '',
    pageless: true,
    readsOnOpen,
    async loggedIn() {
      return true;
    },
    async threads() {
      return [box.thread];
    },
    async messages() {
      // diziyi açmak sağlayıcıda okundu yapar; "okunmadı" geri alma başarısız
      box.thread = { ...box.thread, unread: 0 };
      return [{ id: 'm1', text: 'fatura ekte', ts: 1000, fromMe: false, senderId: 'ornek@example.com', senderName: 'Örnek' }];
    },
  } as unknown as Strategy;
  const conn = new BrowserConnector(account, store, strategy, 60_000);
  const c = conn as unknown as Record<string, unknown>;
  c.pageless = true;
  c.state = { cookies: [], origins: [] };
  c.api = { storageState: async () => ({ cookies: [], origins: [] }), dispose: async () => undefined };
  const poll = (first: boolean) => (c.pollInner as (f: boolean) => Promise<void>).call(conn, first);
  return { conn, poll, box, cid: `${account.id}/t1` };
}

test('köprünün kendi açtığı okunmamış e-posta okunmamış kalır; yeni etkinlik, Mivelo okuması ve platformun geri dönüşü olağan', async () => {
  const store = new Store(path.join(tmp, 'a.db'));
  const { conn, poll, box, cid } = setup(store, true);
  await poll(true);
  assert.equal(store.getChat(cid)!.unread, 1);
  await poll(false);
  assert.equal(store.getChat(cid)!.unread, 1, 'kendi açmamız okunmamışı silmez');
  // çekirdek yeniden başladı (yeni connector, ilk tur): kayıt kalıcı
  const again = setup(store, true);
  again.box.thread = { ...box.thread };
  await again.poll(true);
  assert.equal(store.getChat(cid)!.unread, 1, 'yeniden başlatmada da korunur');
  // Mivelo'da okundu → kayıt düşer, platformun okundusu geçerli
  store.markRead(cid);
  await (again.conn as unknown as { markRead(id: string): Promise<void> }).markRead('t1');
  await again.poll(false);
  assert.equal(store.getChat(cid)!.unread, 0);
  // yeni e-posta: platform okunmamış der, açıp okuruz, sonra yine okunmamış kalır
  again.box.thread = { ...again.box.thread, unread: 1, lastTs: 5000 };
  await again.poll(false);
  await again.poll(false);
  assert.equal(store.getChat(cid)!.unread, 1);
  // geri alma bu kez tuttu (platform yeniden okunmamış diyor) → kayıt düşer; sonra telefonda okundu → Mivelo'da da okundu
  again.box.thread = { ...again.box.thread, unread: 1 };
  await again.poll(false);
  again.box.thread = { ...again.box.thread, unread: 0 };
  await again.poll(false);
  assert.equal(store.getChat(cid)!.unread, 0, 'başka yerde okunan e-posta okundu olur');
  store.close?.();
});

test('readsOnOpen olmayan strateji: platformun okundusu olduğu gibi', async () => {
  const store = new Store(path.join(tmp, 'b.db'));
  const { poll, cid } = setup(store, false);
  await poll(true);
  await poll(false);
  assert.equal(store.getChat(cid)!.unread, 0);
});
