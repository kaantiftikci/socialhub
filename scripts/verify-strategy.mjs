#!/usr/bin/env node
/**
 * Tarayıcı stratejisini (slack/instagram/linkedin/x/messenger) gerçek oturumla, uygulamaya dokunmadan doğrular:
 *   node scripts/verify-strategy.mjs slack            # ~/.kavsak/sessions/<platform>:<id>/profile'ı /tmp'ye kopyalar
 *   node scripts/verify-strategy.mjs slack /yol/profil # verilen profil kopyasını kullanır
 * Çıktı: sohbet sayısı, ilk 8 sohbet (ad, tür, okunmamış, son etkinlik), ilk 3 sohbette mesajlar (zaman, gönderen, metin, ek),
 * bir sohbette "before" ile daha eski sayfa. Önce `npm run build -w packages/core`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const [platform, given] = process.argv.slice(2);
if (!platform) {
  console.error('kullanım: node scripts/verify-strategy.mjs <slack|instagram|linkedin|x|messenger> [profilKopyası]');
  process.exit(1);
}
const mod = await import(`../packages/core/dist/connectors/browser/${platform}.js`);
const strategy = mod[platform] ?? mod[`${platform}Strategy`] ?? Object.values(mod).find((v) => v && typeof v === 'object' && 'threads' in v);
if (!strategy) throw new Error('strateji bulunamadı: ' + platform);

let profile = given;
if (!profile) {
  const sessions = path.join(os.homedir(), '.kavsak', 'sessions');
  const dir = fs.readdirSync(sessions).find((d) => d.startsWith(platform + ':'));
  if (!dir) throw new Error(`${platform} hesabı yok (~/.kavsak/sessions)`);
  profile = path.join(os.tmpdir(), `kavsak-verify-${platform}`);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.cpSync(path.join(sessions, dir, 'profile'), profile, { recursive: true });
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(profile, f), { force: true });
  console.log('profil kopyalandı →', profile);
}
// gerçek tarayıcı kimliği (görünmez modda "HeadlessChrome" bazı siteleri kapatır; köprüdeki realUserAgent ile aynı)
const probe = await chromium.launch({ headless: true, channel: 'chromium' });
const ua = (await (await probe.newPage()).evaluate(() => navigator.userAgent)).replace(/HeadlessChrome/g, 'Chrome');
await probe.close();
const ctx = await chromium.launchPersistentContext(profile, { userAgent: ua, headless: true, channel: 'chromium', viewport: { width: 1180, height: 820 }, locale: 'tr-TR', args: ['--disable-blink-features=AutomationControlled'] });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const cookies = async () => Object.fromEntries((await ctx.cookies()).map((c) => [c.name, c.value]));
const t0 = Date.now();
try {
  await page.goto(strategy.home, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  const ok = await strategy.loggedIn(page, await cookies());
  console.log('giriş:', ok ? 'VAR' : 'YOK', '| sayfa:', page.url());
  if (!ok) process.exit(2);
  console.log('me:', await strategy.me(page, await cookies()));
  const threads = await strategy.threads(page, await cookies());
  console.log(`sohbet: ${threads.length} (${Date.now() - t0} ms)`);
  if (mod.messengerSite) console.log('messenger adresi:', mod.messengerSite()?.key ?? 'seçilemedi', '| sayfa:', page.url());
  for (const t of threads.slice(0, 8)) console.log('  ', t.kind.padEnd(7), String(t.unread).padStart(3), t.lastTs ? new Date(t.lastTs).toISOString().slice(0, 16) : '-'.padEnd(16), t.name, '|', (t.preview ?? '').slice(0, 40));
  for (const t of threads.slice(0, 3)) {
    const t1 = Date.now();
    const msgs = await strategy.messages(page, await cookies(), t.id, 20);
    console.log(`\nmesajlar: ${t.name} → ${msgs.length} (${Date.now() - t1} ms)`);
    for (const m of msgs.slice(-5)) console.log('  ', new Date(m.ts).toISOString().slice(0, 16), m.fromMe ? 'BEN' : m.senderName, '|', m.text.slice(0, 60).replace(/\n/g, ' '), m.attachments?.length ? `[${m.attachments.map((a) => a.kind).join(',')}]` : '');
    if (msgs.length) {
      const older = await strategy.messages(page, await cookies(), t.id, 20, msgs[0].ts).catch((e) => (console.log('  before hatası:', e.message.split('\n')[0]), []));
      console.log(`  before=${new Date(msgs[0].ts).toISOString().slice(0, 16)} → ${older.length} eski mesaj${older.length ? ', en eskisi ' + new Date(older[0].ts).toISOString().slice(0, 16) : ''}`);
    }
  }
} finally {
  await ctx.close();
}
