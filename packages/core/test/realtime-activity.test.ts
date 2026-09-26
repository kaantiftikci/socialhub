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
