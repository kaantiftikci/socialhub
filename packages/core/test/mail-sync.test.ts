import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Oturum klasörleri gerçek ~/.mivelo'ya yazılmasın: config içe aktarılmadan önce ayarlanmalı
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-mail-sync-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { sessionDir } = await import('../src/config.js');
const { bus } = await import('../src/bus.js');
const { MailConnector, uidRanges } = await import('../src/connectors/mail.js');
const { mailState, folderDue } = await import('../src/connectors/browser/outlook.js');

type Box = { uid: number; date: Date; seen: boolean; from: string; subject: string; msgId: string };

/** Sahte ImapFlow: yalnız bağlayıcının kullandığı çağrılar */
class FakeImap {
  boxes: Record<string, Box[]> = { INBOX: [], Sent: [] };
  cur = 'INBOX';
  uidValidity: Record<string, number> = { INBOX: 7, Sent: 3 };
  failAt = 0;
  fetched: number[] = [];
  fetchedSent: number[] = [];
  usable = true;
  get mailbox() {
    const list = this.boxes[this.cur]!;
    return { uidValidity: BigInt(this.uidValidity[this.cur]!), uidNext: (list.at(-1)?.uid ?? 0) + 1 };
  }
  async connect() {}
  async logout() {}
  close() {}
  on() {}
  removeAllListeners() {}
  async list() {
    return [{ path: 'INBOX' }, { path: 'Sent', specialUse: '\\Sent' }];
  }
  async getMailboxLock(p: string) {
    this.cur = p;
    return { release() {} };
  }
  private inRanges(set: string, u: number, max: number) {
    return set.split(',').some((part) => {
      const [a, b] = part.split(':');
      const lo = Number(a);
      const hi = b === undefined ? lo : b === '*' ? max : Number(b);
      return u >= Math.min(lo, hi) && u <= Math.max(lo, hi);
    });
  }
  async search(q: { uid?: string; since?: Date; seen?: boolean; header?: Record<string, string> }) {
    const list = this.boxes[this.cur]!;
    const max = list.at(-1)?.uid ?? 0;
    let out = list.filter((m) => {
      if (q.since && m.date < q.since) return false;
      if (q.seen === false && m.seen) return false;
      if (q.header?.['message-id'] && m.msgId !== q.header['message-id']) return false;
      if (q.uid && !this.inRanges(q.uid, m.uid, max)) return false;
      return true;
    }).map((m) => m.uid);
    // gerçek sunucu gibi: "N:*" son UID'yi her zaman döndürür
    if (q.uid?.endsWith(':*') && max && !out.includes(max)) out = [...out, max];
    return out;
  }
  async *fetch(uids: number[]) {
    const list = this.boxes[this.cur]!;
    for (const u of [...uids].sort((a, b) => a - b)) {
      if (this.failAt && u === this.failAt) throw new Error('bağlantı koptu');
      const m = list.find((x) => x.uid === u);
      if (!m) continue;
      (this.cur === 'INBOX' ? this.fetched : this.fetchedSent).push(u);
      const src = `From: ${m.from}\r\nTo: ben@example.com\r\nSubject: ${m.subject}\r\nMessage-ID: ${m.msgId}\r\nDate: ${m.date.toUTCString()}\r\n\r\nMerhaba ${u}\r\n`;
      yield { uid: u, source: Buffer.from(src), flags: new Set(m.seen ? ['\\Seen'] : []) };
    }
  }
  async messageFlagsAdd(uids: number[]) {
    for (const m of this.boxes.INBOX!) if (uids.includes(m.uid)) m.seen = true;
  }
}

let n = 0;
function setup(state?: object) {
  const store = new Store(path.join(tmp, `m${++n}.db`));
  const account = { id: `imap:t${n}`, platform: 'imap' as const, label: 'ben@example.com', status: 'connected' as const, createdAt: Date.now() };
  store.upsertAccount(account);
  if (state) fs.writeFileSync(path.join(sessionDir(account.id), 'mail-state.json'), JSON.stringify(state));
  const imap = new FakeImap();
  const make = () => {
    const c = new MailConnector({ ...account }, store, { user: 'ben@example.com', pass: 'p', host: 'imap.example.com' });
    const cc = c as unknown as Record<string, unknown>;
    cc.withInbox = async (fn: (cl: unknown) => Promise<unknown>) => {
      imap.cur = 'INBOX';
      return fn(imap);
    };
    cc.createImapClient = () => imap;
    return c;
  };
  return { store, account, imap, make };
}
const P = (c: unknown) => c as { poll(first: boolean): Promise<void>; pollFolders(): Promise<void>; lastUid: number; oldestUid: number; unseen: Map<string, Set<number>>; stop(): Promise<void> };
const mail = (uid: number, opts: Partial<Box> = {}): Box => ({ uid, date: new Date(Date.now() - 3_600_000), seen: true, from: `kisi${uid}@example.com`, subject: `Konu ${uid}`, msgId: `<m${uid}@example.com>`, ...opts });
const idle = () => new Promise((r) => setTimeout(r, 800));

test('uidRanges: ardışık UID aralık olur', () => {
  assert.equal(uidRanges([1, 2, 3, 7, 9, 10]), '1:3,7,9:10');
  assert.equal(uidRanges([5]), '5');
  assert.equal(uidRanges([]), '');
});

test('mail: büyük birikim dilimlenir, ilk tur yalnız ilk dilimi bekler; kopmada imleç kaldığı yerden sürer, birikim canlı sayılmaz', async () => {
  const { imap, make, account } = setup({ lastUid: 100, uidValidity: '7' });
  fs.writeFileSync(path.join(sessionDir(account.id), 'html-v1'), ''); // eski hesabın tek seferlik HTML yenilemesi yapılmış
  for (let u = 101; u <= 2100; u++) imap.boxes.INBOX!.push(mail(u));
  imap.failAt = 1801;
  const live: unknown[] = [];
  const off = bus.on((ev) => {
    if (ev.type === 'message.upsert' && (ev as { live?: boolean }).live) live.push(ev);
  });
  const c = make();
  await P(c).poll(true);
  assert.equal(imap.fetched.length, MailConnector.CHUNK, 'ilk tur yalnız ilk dilim');
  assert.equal(P(c).lastUid, 200);
  // arka plan turu: 1801'de kopar
  for (let i = 0; i < 200 && imap.fetched.at(-1) !== 1800; i++) await new Promise((r) => setTimeout(r, 50));
  for (let i = 0; i < 40 && (c as unknown as { polling: boolean }).polling; i++) await new Promise((r) => setTimeout(r, 50));
  off();
  assert.equal(imap.fetched.at(-1), 1800);
  assert.equal(live.length, 0, 'birikim canlı mesaj olarak yayınlanmaz');
  await P(c).stop();
  const c2 = make();
  assert.equal(P(c2).lastUid, 1800, 'yeni örnek kaldığı yerden başlar');
  imap.failAt = 0;
  imap.fetched = [];
  await P(c2).poll(false);
  assert.equal(imap.fetched[0], 1801, 'indirilenler yeniden inmez');
  assert.equal(new Set(imap.fetched).size, imap.fetched.length);
  await P(c2).stop();
});

test('mail: yeni hesapta ilk eşitleme aynı e-postaları iki kez indirmez (html-v1)', async () => {
  const { imap, make, account } = setup();
  for (let u = 1; u <= 150; u++) imap.boxes.INBOX!.push(mail(u));
  const c = make();
  await P(c).poll(true);
  assert.ok(fs.existsSync(path.join(sessionDir(account.id), 'html-v1')));
  await idle();
  assert.equal(imap.fetched.length, 150);
  assert.equal(new Set(imap.fetched).size, 150, 'her e-posta bir kez');
  await P(c).stop();
});

test('mail: canlı turda \\Seen e-posta okunmamış sayılmaz; başka cihazda okunan düşer; okunmamış UID kalıcı', async () => {
  const { imap, make, store, account } = setup({ lastUid: 10, uidValidity: '7' });
  imap.boxes.INBOX!.push(mail(10));
  const c = make();
  imap.boxes.INBOX!.push(mail(11, { seen: true, msgId: '<a@x>' }), mail(12, { seen: false, msgId: '<b@x>' }));
  await P(c).poll(false);
  const chat11 = store.getChat(`${account.id}/msg:<a@x>`)!;
  const chat12 = store.getChat(`${account.id}/msg:<b@x>`)!;
  assert.equal(chat11.unread, 0, 'telefonda okunmuş e-posta +1 olmaz');
  assert.equal(chat12.unread, 1);
  // yeniden başlatma sonrası da UID bilinir
  const c2 = make();
  assert.deepEqual([...(P(c2).unseen.get('msg:<b@x>') ?? [])], [12]);
  // başka cihazda okundu → sonraki turda Mivelo'da da okundu
  imap.boxes.INBOX!.find((m) => m.uid === 12)!.seen = true;
  await P(c2).poll(false);
  assert.equal(store.getChat(chat12.id)!.unread, 0);
  assert.equal(P(c2).unseen.has('msg:<b@x>'), false);
  await P(c).stop();
  await P(c2).stop();
});

test('mail: UID bilinmeyen dizide markRead Message-ID ile arar; UIDVALIDITY değişince okunmamış UID\'ler silinir', async () => {
  const { imap, make, store, account } = setup({ lastUid: 20, uidValidity: '7' });
  imap.boxes.INBOX!.push(mail(20), mail(21, { seen: false, msgId: '<c@x>' }));
  const c = make();
  await P(c).poll(false);
  P(c).unseen.clear(); // yeniden başlatma öncesi eski sürüm: UID tutulmamış
  assert.equal(store.getChat(`${account.id}/msg:<c@x>`)!.unread, 1);
  await (c as unknown as { markRead(id: string): Promise<void> }).markRead('msg:<c@x>');
  assert.equal(imap.boxes.INBOX!.find((m) => m.uid === 21)!.seen, true);
  // UIDVALIDITY
  imap.boxes.INBOX!.push(mail(22, { seen: false, msgId: '<d@x>' }));
  await P(c).poll(false);
  assert.ok(P(c).unseen.size > 0);
  imap.uidValidity.INBOX = 8;
  imap.boxes.INBOX = [];
  await P(c).poll(false);
  assert.equal(P(c).unseen.size, 0);
  await P(c).stop();
});

test('mail: son 30 günde e-postası olmayan kutuda "daha eski" eski e-postaları getirir; eski yanlış kayıt (oldestUid 1) düzelir', async () => {
  const { imap, make } = setup({ lastUid: 0, oldestUid: 1, uidValidity: '7' });
  for (let u = 1; u <= 30; u++) imap.boxes.INBOX!.push(mail(u, { date: new Date(Date.now() - 200 * 86_400_000), msgId: `<old${u}@x>`, subject: `Eski ${u}` }));
  const c = make();
  assert.equal(P(c).oldestUid, 0, 'eski yanlış kayıt sıfırlanır');
  await P(c).poll(true);
  assert.equal(imap.fetched.length, 0);
  const got = await (c as unknown as { loadMoreChats(): Promise<number> }).loadMoreChats();
  assert.ok(got > 0, 'eski e-postalar gelir');
  await P(c).stop();
});

test('mail: Gönderilenler imleçle okunur — ikinci turda yalnız yeni e-posta iner', async () => {
  const { imap, make } = setup({ lastUid: 1, uidValidity: '7' });
  imap.boxes.INBOX!.push(mail(1));
  for (let u = 1; u <= 10; u++) imap.boxes.Sent!.push(mail(u, { from: 'ben@example.com', msgId: `<s${u}@x>` }));
  const c = make();
  await P(c).pollFolders();
  assert.equal(imap.fetchedSent.length, 10);
  imap.fetchedSent = [];
  await P(c).pollFolders();
  assert.equal(imap.fetchedSent.length, 0, 'değişiklik yoksa hiçbir şey inmez');
  imap.boxes.Sent!.push(mail(11, { from: 'ben@example.com', msgId: '<s11@x>' }));
  await P(c).pollFolders();
  assert.deepEqual(imap.fetchedSent, [11]);
  // imleç kalıcı
  imap.fetchedSent = [];
  await P(make()).pollFolders();
  assert.equal(imap.fetchedSent.length, 0);
  await P(c).stop();
});

test('tarayıcı e-posta: "ben" adresi hesap (bağlam) başına tutulur', () => {
  const ctxA = {};
  const ctxB = {};
  const pa = { context: () => ctxA } as never;
  const pb = { context: () => ctxB } as never;
  mailState(pa).me = 'a@gmail.com';
  mailState(pb).me = 'b@gmail.com';
  assert.equal(mailState(pa).me, 'a@gmail.com');
  assert.equal(mailState({ context: () => ctxA } as never).me, 'a@gmail.com');
  assert.equal(mailState(pb).me, 'b@gmail.com');
  // klasör sayacı adrese bağlı: boşta kapanıp yeni bağlamla açılan hesap her turda klasörleri yeniden okumaz
  assert.equal(folderDue(pa), true);
  assert.equal(folderDue(pa), false);
  const ctxA2 = {};
  mailState({ context: () => ctxA2 } as never).me = 'a@gmail.com';
  assert.equal(folderDue({ context: () => ctxA2 } as never), false);
  assert.equal(folderDue(pb), true);
});
