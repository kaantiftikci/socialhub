#!/usr/bin/env node
/**
 * iMessage tanısı (Mac, salt okunur): Mesajlar'ın chat.db'sindeki sayılarla Mivelo'nun gösterdiklerini karşılaştırır.
 *   node scripts/imessage-probe.mjs
 * Çıktıda yalnız sayılar, tarihler, klasör dağılımı ve durum satırları var — mesaj metni, numara, ad yazdırılmaz.
 * Mivelo çalışıyor olmalı (web servisi ya da npm run dev). Çıktıyı Claude'a yapıştır.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(ROOT, 'packages/core/package.json'));
const DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const toMs = (d) => (d > 1e12 ? Math.floor(d / 1e6) + APPLE_EPOCH_MS : d * 1000 + APPLE_EPOCH_MS);
const fmt = (ms) => (ms ? new Date(ms).toLocaleString('tr-TR') : '-');
const line = (k, v) => console.log(`${k.padEnd(34)} ${v}`);

console.log('# iMessage tanısı\n');
console.log('## Mesajlar veritabanı (bu Terminal\'in izniyle)');
let src = null;
try {
  const Database = req('better-sqlite3');
  const db = new Database(DB, { readonly: true, fileMustExist: true });
  const one = (sql) => db.prepare(sql).get();
  const ccols = new Set(db.prepare('PRAGMA table_info(chat)').all().map((c) => c.name));
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name));
  src = {
    chats: one('SELECT COUNT(*) n FROM chat').n,
    chatsWithMsg: one('SELECT COUNT(DISTINCT chat_id) n FROM chat_message_join').n,
    messages: one('SELECT COUNT(*) n FROM message').n,
    joined: one('SELECT COUNT(*) n FROM chat_message_join').n,
    orphan: one('SELECT COUNT(*) n FROM message WHERE ROWID NOT IN (SELECT message_id FROM chat_message_join)').n,
    newest: toMs(one('SELECT MAX(date) d FROM message').d ?? 0),
    recoverable: tables.has('chat_recoverable_message_join') ? one('SELECT COUNT(*) n FROM chat_recoverable_message_join').n : 'tablo yok',
    recoverableChats: tables.has('chat_recoverable_message_join') ? one('SELECT COUNT(DISTINCT chat_id) n FROM chat_recoverable_message_join').n : '-',
  };
  line('sohbet (chat) / mesajı olan', `${src.chats} / ${src.chatsWithMsg}`);
  line('mesaj / sohbete bağlı / bağsız', `${src.messages} / ${src.joined} / ${src.orphan}`);
  line('en yeni mesaj', fmt(src.newest));
  line('son silinenler (mesaj / sohbet)', `${src.recoverable} / ${src.recoverableChats}`);
  if (ccols.has('is_filtered')) {
    const f = db.prepare('SELECT is_filtered v, COUNT(*) n FROM chat GROUP BY is_filtered').all();
    line('chat.is_filtered dağılımı', f.map((r) => `${r.v ?? 'null'}:${r.n}`).join('  '));
  } else line('chat.is_filtered', 'sütun yok');
  const last = db.prepare('SELECT date FROM message ORDER BY date DESC LIMIT 5').all().map((r) => fmt(toMs(r.date)));
  line('son 5 mesaj zamanı', last.join(' · '));
  db.close();
} catch (e) {
  console.log(`chat.db okunamadı: ${e.message}`);
  console.log('→ Bu Terminal\'in Tam Disk Erişimi yok ya da Mesajlar kurulu değil (asıl önemli olan Mivelo servisinin izni; aşağıya bak).');
}

console.log('\n## Mivelo (çalışan çekirdek)');
const api = async (p) => {
  const r = await fetch(`http://127.0.0.1:7788${p}`, { headers: { origin: 'http://localhost:5173' } });
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
  return r.json();
};
try {
  const accounts = await api('/api/accounts');
  const im = accounts.filter((a) => a.platform === 'imessage');
  if (!im.length) console.log('iMessage hesabı bağlı değil.');
  for (const a of im) line(`hesap ${a.id}`, `${a.status}${a.detail ? ` — ${a.detail}` : ''}`);
  const chats = (await api('/api/chats')).filter((c) => c.platform === 'imessage');
  const byFolder = {};
  for (const c of chats) {
    const k = c.meta?.deleted ? 'silinen' : c.meta?.folder ?? 'mesajlar';
    byFolder[k] = (byFolder[k] ?? 0) + 1;
  }
  line('Mivelo\'daki iMessage sohbetleri', `${chats.length}  (${Object.entries(byFolder).map(([k, n]) => `${k}:${n}`).join('  ')})`);
  const newest = Math.max(0, ...chats.map((c) => c.lastMessageAt ?? 0));
  line('Mivelo\'daki en yeni iMessage', fmt(newest));
  const all = await api('/api/chats');
  const perAcc = {};
  for (const c of all) perAcc[c.platform] = (perAcc[c.platform] ?? 0) + 1;
  line('/api/chats toplam (platform başına)', `${all.length}  (${Object.entries(perAcc).map(([k, n]) => `${k}:${n}`).join('  ')})`);
  if (all.length === 600) console.log('!! Tam 600 sohbet: çekirdek ESKİ sürümde (hesap başına sınır gelmemiş). `npm run autodeploy -- restart` dene.');
  const logs = await api('/api/logs');
  const imLogs = logs.filter((l) => /imessage/i.test(l.text)).slice(-15);
  console.log('\nSon iMessage günlük satırları:');
  for (const l of imLogs) console.log(`  [${l.level}] ${new Date(l.ts).toLocaleTimeString('tr-TR')} ${l.text.replace(/\+?\d[\d ]{7,}\d/g, '<numara>').slice(0, 220)}`);
  if (src) {
    console.log('\n## Karşılaştırma');
    if (src.newest && newest && src.newest - newest > 5 * 60_000)
      console.log(`!! Mivelo en yeni mesajı ${Math.round((src.newest - newest) / 60_000)} dk geriden izliyor → servis chat.db'yi okuyamıyor olabilir (Tam Disk Erişimi node'a verilmeli).`);
    if (src.chatsWithMsg > chats.length) console.log(`!! chat.db'de mesajlı ${src.chatsWithMsg} sohbet var, Mivelo'da ${chats.length}.`);
    if (!(src.newest - newest > 5 * 60_000) && src.chatsWithMsg <= chats.length) console.log('Sayılar tutarlı görünüyor.');
  }
} catch (e) {
  console.log(`Mivelo çekirdeğine ulaşılamadı: ${e.message} (Mivelo çalışıyor mu? npm run autodeploy -- status)`);
}
let node = process.execPath;
try {
  node = fs.realpathSync(process.execPath);
} catch {
  /* yok */
}
console.log(`\nnode ikilisi (Tam Disk Erişimi'ne eklenecek dosya): ${node}`);
console.log('\nBitti. Bu çıktıyı olduğu gibi Claude\'a yapıştır.');
