import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * Resmi giriş altyapısı: yetki adresi, state/port, PKCE, aracı (broker) değişimi, akış durumu ve belirteç → hesap yapılandırması.
 * Gerçek sağlayıcı yok: sahte aracı (yerel HTTP) + doğrudan /oauth/callback çözümü.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-oauth-'));
process.env.KAVSAK_DATA_DIR = tmp;
process.env.MIVELO_OAUTH_REMOTE = '0';

const calls: Array<{ action: string; body: Record<string, string> }> = [];
const brokerSrv = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const action = new URL(req.url ?? '/', 'http://x').searchParams.get('action') ?? '';
    const body = data ? (JSON.parse(data) as Record<string, string>) : {};
    calls.push({ action, body });
    res.setHeader('content-type', 'application/json');
    if (action === 'token' && body.provider === 'google') {
      // id_token yükü: {"email":"ornek@example.com"}
      const payload = Buffer.from(JSON.stringify({ email: 'ornek@example.com', name: 'Örnek' })).toString('base64url');
      return void res.end(JSON.stringify({ access_token: 'ya29.test', refresh_token: '1//rt', expires_in: 3599, id_token: `x.${payload}.y` }));
    }
    if (action === 'token' && body.provider === 'slack') {
      return void res.end(JSON.stringify({ ok: true, authed_user: { id: 'U1', access_token: 'xoxp-1-2-3' }, team: { id: 'T1', name: 'Örnek Ekip' } }));
    }
    if (action === 'refresh') return void res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
    res.end(JSON.stringify({ error: 'unsupported' }));
  });
});
await new Promise<void>((r) => brokerSrv.listen(0, '127.0.0.1', r));
const brokerUrl = `http://127.0.0.1:${(brokerSrv.address() as AddressInfo).port}/oauth.php`;
process.env.MIVELO_OAUTH_BROKER = brokerUrl;
process.env.MIVELO_OAUTH_CONFIG = JSON.stringify({ google: { clientId: 'g-client.apps.googleusercontent.com' }, slack: { clientId: '111.222', historyLimited: true }, microsoft: { clientId: '00000000-0000-0000-0000-000000000000' } });
after(() => {
  brokerSrv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const oauth = await import('../src/oauth/index.js');
const { resolveOAuth } = await import('../src/oauth/callback.js');
const flows = await import('../src/oauth/flows.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('yetki adresi: Google geri döngü + PKCE + offline; Slack user_scope + HTTPS geri dönüş + state sonunda port', async () => {
  const cfg = await oauth.oauthConfig();
  const st = oauth.makeState('google', 7788);
  assert.ok(!st.includes('.'), 'geri döngüde port state içinde değil');
  const g = new URL(oauth.buildAuthUrl('google', cfg.google!, { state: st, challenge: 'abc', loginHint: 'ornek@example.com', port: 7788 }));
  assert.equal(g.origin + g.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(g.searchParams.get('redirect_uri'), 'http://127.0.0.1:7788/oauth/callback');
  assert.equal(g.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(g.searchParams.get('access_type'), 'offline');
  assert.match(g.searchParams.get('scope') ?? '', /https:\/\/mail\.google\.com\//);
  assert.equal(g.searchParams.get('login_hint'), 'ornek@example.com');

  const ss = oauth.makeState('slack', 7788);
  assert.match(ss, /^[A-Za-z0-9_-]{16,64}\.7788$/);
  const s = new URL(oauth.buildAuthUrl('slack', cfg.slack!, { state: ss }));
  assert.equal(s.searchParams.get('redirect_uri'), oauth.OAUTH_BOUNCE);
  assert.ok(s.searchParams.get('user_scope')?.includes('im:history'));
  assert.equal(s.searchParams.get('scope'), null);
  assert.equal(s.searchParams.get('code_challenge'), null, 'Slack PKCE kullanmaz');

  const m = new URL(oauth.buildAuthUrl('microsoft', cfg.microsoft!, { state: 'x', challenge: 'c', port: 7788 }));
  assert.equal(m.searchParams.get('redirect_uri'), 'http://localhost:7788/oauth/callback');
  assert.match(m.searchParams.get('scope') ?? '', /IMAP\.AccessAsUser\.All/);
});

test('Facebook: config_id varsa kapsam yerine o gönderilir (İşletmeler için Facebook Girişi)', () => {
  const u = new URL(oauth.buildAuthUrl('facebook', { clientId: '123', configId: '987654321' }, { state: 'a.7788' }));
  assert.equal(u.searchParams.get('config_id'), '987654321');
  assert.equal(u.searchParams.get('scope'), null);
  const k = new URL(oauth.buildAuthUrl('facebook', { clientId: '123' }, { state: 'a.7788' }));
  assert.match(k.searchParams.get('scope') ?? '', /pages_messaging/);
});

test('PKCE: S256 doğru (RFC 7636 örneği)', () => {
  const p = oauth.pkcePair('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(p.challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('yapılandırma: yalnız istemci kimliği olan sağlayıcılar etkin; resmi platformlar', async () => {
  const pls = await flows.officialPlatforms();
  assert.deepEqual(pls.sort(), ['gmail', 'outlook', 'slack']);
});

test('akış: Google girişi → aracı değişimi → e-posta adresi id_token\'dan → hesap eklenir (yenileme belirteci saklanır)', async () => {
  const added: Array<{ platform: string; token: string; label?: string }> = [];
  const f = await flows.startFlow('gmail', { noBrowser: true, add: async (platform, o) => (added.push({ platform, ...o }), { id: 'gmail:1', platform, label: o.label ?? '', status: 'connecting', createdAt: 1 }) });
  assert.equal(f.state, 'waiting');
  const u = new URL(f.url!);
  assert.ok(resolveOAuth(u.searchParams.get('state')!, { code: '4/abc' }));
  for (let i = 0; i < 50 && flows.getFlow(f.id)?.state !== 'done'; i++) await sleep(20);
  const v = flows.getFlow(f.id)!;
  assert.equal(v.state, 'done', v.error);
  assert.equal(v.accountId, 'gmail:1');
  const tok = JSON.parse(added[0]!.token) as Record<string, unknown>;
  assert.equal(tok.user, 'ornek@example.com');
  assert.equal(tok.oauth, 'google');
  assert.equal(tok.refreshToken, '1//rt');
  assert.equal(added[0]!.label, 'ornek@example.com');
  const tc = calls.find((c) => c.action === 'token' && c.body.provider === 'google')!;
  assert.equal(tc.body.code, '4/abc');
  assert.ok(tc.body.code_verifier && tc.body.code_verifier.length >= 43, 'PKCE doğrulayıcısı aracıya gider');
  assert.equal(tc.body.redirect_uri, 'http://127.0.0.1:7788/oauth/callback');
});

test('akış: Slack kullanıcı belirteci (authed_user) + çalışma alanı adı; iptal ve hata durumları', async () => {
  let token = '';
  const f = await flows.startFlow('slack', { noBrowser: true, add: async (platform, o) => ((token = o.token), { id: 'slack:1', platform, label: o.label ?? '', status: 'connecting', createdAt: 1 }) });
  const st = new URL(f.url!).searchParams.get('state')!;
  resolveOAuth(st, { code: 'slack-code' });
  for (let i = 0; i < 50 && flows.getFlow(f.id)?.state !== 'done'; i++) await sleep(20);
  const t = JSON.parse(token) as Record<string, unknown>;
  assert.equal(t.token, 'xoxp-1-2-3');
  assert.equal(t.team, 'Örnek Ekip');
  assert.equal(t.historyLimited, true);

  // iptal
  const g = await flows.startFlow('gmail', { noBrowser: true, add: async () => assert.fail('eklenmemeli') });
  assert.ok(flows.cancelFlow(g.id));
  assert.equal(flows.getFlow(g.id)?.state, 'cancelled');
  // kullanıcı izin vermedi
  const h = await flows.startFlow('gmail', { noBrowser: true, add: async () => assert.fail('eklenmemeli') });
  resolveOAuth(new URL(h.url!).searchParams.get('state')!, { error: 'access_denied' });
  for (let i = 0; i < 50 && flows.getFlow(h.id)?.state === 'waiting'; i++) await sleep(20);
  assert.equal(flows.getFlow(h.id)?.state, 'error');
  assert.match(flows.getFlow(h.id)?.error ?? '', /izin verilmedi|iptal/);
});

test('yenileme: aracı invalid_grant → OAuthError.revoked (kullanıcı yeniden giriş yapmalı)', async () => {
  await assert.rejects(oauth.refreshToken('google', '1//old'), (e: unknown) => e instanceof oauth.OAuthError && e.revoked);
});

test('resmi Graph belirteci tanıma', () => {
  assert.equal(flows.officialKind(JSON.stringify({ official: 'instagram', accessToken: 'x', userId: '1' })), 'instagram');
  assert.equal(flows.officialKind(JSON.stringify({ official: 'facebook', userToken: 'x', pages: [] })), 'facebook');
  assert.equal(flows.officialKind('xoxp-1'), undefined);
  assert.equal(flows.officialKind(undefined), undefined);
});
