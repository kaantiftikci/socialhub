import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-vo-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { WhatsAppConnector, isViewOnce } = await import('../src/connectors/whatsapp.js');
const { sessionDir } = await import('../src/config.js');

const JID = '905551112233@s.whatsapp.net';
const img = (extra: Record<string, unknown> = {}) => ({ imageMessage: { mimetype: 'image/jpeg', fileLength: 1000, mediaKey: Buffer.from('k').toString('base64'), url: 'https://mmg.whatsapp.net/x', ...extra } });
type Wa = {
  queueHistory: (m: unknown[], done?: () => void) => void;
  fetchMedia: (u: string) => Promise<unknown>;
};

function setup(name: string) {
  const store = new Store(path.join(tmp, `${name}.db`));
  const account = { id: `whatsapp:${name}`, platform: 'whatsapp' as const, label: 'WhatsApp', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(account);
  const wa = new WhatsAppConnector({ ...account }, store) as unknown as Wa;
  const history = (msgs: unknown[]) =>
    new Promise<void>((resolve) => {
      wa.queueHistory(msgs, resolve);
    });
  return { store, wa, history, cid: `${account.id}/${JID}`, dir: path.join(sessionDir(account.id), 'media-index') };
}
const msg = (id: string, message: unknown, fromMe = false, ts = 1_700_000_000) => ({ key: { remoteJid: JID, id, fromMe }, message, messageTimestamp: ts });

test('tek seferlik medya tespiti: sarmallar (iç içe dahil) ve medya bayrağı; normal medya değil', () => {
  assert.equal(isViewOnce({ viewOnceMessageV2: { message: img() } } as never), true);
  assert.equal(isViewOnce({ viewOnceMessage: { message: { videoMessage: {} } } } as never), true);
  assert.equal(isViewOnce({ viewOnceMessageV2Extension: { message: { audioMessage: { ptt: true } } } } as never), true);
  assert.equal(isViewOnce({ ephemeralMessage: { message: { viewOnceMessageV2: { message: img() } } } } as never), true, 'kaybolan mesaj içinde');
  assert.equal(isViewOnce(img({ viewOnce: true }) as never), true, 'geçmişte sarmalsız, bayraklı');
  assert.equal(isViewOnce({ ephemeralMessage: { message: { videoMessage: { viewOnce: true } } } } as never), true);
  assert.equal(isViewOnce(img() as never), false);
  assert.equal(isViewOnce(img({ viewOnce: false }) as never), false);
  assert.equal(isViewOnce({ conversation: 'merhaba' } as never), false);
  assert.equal(isViewOnce(undefined), false);
});

test('geçmişten İÇERİKLİ gelen tek seferlik fotoğraf normal fotoğraf gibi gösterilir; içeriksiz olan yer tutucu', async () => {
  const { store, history, cid } = setup('h');
  await history([
    msg('VO1', { viewOnceMessageV2: { message: img({ caption: 'not', directPath: '/v/x' }) } }),
    msg('VO2', img({ viewOnce: true, directPath: '/v/y' }), true, 1_700_000_010),
    msg('VO3', { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg' } } } }, false, 1_700_000_020),
  ]);
  assert.equal(store.getMessage(`${cid}#VO1`)!.attachments?.[0]?.kind, 'image');
  assert.equal(store.getMessage(`${cid}#VO2`)!.attachments?.[0]?.kind, 'image', 'kendi gönderdiğim de');
  const vo3 = store.getMessage(`${cid}#VO3`)!;
  assert.match(vo3.text, /Tek seferlik/);
  assert.equal(vo3.attachments?.length ?? 0, 0, 'içeriği gelmemişse yer tutucu');
  store.close();
});

test('içeriksiz tek seferlik medyanın indirme/önizleme isteği reddedilir', async () => {
  const { store, wa, dir } = setup('dl');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${JID}__X2.json`), JSON.stringify(msg('X2', { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg' } } } })));
  await assert.rejects(() => wa.fetchMedia(`wa:${JID}/X2`), /Tek seferlik/);
  store.close();
});
