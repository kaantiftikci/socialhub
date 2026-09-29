// Duman testi için gerçekçi veri: Kaan'ın durumuna benzer büyük, şifreli veritabanı (çok sohbet + yüz binlerce mesaj),
// açılışta başlayan hesaplar (Instagram tarayıcı kanalı, iMessage, Telegram) ve yarıda kalmış büyük bir hesap kaldırma.
// Kullanım: MIVELO_DATA_DIR=… KAVSAK_DB_KEY=<64 hex> node scripts/smoke/seed.mjs <core/dist klasörü> [mesaj sayısı]
// Yalnız yer tutucu veri üretir (gerçek ad/numara yok).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = path.resolve(process.argv[2] ?? 'packages/core/dist');
const total = Number(process.argv[3] ?? 200_000);
const { Store } = await import(pathToFileURL(path.join(dist, 'store.js')).href);
const { DB_PATH } = await import(pathToFileURL(path.join(dist, 'config.js')).href);
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const store = new Store(DB_PATH, process.env.KAVSAK_DB_KEY);

const accounts = [
  { id: 'instagram:smoke', platform: 'instagram', chats: 400, share: 0.25 },
  { id: 'imessage:smoke', platform: 'imessage', chats: 900, share: 0.25 },
  { id: 'telegram:smoke', platform: 'telegram', chats: 300, share: 0.1 },
  // kaldırılmakta olan büyük hesap (meta removing:<id> → açılışta resumePurges)
  { id: 'whatsapp:removed', platform: 'whatsapp', chats: 1200, share: 0.4 },
];
const t0 = Date.now();
const now = Date.now();
for (const a of accounts) {
  store.upsertAccount({ id: a.id, platform: a.platform, label: a.platform, status: 'connected', createdAt: 1 });
  const n = Math.round(total * a.share);
  const per = Math.ceil(n / a.chats);
  for (let c = 0; c < a.chats; c++) {
    const cid = `${a.id}/chat-${c}`;
    store.upsertChat({ id: cid, accountId: a.id, platform: a.platform, remoteId: `chat-${c}`, name: `Sohbet ${c}`, kind: c % 7 ? 'direct' : 'group', unread: c % 13 === 0 ? 2 : 0, lastMessageAt: now - c * 60_000, lastPreview: 'örnek', tags: [] });
    store.transaction(() => {
      for (let i = 0; i < per; i++) {
        const ts = now - c * 60_000 - i * 3_600_000;
        store.upsertMessage({ id: `${cid}/m${i}`, chatId: cid, remoteId: `m${i}`, senderId: i % 2 ? 'me' : 'o', senderName: i % 2 ? 'Ben' : 'Kişi', fromMe: i % 2 === 1, text: `örnek mesaj ${i} — duman testi için yer tutucu metin, arama dizinine de girer`, ts, status: 'read' });
      }
    });
  }
}
store.setFlag('removing:whatsapp:removed');
store.close();
console.log(`tohum: ${accounts.length} hesap, ~${total} mesaj, ${Math.round((Date.now() - t0) / 1000)} sn`);
