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
  repairViewOnce: () => Promise<number>;
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

test('geçmişten İÇERİKLİ gelen tek seferlik fotoğraf normal fotoğraf gibi yazılmaz: uyarı metni, ek yok, medya kaydı yok', async () => {
  const { store, history, cid, dir } = setup('h');
  await history([msg('VO1', { viewOnceMessageV2: { message: img({ caption: 'gizli' }) } }), msg('VO2', img({ viewOnce: true }), true, 1_700_000_010), msg('N1', img(), false, 1_700_000_020)]);
  const vo = store.getMessage(`${cid}#VO1`)!;
  assert.match(vo.text, /Tek seferlik/);
  assert.ok(!vo.text.includes('gizli'), 'tek seferlik açıklama gösterilmez');
  assert.equal(vo.attachments?.length ?? 0, 0, 'ek yok → arayüz görsel göstermez');
  assert.equal(store.getMessage(`${cid}#VO2`)!.attachments?.length ?? 0, 0, 'kendi gönderdiğim tek seferlik de');
  assert.equal(store.getMessage(`${cid}#N1`)!.attachments?.[0]?.kind, 'image', 'normal fotoğraf etkilenmez');
  await new Promise((r) => setTimeout(r, 100)); // medya kaydı yazımı arka planda
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.ok(files.some((f) => f.includes('N1')), 'normal fotoğrafın kaydı tutulur');
  assert.ok(!files.some((f) => f.includes('VO1') || f.includes('VO2')), 'tek seferlik medyanın indirme kaydı tutulmaz');
  store.close();
});

test('eskiden normal fotoğraf olarak yazılmış tek seferlik mesaj yeniden gelince yerinde uyarıya çevrilir (ek silinir)', async () => {
  const { store, history, cid } = setup('r');
  // eski sürümün yazdığı hali: aynı kimlik, normal fotoğraf eki
  await history([msg('OLD', img())]);
  assert.equal(store.getMessage(`${cid}#OLD`)!.attachments?.length, 1);
  await history([msg('OLD', { viewOnceMessageV2: { message: img() } })]);
  const m = store.getMessage(`${cid}#OLD`)!;
  assert.match(m.text, /Tek seferlik/);
  assert.equal(m.attachments?.length ?? 0, 0);
  assert.match(store.getChat(cid)!.lastPreview, /Tek seferlik/, 'sohbetin son mesajıysa önizleme de');
  store.close();
});

test('açılış onarımı: medya kaydındaki ham mesajdan tek seferlikler bulunur, çevrilir, medya kaydı ve dosyası silinir; bir kez çalışır', async () => {
  const { store, wa, history, cid, dir } = setup('fix');
  await history([msg('PAST', img()), msg('PLAIN', img(), false, 1_700_000_050)]);
  await new Promise((r) => setTimeout(r, 100)); // medya kaydı yazımı (arka planda)
  const key = `${JID}__PAST`;
  // eski sürümde medya kaydına ham (tek seferlik) mesaj yazılmıştı
  fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify(msg('PAST', { viewOnceMessageV2: { message: img() } })));
  const mediaDir = path.join(path.dirname(dir), 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, key), 'jpeg');
  fs.writeFileSync(path.join(mediaDir, key + '.type'), 'image/jpeg');
  assert.equal(await wa.repairViewOnce(), 1);
  const m = store.getMessage(`${cid}#PAST`)!;
  assert.match(m.text, /Tek seferlik/);
  assert.equal(m.attachments?.length ?? 0, 0);
  assert.equal(store.getMessage(`${cid}#PLAIN`)!.attachments?.length, 1, 'normal fotoğrafa dokunulmaz');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(path.join(dir, key + '.json')), false, 'indirme kaydı silindi');
  assert.equal(fs.existsSync(path.join(mediaDir, key)), false, 'indirilmiş dosya silindi');
  assert.equal(await wa.repairViewOnce(), 0, 'ikinci açılışta yeniden taranmaz');
  store.close();
});

test('tek seferlik medyanın indirme/önizleme isteği reddedilir', async () => {
  const { store, wa, dir } = setup('dl');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${JID}__X1.json`), JSON.stringify(msg('X1', img({ viewOnce: true, jpegThumbnail: Buffer.from('t').toString('base64') }))));
  await assert.rejects(() => wa.fetchMedia(`wa:${JID}/X1`), /Tek seferlik/);
  fs.writeFileSync(path.join(dir, `${JID}__X2.json`), JSON.stringify(msg('X2', { viewOnceMessageV2: { message: img() } })));
  await assert.rejects(() => wa.fetchMedia(`wa-thumb:${JID}/X2`), /Tek seferlik/);
  store.close();
});
