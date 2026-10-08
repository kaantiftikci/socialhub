import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-tgphone-'));
process.env.KAVSAK_DATA_DIR = tmp;
process.env.MIVELO_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { bus } = await import('../src/bus.js');
const tg = await import('../src/connectors/telegram.js');
const { Api, errors } = await import('teleproto');
// teleproto'nun GERÇEK giriş akışı (numara → kod → 2FA döngüleri, RESTART_AUTH, kayıt gerekli); yalnız ağ çağrıları taklit
const auth = await import('teleproto/client/auth.js');

type Kind = 'phone' | 'code' | 'password';
type Step = Error | 'ok';
type SendCodeStep = Error | { phoneCodeHash: string; isCodeViaApp: boolean };

const PHONE = '+905000000099';
/** teleproto RPC hatası (sunucunun döndürdüğü gibi; FLOOD_WAIT için saniye) */
const rpc = (C: new (args: never) => Error, capture?: number): Error => new C({ request: undefined, capture } as never);

/** teleproto istemcisinin giriş için kullandığı yüzeyi taklit eder */
function fakeClient(script: { sendCode?: SendCodeStep[]; signIn?: Array<Step | 'signup'>; password?: Step[] }) {
  const calls = { sendCode: [] as string[], signIn: [] as string[], password: [] as string[], signUp: 0 };
  const client = {
    async sendCode(_c: unknown, phone: string) {
      calls.sendCode.push(phone);
      const r = script.sendCode?.shift();
      if (r instanceof Error) throw r;
      return r ?? { phoneCodeHash: 'hash', isCodeViaApp: true };
    },
    async invoke(req: unknown) {
      if (req instanceof Api.auth.SignIn) {
        calls.signIn.push(req.phoneCode ?? '');
        const r = script.signIn?.shift() ?? 'ok';
        if (r instanceof Error) throw r;
        if (r === 'signup') return new Api.auth.AuthorizationSignUpRequired({});
        return { user: { id: 1 } };
      }
      if (req instanceof Api.auth.SignUp) {
        calls.signUp++;
        return { user: { id: 2 } };
      }
      throw new Error('beklenmeyen istek');
    },
    // teleproto signInWithPassword döngüsünün aynısı (SRP hesabı olmadan): parola iste, hatada onError, true → AUTH_USER_CANCEL
    async signInWithPassword(_c: unknown, params: { password?: (hint?: string) => Promise<string>; onError: (e: Error) => Promise<boolean> | void }) {
      for (;;) {
        try {
          const p = await params.password!('ipucu');
          if (!p) throw new Error('Password is empty');
          calls.password.push(p);
          const r = script.password?.shift() ?? 'ok';
          if (r instanceof Error) throw r;
          return { id: 1 };
        } catch (err) {
          if (await params.onError(err as Error)) throw new Error('AUTH_USER_CANCEL');
        }
      }
    },
    signInUser(creds: { apiId: number; apiHash: string }, params: never) {
      return auth.signInUser(client as never, creds, params);
    },
  };
  return { client, calls };
}

/** Sırayla yanıt veren arayüz; sorulan her adım (tür + metin) kaydedilir */
function fakeIO(answers: Partial<Record<Kind, string[]>>, opts: { cancelAfter?: number } = {}) {
  const asked: Array<[Kind, string]> = [];
  let cancelled = false;
  const io = {
    async ask(kind: Kind, message: string) {
      asked.push([kind, message]);
      if (opts.cancelAfter !== undefined && asked.length > opts.cancelAfter) {
        cancelled = true;
        throw Object.assign(new Error('AUTH_USER_CANCEL'), { errorMessage: 'AUTH_USER_CANCEL' });
      }
      const v = answers[kind]?.shift();
      if (v === undefined) throw new Error(`fazladan soru: ${kind}`);
      return v;
    },
    cancelled: () => cancelled,
  };
  return { io, asked, kinds: () => asked.map(([k]) => k) };
}

const creds = { apiId: 1, apiHash: 'x' };

test('tgAuthError: hata kodları kullanıcı diline çevrilir', () => {
  const t = (e: unknown) => tg.tgAuthError(e);
  assert.match(t(rpc(errors.PhoneNumberInvalidError)).text, /^Telefon numarası geçersiz/);
  assert.equal(t(rpc(errors.PhoneNumberInvalidError)).retry, 'phone');
  assert.equal(t(rpc(errors.PhoneCodeInvalidError)).text, 'Kod hatalı, yeniden gir');
  assert.equal(t(rpc(errors.PhoneCodeInvalidError)).retry, 'code');
  assert.equal(t(rpc(errors.PhoneCodeExpiredError)).text, 'Kodun süresi doldu');
  assert.equal(t(rpc(errors.PhoneCodeExpiredError)).resend, true);
  assert.equal(t(rpc(errors.PasswordHashInvalidError)).text, 'Parola hatalı, yeniden gir');
  assert.equal(t(rpc(errors.PasswordHashInvalidError)).retry, 'password');
  // FLOOD_WAIT_X: teleproto FloodWaitError (errorMessage 'FLOOD' + seconds) ve ham kod
  assert.equal(t(rpc(errors.FloodWaitError, 300)).text, 'Çok fazla deneme; 5 dk sonra tekrar dene');
  assert.equal(t(rpc(errors.FloodWaitError, 61)).text, 'Çok fazla deneme; 2 dk sonra tekrar dene');
  assert.equal(t({ errorMessage: 'FLOOD_WAIT_86400' }).text, 'Çok fazla deneme; 24 sa sonra tekrar dene');
  assert.equal(t(rpc(errors.FloodWaitError, 300)).retry, undefined);
  assert.match(t(rpc(errors.PhoneNumberBannedError)).text, /engellenmiş/);
  assert.match(t({ errorMessage: 'PHONE_NUMBER_UNOCCUPIED' }).text, /hesabı yok/);
  assert.equal(t(new Error('Code is empty')).retry, 'code');
  assert.equal(t({ errorMessage: 'SOMETHING_ODD' }).text, 'Telegram girişi başarısız (SOMETHING_ODD)');
  assert.equal(t(new Error('connection reset 1.2.3.4')).text, 'Telegram girişi başarısız');
});

test('normalizePhone: uluslararası biçim, Türkiye varsayılan, geçersiz → undefined', () => {
  assert.equal(tg.normalizePhone('+90 500 000 00 99'), PHONE);
  assert.equal(tg.normalizePhone('0500 000 00 99'), PHONE);
  assert.equal(tg.normalizePhone('500-000-0099'), PHONE);
  assert.equal(tg.normalizePhone('00905000000099'), PHONE);
  assert.equal(tg.normalizePhone('(+90) 500 000 0099'), PHONE);
  assert.equal(tg.normalizePhone('905000000099'), PHONE);
  assert.equal(tg.normalizePhone('abc'), undefined);
  assert.equal(tg.normalizePhone('+12'), undefined);
  assert.equal(tg.normalizePhone(''), undefined);
});

test('signInWithPhone: sıra numara → kod → 2FA parolası; numara biçimlenir, kod boşluksuz gider', async () => {
  const { client, calls } = fakeClient({ signIn: [rpc(errors.SessionPasswordNeededError)] });
  const { io, asked, kinds } = fakeIO({ phone: ['0500 000 00 99'], code: ['12 345'], password: ['gizli'] });
  await tg.signInWithPhone(client, creds, io);
  assert.deepEqual(kinds(), ['phone', 'code', 'password']);
  assert.equal(asked[0][1], tg.PHONE_ASK);
  assert.equal(asked[1][1], 'Telegram uygulamana gelen kodu gir');
  assert.equal(asked[2][1], 'İki adımlı doğrulama parolanı gir');
  assert.deepEqual(calls.sendCode, [PHONE]);
  assert.deepEqual(calls.signIn, ['12345']);
  assert.deepEqual(calls.password, ['gizli']);
});

test('signInWithPhone: SMS ile gelen kodda metin SMS der; 2FA yoksa parola sorulmaz', async () => {
  const { client } = fakeClient({ sendCode: [{ phoneCodeHash: 'h', isCodeViaApp: false }] });
  const { io, asked, kinds } = fakeIO({ phone: [PHONE], code: ['11111'] });
  await tg.signInWithPhone(client, creds, io);
  assert.deepEqual(kinds(), ['phone', 'code']);
  assert.equal(asked[1][1], 'Telefonuna SMS ile gelen kodu gir');
});

test('signInWithPhone: geçersiz numara (yerelde ve sunucuda) aynı adımı hata metniyle yeniden sorar', async () => {
  const { client, calls } = fakeClient({ sendCode: [rpc(errors.PhoneNumberInvalidError)] });
  const { io, asked, kinds } = fakeIO({ phone: ['abc', '+1 555 000 0000', PHONE], code: ['22222'] });
  await tg.signInWithPhone(client, creds, io);
  assert.deepEqual(kinds(), ['phone', 'phone', 'phone', 'code']);
  assert.match(asked[1][1], /^Telefon numarası geçersiz/); // yerel denetim: sunucuya gitmedi
  assert.match(asked[2][1], /^Telefon numarası geçersiz/); // sunucu PHONE_NUMBER_INVALID
  assert.deepEqual(calls.sendCode, ['+15550000000', PHONE]);
});

test('signInWithPhone: hatalı kod ve hatalı parola yeniden sorulur', async () => {
  const { client, calls } = fakeClient({
    signIn: [rpc(errors.PhoneCodeInvalidError), rpc(errors.SessionPasswordNeededError)],
    password: [rpc(errors.PasswordHashInvalidError)],
  });
  const { io, asked, kinds } = fakeIO({ phone: [PHONE], code: ['00000', '33333'], password: ['yanlis', 'dogru'] });
  await tg.signInWithPhone(client, creds, io);
  assert.deepEqual(kinds(), ['phone', 'code', 'code', 'password', 'password']);
  assert.equal(asked[2][1], 'Kod hatalı, yeniden gir');
  assert.equal(asked[4][1], 'Parola hatalı, yeniden gir');
  assert.deepEqual(calls.signIn, ['00000', '33333']);
  assert.deepEqual(calls.password, ['yanlis', 'dogru']);
});

test('signInWithPhone: kodun süresi dolunca aynı numaraya yeni kod gider (numara yeniden sorulmaz)', async () => {
  const { client, calls } = fakeClient({ signIn: [rpc(errors.PhoneCodeExpiredError)] });
  const { io, asked, kinds } = fakeIO({ phone: [PHONE], code: ['44444', '55555'] });
  await tg.signInWithPhone(client, creds, io);
  assert.deepEqual(kinds(), ['phone', 'code', 'code']);
  assert.match(asked[2][1], /^Kodun süresi doldu; yeni kod gönderildi/);
  assert.deepEqual(calls.sendCode, [PHONE, PHONE]);
  assert.deepEqual(calls.signIn, ['44444', '55555']);
});

test('signInWithPhone: süresi dolan kod sınırsız yeniden gönderilmez', async () => {
  const exp = () => rpc(errors.PhoneCodeExpiredError);
  const { client, calls } = fakeClient({ signIn: [exp(), exp(), exp(), exp()] });
  const { io } = fakeIO({ phone: [PHONE], code: ['1', '2', '3', '4'] });
  await assert.rejects(tg.signInWithPhone(client, creds, io), { message: 'Kodun süresi doldu' });
  assert.equal(calls.sendCode.length, 4); // ilk + en çok 3 yeniden gönderim
});

test('signInWithPhone: FLOOD_WAIT girişi kullanıcı metniyle bitirir, yeniden sormaz', async () => {
  const { client } = fakeClient({ sendCode: [rpc(errors.FloodWaitError, 300)] });
  const { io, kinds } = fakeIO({ phone: [PHONE] });
  await assert.rejects(tg.signInWithPhone(client, creds, io), { message: 'Çok fazla deneme; 5 dk sonra tekrar dene' });
  assert.deepEqual(kinds(), ['phone']);
});

test('signInWithPhone: kayıtlı olmayan numarada yeni hesap AÇILMAZ', async () => {
  const { client, calls } = fakeClient({ signIn: ['signup'] });
  const { io } = fakeIO({ phone: [PHONE], code: ['66666'] });
  await assert.rejects(tg.signInWithPhone(client, creds, io), /hesabı yok/);
  assert.equal(calls.signUp, 0);
});

test('signInWithPhone: iptal edilince döngü durur, başka soru sorulmaz', async () => {
  const { client, calls } = fakeClient({});
  const { io, kinds } = fakeIO({ phone: [PHONE] }, { cancelAfter: 1 });
  await assert.rejects(tg.signInWithPhone(client, creds, io), { message: 'AUTH_USER_CANCEL' });
  assert.deepEqual(kinds(), ['phone', 'code']);
  assert.equal(calls.signIn.length <= 1, true);
});

test('TelegramConnector: soru account.prompt olarak gider, stop() bekleyen soruyu reddeder', async () => {
  const store = new Store(path.join(tmp, 'p.db'));
  const account = { id: 'telegram:p1', platform: 'telegram' as const, label: 'x', status: 'connecting' as const, createdAt: 1 };
  store.upsertAccount(account);
  const c = new tg.TelegramConnector(account, store);
  const seen: unknown[] = [];
  const off = bus.on((ev) => {
    if (ev.type === 'account.prompt') seen.push(ev);
  });
  try {
    const priv = c as unknown as { ask(k: Kind, m: string): Promise<string> };
    const first = priv.ask('code', 'Kodu gir');
    c.provideInput('code', '12345');
    assert.equal(await first, '12345');
    const pending = priv.ask('phone', tg.PHONE_ASK);
    assert.equal(account.status, 'pairing');
    await c.stop();
    await assert.rejects(pending, { message: 'AUTH_USER_CANCEL' });
    assert.equal(seen.length, 2);
    assert.deepEqual((seen[1] as { prompt: string }).prompt, 'phone');
  } finally {
    off?.();
  }
});
