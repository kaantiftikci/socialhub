import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';

/**
 * E-posta resmi girişi (çekirdek): XOAUTH2 belirteci merkezi modülle yenilenir, IMAP/SMTP yeni belirteçle bağlanır;
 * yenileme belirteci geçersizse "oturumu sona erdi"; uygulama şifreli eski hesaplar etkilenmez.
 * Gerçek sağlayıcı yok: sahte aracı (yerel HTTP, MIVELO_OAUTH_BROKER) + sahte IMAP istemcisi + Microsoft için sahte fetch.
 */
// Ortam, modüller içe aktarılmadan ÖNCE (DATA_DIR ve OAUTH_BROKER içe aktarılırken okunur)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-mail-oauth-'));
process.env.KAVSAK_DATA_DIR = tmp;
process.env.MIVELO_OAUTH_REMOTE = '0';

const calls: Array<{ provider: string; refresh_token: string }> = [];
let issued = 0;
const brokerSrv = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const action = new URL(req.url ?? '/', 'http://x').searchParams.get('action') ?? '';
    const body = data ? (JSON.parse(data) as { provider: string; refresh_token: string }) : { provider: '', refresh_token: '' };
    res.setHeader('content-type', 'application/json');
    if (action !== 'refresh') return void res.end(JSON.stringify({ error: 'unsupported' }));
    calls.push(body);
    if (body.refresh_token === 'rt-dead') return void res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
    if (body.refresh_token === 'rt-down') {
      res.statusCode = 502;
      return void res.end('<html>Bad gateway</html>');
    }
    issued++;
    // Google çoğunlukla yeni yenileme belirteci döndürmez; "rt-rotate" dönen sağlayıcıyı taklit eder
    const out: Record<string, unknown> = { access_token: `at-new-${issued}`, expires_in: 3599, token_type: 'Bearer' };
    if (body.refresh_token === 'rt-rotate') out.refresh_token = 'rt-rotated';
    res.end(JSON.stringify(out));
  });
});
await new Promise<void>((r) => brokerSrv.listen(0, '127.0.0.1', r));
process.env.MIVELO_OAUTH_BROKER = `http://127.0.0.1:${(brokerSrv.address() as AddressInfo).port}/oauth.php`;
process.env.MIVELO_OAUTH_CONFIG = JSON.stringify({
  google: { clientId: 'g-client.apps.googleusercontent.com' },
  microsoft: { clientId: '00000000-0000-0000-0000-000000000000' },
  yahoo: { clientId: 'yahoo-client' },
  yandex: { clientId: 'yandex-client' },
});

// Microsoft yenilemesi aracıdan değil doğrudan belirteç ucundan (gizisiz genel istemci): yalnız o adres taklit edilir
const realFetch = globalThis.fetch;
const msCalls: URLSearchParams[] = [];
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('https://login.microsoftonline.com/')) {
    const form = new URLSearchParams(String(init?.body ?? ''));
    msCalls.push(form);
    return new Response(JSON.stringify({ access_token: 'ms-at-new', refresh_token: 'ms-rt-2', expires_in: 3600 }), { headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
  brokerSrv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const { Store } = await import('../src/store.js');
const { sessionDir } = await import('../src/config.js');
const { MailConnector } = await import('../src/connectors/mail.js');
type Cfg = ConstructorParameters<typeof MailConnector>[2];
type Auth = { user: string; pass?: string; accessToken?: string };

/** Sahte ImapFlow: bağlanırken kimliği kaydeder; `reject` kümesindeki belirteçler XOAUTH2 reddi alır */
class FakeImap extends EventEmitter {
  connected = false;
  loggedOut = false;
  usable = true;
  opened = '';
  constructor(public auth: Auth, private reject: Set<string>) {
    super();
  }
  get mailbox() {
    return { path: this.opened || 'INBOX', uidValidity: 1n, uidNext: 1 };
  }
  async connect() {
    if (this.auth.accessToken !== undefined && this.reject.has(this.auth.accessToken))
      throw Object.assign(new Error('Command failed'), { authenticationFailed: true, response: 'NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)', serverResponseCode: 'AUTHENTICATIONFAILED' });
    this.connected = true;
  }
  async mailboxOpen(p: string) {
    this.opened = p;
  }
  async getMailboxLock(p: string) {
    this.opened = p;
    return { release() {} };
  }
  async search() {
    return [];
  }
  async *fetch() {}
  async list() {
    return [{ path: 'INBOX' }];
  }
  async messageFlagsAdd() {}
  async logout() {
    this.loggedOut = true;
  }
  close() {}
}

let n = 0;
function setup(platform: 'gmail' | 'outlook' | 'yahoo' | 'yandex' | 'icloud' | 'imap', cfg: Cfg, reject: string[] = []) {
  const store = new Store(path.join(tmp, `o${++n}.db`));
  const account = { id: `${platform}:o${n}`, platform, label: cfg.user, status: 'disconnected' as const, createdAt: Date.now() };
  store.upsertAccount(account);
  const c = new MailConnector({ ...account }, store, cfg);
  const imap: FakeImap[] = [];
  const idle: FakeImap[] = [];
  const rej = new Set(reject);
  const priv = c as unknown as {
    auth(): Auth;
    createImapClient: () => FakeImap;
    createIdleClient: () => FakeImap;
    cfg: Cfg;
    authFailed: boolean;
    idleClient?: FakeImap;
    idleUp: boolean;
    idleRecycle?: NodeJS.Timeout;
    timer?: NodeJS.Timeout;
    classify(e: unknown): void;
    recycleIdle(c: FakeImap): Promise<void>;
    createTransport: () => { sendMail(o: Record<string, unknown>): Promise<{ messageId?: string }> };
  };
  priv.createImapClient = () => {
    const f = new FakeImap(priv.auth(), rej);
    imap.push(f);
    return f;
  };
  priv.createIdleClient = () => {
    const f = new FakeImap(priv.auth(), rej);
    idle.push(f);
    return f;
  };
  const tokenFile = () => JSON.parse(fs.readFileSync(path.join(sessionDir(account.id), 'token'), 'utf8')) as Cfg & Record<string, unknown>;
  return { store, account, c, priv, imap, idle, rej, tokenFile };
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const SESSION_EXPIRED = /^Google oturumu sona erdi — yeniden giriş yap$/;

test('Gmail resmi giriş: süresi dolmuş belirteç aracıyla yenilenir, IMAP (kısa + IDLE) yeni belirteçle bağlanır, dosyaya yazılır', async () => {
  const before = calls.length;
  // registry birleştirmesinden kalan eski uygulama şifresi/istemci bilgileri resmi girişte dosyadan atılır
  const s = setup('gmail', { user: 'ornek@example.com', oauth: 'google', accessToken: 'at-old', refreshToken: 'rt-ok', expiresAt: Date.now() - 1000, pass: 'eski-sifre', clientId: 'eski', clientSecret: 'eski' });
  await s.c.start();
  await tick();
  assert.equal(s.c.account.status, 'connected', s.c.account.detail);
  assert.equal(calls.length - before, 1, 'tek yenileme (IDLE ve yoklama aynı anda yenilemez)');
  assert.deepEqual(calls.at(-1), { provider: 'google', refresh_token: 'rt-ok' });
  const fresh = s.priv.cfg.accessToken!;
  assert.match(fresh, /^at-new-\d+$/);
  assert.ok(s.imap.length >= 1 && s.idle.length === 1);
  for (const f of [...s.imap, ...s.idle]) assert.deepEqual(f.auth, { user: 'ornek@example.com', accessToken: fresh }, 'şifre değil XOAUTH2, eski belirteç değil yenisi');
  assert.equal(s.idle[0]!.opened, 'INBOX');
  assert.equal(s.priv.idleUp, true);
  assert.ok(s.priv.idleRecycle, 'IDLE belirteç bitmeden yenilenecek');
  const t = s.tokenFile();
  assert.equal(t.accessToken, fresh);
  assert.equal(t.refreshToken, 'rt-ok', 'yenileme belirteci dönmediyse eskisi kalır');
  assert.ok(t.expiresAt! > Date.now() + 50 * 60_000);
  assert.equal(t.oauth, 'google');
  assert.equal(t.pass, undefined);
  assert.equal(t.clientId, undefined);
  assert.equal(t.clientSecret, undefined);
  await s.c.stop();
});

test('Resmi giriş: dönen yeni yenileme belirteci saklanır; geçerli belirteçle yenileme yapılmaz', async () => {
  const s = setup('yahoo', { user: 'ornek@example.com', oauth: 'yahoo', accessToken: 'at-old', refreshToken: 'rt-rotate', expiresAt: Date.now() + 30_000 });
  await s.c.start();
  await tick();
  assert.equal(s.c.account.status, 'connected', s.c.account.detail);
  assert.equal(s.tokenFile().refreshToken, 'rt-rotated');
  assert.equal(calls.at(-1)?.provider, 'yahoo');
  await s.c.stop();
  // süresi uzak belirteç: aracıya gidilmez
  const before = calls.length;
  const v = setup('yandex', { user: 'ornek@example.com', oauth: 'yandex', accessToken: 'at-valid', refreshToken: 'rt-ok', expiresAt: Date.now() + 3600_000 });
  await v.c.start();
  await tick();
  assert.equal(v.c.account.status, 'connected', v.c.account.detail);
  assert.equal(calls.length, before);
  assert.equal(v.imap[0]!.auth.accessToken, 'at-valid');
  await v.c.stop();
});

test('invalid_grant → durum error "Google oturumu sona erdi — yeniden giriş yap", authFailed, IMAP\'e hiç gidilmez, otomatik deneme yok', async () => {
  const s = setup('gmail', { user: 'ornek@example.com', oauth: 'google', accessToken: 'at-old', refreshToken: 'rt-dead', expiresAt: Date.now() - 1000 });
  await s.c.start();
  assert.equal(s.c.account.status, 'error');
  assert.match(s.c.account.detail ?? '', SESSION_EXPIRED);
  assert.equal(s.priv.authFailed, true);
  assert.equal(s.imap.length + s.idle.length, 0);
  assert.equal(s.priv.timer, undefined, 'yoklama zamanlanmadı');
  // gönderim de aracıya gitmeden düşer
  const before = calls.length;
  await assert.rejects(s.c.compose({ to: 'kisi@example.com', subject: 'Konu', text: 'Merhaba' }), /oturumu sona erdi/);
  assert.equal(calls.length, before);
  await s.c.stop();

  // yenileme belirteci hiç yok: aracıya sormadan aynı durum
  const z = setup('gmail', { user: 'ornek@example.com', oauth: 'google', accessToken: 'at-old', expiresAt: Date.now() + 3600_000 });
  await z.c.start();
  assert.match(z.c.account.detail ?? '', SESSION_EXPIRED);
  assert.equal(calls.length, before);
  await z.c.stop();

  // aracı yanıt vermedi (502): oturum düşmüş SAYILMAZ (geçici hata; kendiliğinden iyileşme yeniden dener)
  const d = setup('gmail', { user: 'ornek@example.com', oauth: 'google', accessToken: 'at-old', refreshToken: 'rt-down', expiresAt: Date.now() - 1000 });
  await d.c.start();
  assert.equal(d.c.account.status, 'error');
  assert.doesNotMatch(d.c.account.detail ?? '', /sona erdi/);
  assert.equal(d.priv.authFailed, false);
  await d.c.stop();
});

test('XOAUTH2 reddi: belirteç bir kez zorla yenilenip yeniden denenir; yine reddedilirse oturum düşer', async () => {
  // yalnız eski belirteç reddediliyor → yenisiyle bağlanır
  const before = calls.length;
  const s = setup('gmail', { user: 'ornek@example.com', oauth: 'google', accessToken: 'at-stale', refreshToken: 'rt-ok', expiresAt: Date.now() + 3600_000 }, ['at-stale']);
  await s.c.start();
  await tick();
  assert.equal(s.c.account.status, 'connected', s.c.account.detail);
  assert.equal(calls.length - before, 1);
  assert.equal(s.imap[0]!.auth.accessToken, 'at-stale');
  assert.match(s.imap[1]!.auth.accessToken ?? '', /^at-new-/);
  await s.c.stop();

  // her belirteç reddediliyor (ör. kapsam geri alındı) → tek ek yenileme, sonra "oturumu sona erdi"
  const b2 = calls.length;
  const r = setup('gmail', { user: 'ornek@example.com', oauth: 'google', accessToken: 'at-stale', refreshToken: 'rt-ok', expiresAt: Date.now() + 3600_000 });
  (r.priv as unknown as { createImapClient: () => FakeImap }).createImapClient = () => {
    const f = new FakeImap((r.priv as unknown as { auth(): Auth }).auth(), new Set([String((r.priv as unknown as { auth(): Auth }).auth().accessToken)]));
    r.imap.push(f);
    return f;
  };
  await r.c.start();
  assert.equal(r.c.account.status, 'error');
  assert.match(r.c.account.detail ?? '', SESSION_EXPIRED);
  assert.equal(r.priv.authFailed, true);
  assert.equal(calls.length - b2, 1, 'yalnız bir zorunlu yenileme');
  assert.equal(r.imap.length, 2);
  await r.c.stop();
});

test('IDLE oturumu belirteç bitmeden yeni belirteçle yeniden kurulur; yenileme reddinde IDLE kapanır', async () => {
  const s = setup('gmail', { user: 'ornek@example.com', oauth: 'google', accessToken: 'at-1', refreshToken: 'rt-ok', expiresAt: Date.now() + 3600_000 });
  await s.c.start();
  await tick();
  const old = s.priv.idleClient!;
  assert.ok(old && s.idle.length === 1);
  // belirtecin bitmesine 2 dk kaldı: yenileme zamanı
  s.priv.cfg.expiresAt = Date.now() + 120_000;
  const before = calls.length;
  await s.priv.recycleIdle(old);
  await tick();
  assert.equal(calls.length - before, 1, 'zorla yenilendi');
  assert.equal(old.loggedOut, true, 'eski IDLE oturumu kapandı');
  assert.equal(s.idle.length, 2);
  assert.match(s.idle[1]!.auth.accessToken ?? '', /^at-new-/);
  assert.equal(s.priv.idleClient, s.idle[1]);
  assert.equal(s.priv.idleUp, true);
  // belirtecin bitmesine çok var: yeniden kurulmaz, yalnız yeniden planlanır
  const b2 = calls.length;
  await s.priv.recycleIdle(s.idle[1]!);
  assert.equal(calls.length, b2);
  assert.equal(s.idle.length, 2);
  // yenileme belirteci geçersiz → oturum düşer, IDLE kapanır
  s.priv.cfg.refreshToken = 'rt-dead';
  s.priv.cfg.expiresAt = Date.now() + 60_000;
  await s.priv.recycleIdle(s.idle[1]!);
  await tick();
  assert.match(s.c.account.detail ?? '', SESSION_EXPIRED);
  assert.equal(s.priv.idleClient, undefined);
  assert.equal(s.idle[1]!.loggedOut, true);
  await s.c.stop();
});

test('SMTP: resmi girişte XOAUTH2 (OAuth2 + erişim belirteci); EAUTH reddinde bir kez yenilenip yeniden gönderilir', async () => {
  const s = setup('yandex', { user: 'ornek@example.com', oauth: 'yandex', accessToken: 'at-y1', refreshToken: 'rt-ok', expiresAt: Date.now() + 3600_000 });
  // gerçek taşıyıcı: kimlik biçimi
  const real = (MailConnector.prototype as unknown as { createTransport(this: unknown): { options: Record<string, unknown> } }).createTransport.call(s.c);
  assert.deepEqual(real.options.auth, { type: 'OAuth2', user: 'ornek@example.com', accessToken: 'at-y1' });
  assert.equal(real.options.host, 'smtp.yandex.com');
  const seen: string[] = [];
  let first = true;
  s.priv.createTransport = () => {
    const tok = String(s.priv.cfg.accessToken);
    return {
      sendMail: async () => {
        seen.push(tok);
        if (first) {
          first = false;
          throw Object.assign(new Error('Invalid login: 535 5.7.8 Authentication failed'), { code: 'EAUTH', responseCode: 535 });
        }
        return { messageId: '<out@example.com>' };
      },
    };
  };
  const before = calls.length;
  const chat = await s.c.compose({ to: 'kisi@example.com', subject: 'Konu', text: 'Merhaba' });
  assert.equal(chat.name, 'Konu');
  assert.equal(calls.length - before, 1);
  assert.equal(seen[0], 'at-y1');
  assert.match(seen[1] ?? '', /^at-new-/);
  assert.equal(s.priv.authFailed, false, 'yalnız SMTP reddi oturumu düşürmez');
  await s.c.stop();
});

test('Outlook resmi giriş: Microsoft yenilemesi yerel (gizisiz), dönen yenileme belirteci saklanır; kişisel hesapta SMTP smtp-mail.outlook.com; cihaz kodu akışı çalışmaz', async () => {
  const s = setup('outlook', { user: 'ornek@outlook.com', oauth: 'microsoft', accessToken: 'ms-old', refreshToken: 'ms-rt-1', expiresAt: Date.now() - 1000 });
  assert.equal(s.priv.cfg.smtpHost, 'smtp-mail.outlook.com');
  assert.equal(s.priv.cfg.smtpPort, 587);
  assert.equal(s.priv.cfg.host, 'outlook.office365.com');
  await s.c.start();
  await tick();
  assert.equal(s.c.account.status, 'connected', s.c.account.detail);
  const form = msCalls.at(-1)!;
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'ms-rt-1');
  assert.equal(form.get('client_id'), '00000000-0000-0000-0000-000000000000');
  assert.equal(form.get('device_code'), null);
  assert.equal(s.imap[0]!.auth.accessToken, 'ms-at-new');
  assert.equal(s.tokenFile().refreshToken, 'ms-rt-2');
  await s.c.stop();
});

test('Eski yollar etkilenmez: uygulama şifreli hesap şifreyle bağlanır, aracıya gidilmez; eski Gmail OAuth geçerli belirteçle pencere açmaz', async () => {
  const before = calls.length;
  const p = setup('imap', { user: 'ornek@example.com', pass: 'uygulama-sifresi', host: 'imap.example.com', port: 993, smtpHost: 'smtp.example.com', smtpPort: 465 });
  await p.c.start();
  await tick();
  assert.equal(p.c.account.status, 'connected', p.c.account.detail);
  assert.deepEqual(p.imap[0]!.auth, { user: 'ornek@example.com', pass: 'uygulama-sifresi' });
  assert.deepEqual(p.idle[0]!.auth, { user: 'ornek@example.com', pass: 'uygulama-sifresi' });
  const real = (MailConnector.prototype as unknown as { createTransport(this: unknown): { options: Record<string, unknown> } }).createTransport.call(p.c);
  assert.deepEqual(real.options.auth, { user: 'ornek@example.com', pass: 'uygulama-sifresi' });
  await p.c.stop();

  // eski Gmail OAuth (kendi Google Cloud istemcisi): belirteç geçerliyse doğrudan bağlanır
  const g = setup('gmail', { user: 'ornek@example.com', clientId: 'eski.apps.googleusercontent.com', clientSecret: 'gizli', accessToken: 'eski-at', refreshToken: 'eski-rt', expiresAt: Date.now() + 3600_000 });
  await g.c.start();
  await tick();
  assert.equal(g.c.account.status, 'connected', g.c.account.detail);
  assert.equal(g.imap[0]!.auth.accessToken, 'eski-at');
  assert.equal(g.priv.cfg.clientId, 'eski.apps.googleusercontent.com', 'eski yapılandırmaya dokunulmaz');
  await g.c.stop();
  assert.equal(calls.length, before);
});

test('Kimlik reddi metinleri: iCloud uygulamaya özel parola, Diğer e-posta, Gmail uygulama şifresi', async () => {
  const err = () => Object.assign(new Error('Command failed'), { authenticationFailed: true, responseText: 'Authentication failed' });
  const i = setup('icloud', { user: 'ornek@icloud.com', pass: 'p' });
  i.priv.classify(err());
  assert.equal(i.c.account.status, 'error');
  assert.equal(i.c.account.detail, "Apple uygulamaya özel parola reddedildi — appleid.apple.com'da yeni parola oluşturup yeniden gir");
  assert.equal(i.priv.authFailed, true);
  const o = setup('imap', { user: 'ornek@example.com', pass: 'p', host: 'imap.example.com' });
  o.priv.classify(err());
  assert.equal(o.c.account.detail, 'Giriş reddedildi — e-posta ve şifreyi kontrol et');
  const g = setup('gmail', { user: 'ornek@example.com', pass: 'p' });
  g.priv.classify(err());
  assert.match(g.c.account.detail ?? '', /^Giriş reddedildi: uygulama şifresini kontrol edip/);
  // iCloud ön ayarı ve "Diğer e-posta" sunucu bulma yolu korunuyor
  assert.equal(i.priv.cfg.host, 'imap.mail.me.com');
  assert.equal(i.priv.cfg.smtpHost, 'smtp.mail.me.com');
  assert.equal(o.priv.cfg.host, 'imap.example.com');
});
