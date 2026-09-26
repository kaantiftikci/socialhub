import test from 'node:test';
import assert from 'node:assert/strict';
import { isUiActive, markActive, onUiActive } from '../src/activity.js';
import { realtimeKind } from '../src/connectors/browser/linkedin.js';
import { parseSlackToken, SLACK_MANIFEST, SLACK_USER_SCOPES } from '../src/connectors/slack.js';

test('activity: etkin sinyali 150 sn geçerli; boştan etkine geçişte dinleyici bir kez çağrılır', () => {
  const t0 = 1_800_000_000_000;
  markActive(false, t0);
  let woke = 0;
  const off = onUiActive(() => woke++);
  markActive(true, t0);
  markActive(true, t0 + 60_000); // zaten etkin: yeniden uyandırma yok
  assert.equal(woke, 1);
  assert.equal(isUiActive(t0 + 149_000), true);
  assert.equal(isUiActive(t0 + 60_000 + 151_000), false);
  markActive(false, t0 + 70_000);
  assert.equal(isUiActive(t0 + 70_001), false);
  off();
  markActive(true, t0 + 80_000);
  assert.equal(woke, 1, 'abonelik kaldırıldı');
  markActive(false, t0 + 90_000);
});

test('linkedin anlık akış: mesaj/sohbet konuları olay, kalp atışı/yazıyor/çevrimiçi değil', () => {
  assert.equal(realtimeKind('data: {"com.linkedin.realtimefrontend.DecoratedEvent":{"topic":"urn:li-realtime:messagesTopic:urn:li-realtime:myself"}}'), 'event');
  assert.equal(realtimeKind('data: {"topic":"urn:li-realtime:conversationsTopic:urn:li-realtime:myself"}'), 'event');
  assert.equal(realtimeKind('data: {"com.linkedin.realtimefrontend.Heartbeat":{}}'), 'alive');
  assert.equal(realtimeKind('data: {"topic":"urn:li-realtime:typingIndicatorsTopic:urn:li-realtime:myself"}'), 'alive');
  assert.equal(realtimeKind('data: {"topic":"urn:li-realtime:presenceStatusTopic:x"}'), 'alive');
});

test('slack belirteç dosyası: düz xoxp, JSON {token, appToken}; geçersizler reddedilir', () => {
  assert.deepEqual(parseSlackToken('xoxp-1-abc\n'), { token: 'xoxp-1-abc' });
  assert.deepEqual(parseSlackToken(JSON.stringify({ token: 'xoxp-1', appToken: 'xapp-1-A' })), { token: 'xoxp-1', appToken: 'xapp-1-A' });
  assert.deepEqual(parseSlackToken(JSON.stringify({ token: 'xoxp-1', appToken: 'yanlis' })), { token: 'xoxp-1', appToken: undefined });
  assert.equal(parseSlackToken(JSON.stringify({ token: 'abc' })), undefined);
  assert.equal(parseSlackToken('{bozuk'), undefined);
  assert.equal(parseSlackToken(''), undefined);
  // manifest connector'ın kullandığı tüm kapsamları ister ve Socket Mode açık
  assert.deepEqual(SLACK_MANIFEST.oauth_config.scopes.user, SLACK_USER_SCOPES);
  assert.equal(SLACK_MANIFEST.settings.socket_mode_enabled, true);
});

test('slack manifest arayüzdeki kopyayla aynı', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../../apps/web/src/Connect.tsx', import.meta.url), 'utf8');
  for (const s of SLACK_USER_SCOPES) assert.ok(src.includes(`'${s}'`), s);
  for (const e of SLACK_MANIFEST.settings.event_subscriptions.user_events) assert.ok(src.includes(`'${e}'`), e);
});

test('e-posta tarayıcı stratejileri canlı liste izleyicisi tanımlar', async () => {
  const { gmail } = await import('../src/connectors/browser/gmail.js');
  const { outlook } = await import('../src/connectors/browser/outlook.js');
  const { icloud } = await import('../src/connectors/browser/icloud.js');
  for (const s of [gmail, outlook, icloud]) {
    assert.ok(s.watchSelector, s.home);
    assert.equal(s.unloadWhenIdle, true);
  }
  assert.equal(gmail.watchSelector, 'tr.zA');
});

test('soket dinleyici: yalnız eşleşen soket; olay regex/boyut; diğer çerçeveler canlılık', async () => {
  const { EventEmitter } = await import('node:events');
  const { watchSocketFrames, LIGHTSPEED_EVENT } = await import('../src/connectors/browser/bridge.js');
  const page = new EventEmitter();
  const got: string[] = [];
  watchSocketFrames(page as never, [{ url: /gateway\.instagram\.com\/ws\/lightspeed/, event: LIGHTSPEED_EVENT }, { url: /chat-ws\.x\.com/, minBytes: 96 }], (k) => got.push(k));
  const sock = (url: string) => Object.assign(new EventEmitter(), { url: () => url });
  const ig = sock('wss://gateway.instagram.com/ws/lightspeed?x=1');
  const other = sock('wss://example.com/ws');
  const x = sock('wss://chat-ws.x.com/ws');
  for (const s of [ig, other, x]) page.emit('websocket', s);
  ig.emit('framereceived', { payload: Buffer.from('\x00\x01{"sp":["updateTypingIndicator"]}') });
  ig.emit('framereceived', { payload: Buffer.from('\x00\x01{"sp":["insertMessage","updateThreadSnippet"]}') });
  other.emit('framereceived', { payload: 'insertMessage' });
  x.emit('framereceived', { payload: Buffer.alloc(20) }); // ping
  x.emit('framereceived', { payload: Buffer.alloc(400) }); // şifreli mesaj
  assert.deepEqual(got, ['alive', 'event', 'alive', 'event']);
});

test('linkedin: mesajlaşma rozeti olay, bildirim rozeti değil', () => {
  assert.equal(realtimeKind('data: {"topic":"urn:li-realtime:tabBadgeUpdateTopic:x","payload":{"tab":"MESSAGING","count":2}}'), 'event');
  assert.equal(realtimeKind('data: {"topic":"urn:li-realtime:tabBadgeUpdateTopic:x","payload":{"tab":"NOTIFICATIONS","count":2}}'), 'alive');
});

test('PollTimer: sapmalı sıralı turlar; stop sonrası yeniden planlamaz; pazaryeri aralığı etkinliğe göre', async () => {
  const { PollTimer, marketDelay } = await import('../src/connectors/poll-timer.js');
  let n = 0;
  const t = new PollTimer(async () => void n++, () => 5).start();
  await new Promise((r) => setTimeout(r, 60));
  t.stop();
  const after = n;
  assert.ok(after >= 3, `tur: ${after}`);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(n, after, 'durduktan sonra tur yok');
  markActive(true);
  const a = marketDelay();
  markActive(false);
  const i = marketDelay();
  assert.ok(a >= 21_000 && a <= 39_000, String(a));
  assert.ok(i >= 42_000 && i <= 78_000, String(i));
});

test('429: Retry-After/X-RateLimit-Reset çözümleme ve PollTimer.backoff turu erteler', async () => {
  const { PollTimer, retryAfterSec } = await import('../src/connectors/poll-timer.js');
  const now = 1_800_000_000_000;
  assert.equal(retryAfterSec('120', 60, now), 120);
  assert.equal(retryAfterSec(null, 60, now), 60);
  assert.equal(retryAfterSec(String(now / 1000 + 90), 60, now), 90);
  assert.equal(retryAfterSec(new Date(now + 30_000).toUTCString(), 60, now), 30);
  assert.equal(retryAfterSec('bozuk', 45, now), 45);
  let n = 0;
  const t = new PollTimer(async () => void n++, () => 5).start();
  t.backoff(30); // ≥30 sn ertelenir
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(n, 0, 'bekleme sürerken tur yok');
  t.stop();
});
