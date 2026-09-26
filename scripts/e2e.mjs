#!/usr/bin/env node
/**
 * Mivelo uçtan uca (E2E) canlı test aracı — gerçek hesaplarla, kullanıcının kendi Mac'inde çalışır.
 *
 * Fikir: her platform için ANA hesabın ve bir TEST hesabının ikisi de Mivelo'ya bağlıdır. Araç ana hesaptan test hesabına
 * mesaj atar, test hesabının Mivelo'da onu ne zaman gördüğünü ölçer, sonra test hesabından cevap atıp geri dönüşü ölçer.
 * Bu sırada çekirdeğin günlüklerini ve hesap durumlarını canlı izler, bilinen hataları sınıflandırır; isteğe bağlı olarak
 * arayüzü (localhost:5173) Chromium'da açıp konsol/sayfa hatalarını yakalar. Sonunda ~/.kavsak/e2e/ altına rapor yazar.
 *
 *   node scripts/e2e.mjs setup            # eşleştirme: hangi hesap → hangi test hesabı, hangi sohbet
 *   node scripts/e2e.mjs run [--ui] [wa ig …]   # tur(lar)ı çalıştır (platform süzgeci isteğe bağlı), raporla
 *   node scripts/e2e.mjs watch            # yalnız canlı günlük/durum izleme + sınıflandırma (Ctrl+C ile çık, rapor yazar)
 *   node scripts/e2e.mjs ui               # yalnız arayüz duman testi (konsol hataları, arama, sohbet açma)
 *
 * Güvenlik: her tur tek mesaj + tek cevap, turlar arası ≥8 sn; mesajlar "[Mivelo test]" etiketli; çekirdeğin gönderim
 * sınırları (send-guard) aynen geçerli. Hesap şifresi/çerez hiçbir yere gönderilmez; rapor yalnız süreleri ve günlükleri içerir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.KAVSAK_DATA_DIR ?? path.join(os.homedir(), '.kavsak');
const CORE = process.env.MIVELO_CORE ?? 'http://127.0.0.1:7788';
const UI = process.env.MIVELO_UI ?? 'http://localhost:5173';
const CFG = path.join(DATA_DIR, 'e2e.json');
const OUT_DIR = path.join(DATA_DIR, 'e2e');
const TOKEN = (() => {
  try {
    return fs.readFileSync(path.join(DATA_DIR, 'token'), 'utf8').trim();
  } catch {
    return '';
  }
})();

/* ───────── görünüm ───────── */
const tty = process.stdout.isTTY;
const c = (n) => (s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const dim = c(2), red = c(31), green = c(32), yellow = c(33), blue = c(34), magenta = c(35), cyan = c(36), bold = c(1);
const hhmmss = (t = Date.now()) => new Date(t).toLocaleTimeString('tr-TR', { hour12: false });
const sec = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} sn`);
const say = (...a) => console.log(dim(hhmmss()), ...a);

/* ───────── çekirdek API ───────── */
async function api(method, p, body) {
  const t0 = Date.now();
  const r = await fetch(CORE + '/api' + p, {
    method,
    headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-kavsak-token': TOKEN } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) throw Object.assign(new Error((data && data.error) || `${r.status} ${text.slice(0, 200)}`), { status: r.status, ms: Date.now() - t0 });
  return { data, ms: Date.now() - t0 };
}

/* ───────── günlük sınıflandırma (bilinen kök nedenler) ───────── */
const RULES = [
  { re: /__name is not defined/, kind: 'derleme', hint: 'Eski çekirdek çalışıyor (tsx keepNames). git pull + çekirdeği yeniden başlat.' },
  { re: /EADDRINUSE|7788.*(kullanımda|in use)/i, kind: 'port', hint: 'Masaüstü Mivelo açık: kapat ya da `lsof -ti :7788 | xargs kill`.' },
  { re: /\b429\b|rate.?limit|hız sınırı|too many/i, kind: 'hız sınırı', hint: 'Platform istek sınırı: geri çekilme devrede; turları seyrekleştir.' },
  { re: /checkpoint|challenge_required|captcha|doğrulama istedi|account\/access|authwall/i, kind: 'doğrulama', hint: 'Platform güvenlik doğrulaması istiyor: kanalda "Yeniden bağlan" → görünür pencerede çöz.' },
  { re: /pin\/recovery|PIN (gerekli|kodunu)|XChat PIN/i, kind: 'PIN', hint: 'X/Messenger şifreli sohbet PIN’i bekliyor: kanal uyarısında "PIN’i gir".' },
  { re: /oturum düşmüş|Oturum düştü|yeniden giriş gerekli|logged ?out|401\b.*(whatsapp|wa)/i, kind: 'oturum', hint: 'Oturum düştü: kanalda "Yeniden bağlan".' },
  { re: /JSON yerine sayfa|<!DOCTYPE html>/i, kind: 'API→HTML', hint: 'Platform JSON yerine sayfa döndürdü (oturum/başlık sorunu). Günlükteki uç adını rapora ekle.' },
  { re: /Voyager \d{3}/, kind: 'LinkedIn API', hint: 'LinkedIn Voyager isteği reddedildi; durum kodu rapordaki satırda.' },
  { re: /Bad MAC|No session|decrypt|SessionError|failed to decrypt/i, kind: 'WA şifreleme', hint: 'WhatsApp Signal oturumu: tek seferlikse normal; sürüyorsa eşleşmeyi yenile.' },
  { re: /Failed to fetch stream|media.*(403|404|410)|yeniden yükleme/i, kind: 'medya', hint: 'Medya bağlantısının süresi dolmuş: yeniden yükleme isteği devrede.' },
  { re: /gönderilemedi|Gönderilemedi|send.*fail/i, kind: 'gönderim', hint: 'Gönderim hatası: satırdaki platform mesajına bak.' },
  { re: /zaman aşımı|timed? ?out|Timeout \d+ms/i, kind: 'zaman aşımı', hint: 'Yavaş yanıt / asılı istek.' },
  { re: /anlık izleme kurulamadı|realtime|soket/i, kind: 'anlık sinyal', hint: 'Anlık akış kurulamadı: yoklama yedeği çalışır, mesajlar gecikmeli gelir.' },
  { re: /güvenlik sınırı|SendBlocked/i, kind: 'gönderim sınırı', hint: 'Mivelo’nun günlük/ilk temas sınırı devrede (send-guard).' },
  { re: /yoklama:|mesajlar alınamadı/i, kind: 'yoklama', hint: 'Tarayıcı köprüsü yoklaması hata verdi.' },
];
const PLATFORM_RE = /\b(whatsapp|telegram|slack|imessage|linkedin|instagram|messenger|x|gmail|outlook|yahoo|icloud|imap|trendyol|hepsiburada|n11|shopier|etsy|shopify|amazon)\b/i;
function classify(line) {
  const rule = RULES.find((r) => r.re.test(line.text));
  const pm = PLATFORM_RE.exec(line.text);
  return { ...line, kind: rule?.kind ?? (line.level === 'error' ? 'hata' : line.level === 'warn' ? 'uyarı' : 'bilgi'), hint: rule?.hint, platform: pm ? pm[1].toLowerCase() : undefined };
}

/* ───────── canlı olay akışı ───────── */
class Live {
  constructor() {
    this.logs = [];
    this.statusChanges = [];
    this.msgWaiters = new Set();
    this.events = 0;
    this.open = false;
    this.accounts = new Map();
  }
  async start({ printLogs = true } = {}) {
    this.printLogs = printLogs;
    const { data } = await api('GET', '/accounts');
    for (const a of data) this.accounts.set(a.id, a);
    await new Promise((resolve, reject) => {
      const url = CORE.replace(/^http/, 'ws') + '/ws' + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '');
      const ws = new WebSocket(url);
      this.ws = ws;
      const to = setTimeout(() => reject(new Error('WebSocket açılamadı (/ws)')), 8000);
      ws.onopen = () => (clearTimeout(to), (this.open = true), resolve());
      ws.onerror = () => {};
      ws.onclose = () => {
        this.open = false;
        if (!this.stopping) say(red('WebSocket kapandı — çekirdek durdu mu?'));
      };
      ws.onmessage = (m) => this.onEvent(JSON.parse(String(m.data)));
    });
  }
  stop() {
    this.stopping = true;
    try {
      this.ws?.close();
    } catch {}
  }
  onEvent(ev) {
    this.events++;
    if (ev.type === 'log') {
      const line = classify({ ts: Date.now(), level: ev.level, text: ev.text });
      this.logs.push(line);
      if (this.printLogs && line.level !== 'info') {
        const col = line.level === 'error' ? red : yellow;
        console.log(dim(hhmmss(line.ts)), col(`[${line.kind}]`), line.text.slice(0, 220));
        if (line.hint) console.log('          ', cyan('↳ ' + line.hint));
      }
    } else if (ev.type === 'account.status') {
      const prev = this.accounts.get(ev.account.id);
      if (!prev || prev.status !== ev.account.status || prev.attention !== ev.account.attention) {
        this.statusChanges.push({ ts: Date.now(), id: ev.account.id, platform: ev.account.platform, from: prev?.status, to: ev.account.status, detail: ev.account.statusDetail ?? ev.account.error, attention: ev.account.attention });
        if (this.printLogs) say(magenta(`[durum] ${ev.account.platform} ${prev?.status ?? '?'} → ${ev.account.status}`), dim(ev.account.attention ?? ev.account.statusDetail ?? ''));
      }
      this.accounts.set(ev.account.id, ev.account);
    } else if (ev.type === 'message.upsert') {
      for (const w of this.msgWaiters) w(ev);
    }
  }
  /** Bir sohbette metni `needle` içeren ve fromMe koşulunu sağlayan mesaj gelene dek bekle (WS + 10 sn'de bir yedek sorgu) */
  waitMessage(chatId, needle, { fromMe, timeoutMs }) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        this.msgWaiters.delete(onMsg);
        clearInterval(poll);
        clearTimeout(to);
        resolve(v);
      };
      const onMsg = (ev) => {
        if (ev.message.chatId === chatId && ev.message.fromMe === fromMe && (ev.message.text ?? '').includes(needle)) finish({ at: Date.now(), message: ev.message, via: 'ws', live: ev.live });
      };
      this.msgWaiters.add(onMsg);
      const check = async () => {
        try {
          const { data } = await api('GET', `/chats/${encodeURIComponent(chatId)}/messages?limit=40`);
          const m = data.find((x) => x.fromMe === fromMe && (x.text ?? '').includes(needle));
          if (m) finish({ at: Date.now(), message: m, via: 'sorgu' });
        } catch {}
      };
      // yedek: WS olayı kaçarsa (yeniden bağlanma) 10 sn'de bir depodan bak
      const poll = setInterval(check, 10_000);
      const to = setTimeout(() => finish(null), timeoutMs);
      void t0;
    });
  }
}

/* ───────── kurulum ───────── */
async function setup() {
  const { data: accounts } = await api('GET', '/accounts');
  const { data: chats } = await api('GET', '/chats');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const byPlat = new Map();
  for (const a of accounts) byPlat.set(a.platform, [...(byPlat.get(a.platform) ?? []), a]);
  console.log(bold('\nBağlı hesaplar:'));
  for (const [p, list] of byPlat) console.log(' ', p.padEnd(12), list.map((a) => `${a.label} ${dim('(' + a.status + ')')}`).join(' · '));
  console.log(
    dim(
      '\nHer platform için ANA hesabın ve TEST hesabın ikisi de Mivelo’ya bağlı olmalı (Uygulama bağla → aynı platformu ikinci kez bağla).\n' +
        'Tek hesap bağlıysa "elle" modu: araç senden gönderir, cevabı test cihazından SEN yazarsın; gelen cevabın süresi yine ölçülür.\n',
    ),
  );
  const pairs = [];
  const pickChat = async (acc, prompt) => {
    const mine = chats.filter((ch) => ch.accountId === acc.id);
    for (;;) {
      const q = (await rl.question(`  ${prompt} (${acc.label}) — sohbet adında geçen kelime: `)).trim().toLocaleLowerCase('tr-TR');
      if (!q) return null;
      const hits = mine.filter((ch) => ch.name.toLocaleLowerCase('tr-TR').includes(q) || (ch.handle ?? '').toLocaleLowerCase('tr-TR').includes(q)).slice(0, 9);
      if (!hits.length) {
        console.log(yellow('   eşleşen sohbet yok, tekrar dene (boş = atla)'));
        continue;
      }
      hits.forEach((h, i) => console.log(`   ${i + 1}) ${h.name} ${dim(h.kind + ' · ' + (h.handle ?? '') + ' · ' + h.id)}`));
      const n = Number(await rl.question('   numara: '));
      if (hits[n - 1]) return hits[n - 1];
    }
  };
  for (const [p, list] of byPlat) {
    const ok = list.filter((a) => a.status === 'connected');
    if (!ok.length) continue;
    const yes = (await rl.question(`\n${bold(p)} test edilsin mi? (e/h) `)).trim().toLowerCase();
    if (!yes.startsWith('e')) continue;
    const pickAcc = async (label) => {
      if (ok.length === 1) return ok[0];
      ok.forEach((a, i) => console.log(`   ${i + 1}) ${a.label}`));
      return ok[Number(await rl.question(`   ${label} hesap numarası: `)) - 1];
    };
    const a = await pickAcc('ANA');
    const aChat = a && (await pickChat(a, 'ANA hesapta test kişisiyle sohbet'));
    if (!aChat) continue;
    const others = ok.filter((x) => x.id !== a.id);
    let b = null,
      bChat = null;
    if (others.length) {
      b = others.length === 1 ? others[0] : await pickAcc('TEST');
      bChat = b && b.id !== a.id ? await pickChat(b, 'TEST hesapta ana hesapla sohbet') : null;
    }
    pairs.push({ platform: p, a: { accountId: a.id, label: a.label, chatId: aChat.id, chatName: aChat.name }, b: bChat ? { accountId: b.id, label: b.label, chatId: bChat.id, chatName: bChat.name } : null, manual: !bChat });
    console.log(green(`   ✓ ${p}: ${a.label} → ${aChat.name}${bChat ? `  ⇄  ${b.label} → ${bChat.name}` : dim('  (elle cevap modu)')}`));
  }
  rl.close();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CFG, JSON.stringify({ pairs }, null, 2), { mode: 0o600 });
  console.log(`\n${green('Kaydedildi:')} ${CFG}  ${dim(`(${pairs.length} platform)`)}\nŞimdi: ${bold('node scripts/e2e.mjs run --ui')}`);
}

/* ───────── tur ───────── */
const TIMEOUT = { linkedin: 420_000, x: 300_000, messenger: 300_000, instagram: 240_000, gmail: 240_000, outlook: 360_000, icloud: 240_000, yahoo: 240_000, imap: 240_000 };
async function roundTrip(live, pair, rl) {
  const id = Math.random().toString(36).slice(2, 7);
  const tag = `#e2e-${id}`;
  const res = { platform: pair.platform, pair: `${pair.a.label} → ${pair.a.chatName}`, tag, manual: pair.manual, steps: [], ok: false };
  const timeoutMs = TIMEOUT[pair.platform] ?? 180_000;
  // metin: Türkçe karakter + emoji → karakter bozulması da yakalanır
  // gidiş "-g", dönüş "-d" işaretli: bekleyiciler birbirinin mesajına takılmaz (elle modda etiketi içeren her cevap sayılır)
  const ping = `[Mivelo test] ${tag}-g gidiş · çğıöşü İĞÜ 😀 ${hhmmss()}`;
  say(bold(`▶ ${pair.platform}`), dim(`${pair.a.label} → ${pair.a.chatName}`), dim(`(bekleme sınırı ${timeoutMs / 1000} sn)`));

  // bekleyiciler gönderimden ÖNCE kurulur: çekirdek kendi kaydını HTTP yanıtından önce yayınlar, hızlı cevaplar da kaçmasın
  const selfP = live.waitMessage(pair.a.chatId, tag, { fromMe: true, timeoutMs: 20_000 });
  const deliverP = pair.b ? live.waitMessage(pair.b.chatId, `${tag}-g`, { fromMe: false, timeoutMs }) : null;
  const backP = live.waitMessage(pair.a.chatId, pair.manual ? tag : `${tag}-d`, { fromMe: false, timeoutMs: (pair.manual ? 600_000 : timeoutMs * 2) + 30_000 });
  // 1) ana → test
  let sendMs, sentAt;
  try {
    sentAt = Date.now();
    const r = await api('POST', `/chats/${encodeURIComponent(pair.a.chatId)}/send`, { text: ping });
    sendMs = r.ms;
    say(green('  gönderildi'), dim(`API ${r.ms} ms`));
  } catch (e) {
    res.steps.push({ step: 'gönder (ana→test)', error: e.message, ms: e.ms });
    say(red('  gönderilemedi: ' + e.message));
    return res;
  }
  res.sendMs = sendMs;
  // gönderenin kendi kaydı (fromMe) oluştu mu, bir kez mi
  const selfEcho = await selfP;
  res.selfEcho = !!selfEcho;
  res.selfMs = selfEcho ? selfEcho.at - sentAt : undefined;
  if (!selfEcho) res.steps.push({ step: 'kendi kaydı', error: 'Gönderilen mesaj 20 sn içinde ana hesabın sohbetinde görünmedi (arayüzde "gönderildi" balonu eksik kalır)' });

  if (pair.manual) {
    console.log(cyan(`  ↳ Şimdi test cihazından/hesabından bu sohbete cevap yaz: içinde "${tag}" geçsin (ör. "${tag} dönüş"). Bekleniyor…`));
  } else {
    const got = await deliverP;
    if (!got) {
      res.steps.push({ step: 'teslim (test tarafı)', error: `Test hesabı ${timeoutMs / 1000} sn içinde mesajı görmedi` });
      say(red(`  test tarafına ulaşmadı (${timeoutMs / 1000} sn)`));
      return finalize(live, pair, res);
    }
    res.deliverMs = got.at - sentAt;
    res.deliverLagMs = got.message.ts ? got.at - got.message.ts : undefined;
    res.deliverVia = got.via;
    res.textOk = got.message.text.includes('çğıöşü İĞÜ 😀');
    say(green(`  test tarafında görüldü: ${sec(res.deliverMs)}`), dim(`(platform zamanından ${sec(res.deliverLagMs)} sonra · ${got.via}${res.textOk ? '' : ' · METİN BOZUK'})`));
    await sleep(3000 + Math.random() * 2000);
    // 2) test → ana
    const pong = `[Mivelo test] ${tag}-d dönüş · teşekkürler 👍 ${hhmmss()}`;
    try {
      res.replySendAt = Date.now();
      const r = await api('POST', `/chats/${encodeURIComponent(pair.b.chatId)}/send`, { text: pong });
      res.replySendMs = r.ms;
      say(green('  cevap gönderildi'), dim(`API ${r.ms} ms`));
    } catch (e) {
      res.steps.push({ step: 'gönder (test→ana)', error: e.message, ms: e.ms });
      say(red('  cevap gönderilemedi: ' + e.message));
      return finalize(live, pair, res);
    }
  }
  const replyAt = res.replySendAt ?? Date.now();
  const back = await backP;
  if (!back) {
    res.steps.push({ step: 'teslim (ana taraf)', error: 'Cevap ana hesapta görünmedi' });
    say(red('  cevap ana tarafa ulaşmadı'));
    return finalize(live, pair, res);
  }
  res.replyMs = pair.manual ? undefined : back.at - replyAt;
  res.replyLagMs = back.message.ts ? back.at - back.message.ts : undefined;
  res.replyLive = back.live;
  res.replyVia = back.via;
  say(green(`  cevap ana tarafta görüldü${res.replyMs != null ? ': ' + sec(res.replyMs) : ''}`), dim(`(platform zamanından ${sec(res.replyLagMs)} sonra · ${back.via}${back.live === false ? ' · canlı değil: bildirim çalmaz!' : ''})`));
  res.ok = true;
  return finalize(live, pair, res);
}

/** Tur sonrası: kopya mesaj denetimi (aynı etiket iki kez) ve okunmamış sayısı */
async function finalize(live, pair, res) {
  await sleep(4000);
  const count = async (chatId) => {
    try {
      const { data } = await api('GET', `/chats/${encodeURIComponent(chatId)}/messages?limit=60`);
      return data.filter((m) => (m.text ?? '').includes(res.tag)).length;
    } catch {
      return null;
    }
  };
  res.copiesA = await count(pair.a.chatId);
  if (pair.b) res.copiesB = await count(pair.b.chatId);
  const expectA = res.ok ? 2 : 1;
  if (res.copiesA != null && res.copiesA > expectA) res.steps.push({ step: 'kopya', error: `Ana sohbette ${res.copiesA} kayıt (beklenen ${expectA}) — çift mesaj` });
  if (res.copiesB != null && res.copiesB > 2) res.steps.push({ step: 'kopya', error: `Test sohbetinde ${res.copiesB} kayıt (beklenen ≤2) — çift mesaj` });
  return res;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────── arayüz duman testi ───────── */
async function uiSmoke(tag) {
  const req = createRequire(path.join(HERE, '../packages/core/package.json'));
  let chromium;
  try {
    ({ chromium } = req('playwright'));
  } catch {
    return { skipped: 'playwright bulunamadı (packages/core bağımlılığı)' };
  }
  const out = { url: UI, consoleErrors: [], pageErrors: [], failedRequests: [], toastsErr: [], checks: [] };
  // Mivelo köprüsüyle aynı tarayıcı (channel: chromium); MIVELO_CHROMIUM ile başka bir yürütülebilir verilebilir
  const exe = process.env.MIVELO_CHROMIUM;
  let browser;
  try {
    browser = exe ? await chromium.launch({ executablePath: exe }) : await chromium.launch({ channel: 'chromium' }).catch(() => chromium.launch());
  } catch (e) {
    return { skipped: `tarayıcı açılamadı (${String(e.message).split('\n')[0]}) — \`npx playwright install chromium\` ya da MIVELO_CHROMIUM=/yol` };
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && out.consoleErrors.push(m.text().slice(0, 300)));
  page.on('pageerror', (e) => out.pageErrors.push(String(e.message).slice(0, 300)));
  page.on('requestfailed', (r) => r.url().includes('/api/') && out.failedRequests.push(`${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => r.url().includes('/api/') && r.status() >= 500 && out.failedRequests.push(`${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`));
  const check = (name, ok, detail = '') => out.checks.push({ name, ok, detail });
  try {
    const t0 = Date.now();
    await page.goto(UI, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('.row, .empty', { timeout: 45_000 });
    check('açılış', true, `${Date.now() - t0} ms`);
    const rows = await page.locator('.row').count();
    check('sohbet listesi', rows > 0, `${rows} satır`);
    if (rows) {
      await page.locator('.row').first().click();
      await page.waitForTimeout(1500);
      check('sohbet açılır', (await page.locator('.bwrap, .mail-card, .order-page, .empty').count()) > 0);
    }
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    await page.waitForTimeout(300);
    const pal = (await page.locator('.palette').count()) > 0;
    check('⌘K arama penceresi', pal);
    if (pal && tag) {
      await page.keyboard.type(tag);
      await page.waitForTimeout(1500);
      const n = await page.locator('.pal-row').count();
      check('aramada test mesajı', n > 0, `${n} sonuç`);
      if (n) {
        await page.locator('.pal-row').filter({ has: page.locator('time') }).first().click().catch(() => {});
        await page.waitForTimeout(1500);
        check('sonuçtan mesaja gidiş', (await page.locator('.bwrap.flash').count()) > 0);
      }
    }
    await page.keyboard.press('Escape');
    await page.locator('.nav-item', { hasText: 'Takvim' }).click().catch(() => {});
    await page.waitForTimeout(800);
    check('Takvim açılır', (await page.locator('.calview').count()) > 0);
    out.toastsErr = await page.locator('.toast.err').allInnerTexts().catch(() => []);
    await page.screenshot({ path: path.join(OUT_DIR, `ui-${Date.now()}.png`) }).catch(() => {});
  } catch (e) {
    check('arayüz', false, e.message.split('\n')[0]);
  }
  await browser.close();
  return out;
}

/* ───────── rapor ───────── */
function report({ results, live, ui, startedAt, health }) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const byKind = new Map();
  for (const l of live.logs.filter((l) => l.level !== 'info')) {
    const k = `${l.kind}|${l.platform ?? '-'}`;
    const g = byKind.get(k) ?? { kind: l.kind, platform: l.platform, n: 0, first: l.text, hint: l.hint };
    g.n++;
    byKind.set(k, g);
  }
  const lines = [];
  lines.push(`# Mivelo E2E raporu — ${new Date(startedAt).toLocaleString('tr-TR')}`, '');
  if (health) lines.push(`Çekirdek: ${health.os} · pid ${health.pid} · ${health.uptimeSec} sn açık · RSS ${health.memoryMb?.rss} MB · ${health.stats?.messages} mesaj`, '');
  if (results.length) {
    lines.push('## Mesaj turları', '', '| Platform | Gönderim API | Test tarafına ulaşma | (platform zamanından) | Cevap API | Cevabın gelişi | (platform zamanından) | Kopya | Metin | Sonuç |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const r of results)
      lines.push(
        `| ${r.platform}${r.manual ? ' (elle)' : ''} | ${r.sendMs ?? '—'} ms | ${sec(r.deliverMs)} | ${sec(r.deliverLagMs)} | ${r.replySendMs ?? '—'} ms | ${sec(r.replyMs)} | ${sec(r.replyLagMs)} | ${r.copiesA ?? '—'}/${r.copiesB ?? '—'} | ${r.textOk === false ? 'BOZUK' : r.textOk ? 'ok' : '—'} | ${r.ok ? '✅' : '❌ ' + (r.steps[0]?.error ?? '')} |`,
      );
    lines.push('');
    const problems = results.flatMap((r) => r.steps.map((s) => `- **${r.platform}** · ${s.step}: ${s.error}`));
    if (problems.length) lines.push('### Tur sorunları', ...problems, '');
    const notLive = results.filter((r) => r.replyLive === false).map((r) => r.platform);
    if (notLive.length) lines.push(`> Cevap "canlı" işaretsiz geldi (bildirim/ses çalmaz): ${notLive.join(', ')}`, '');
  }
  if (live.statusChanges.length) {
    lines.push('## Hesap durumu değişimleri', '');
    for (const s of live.statusChanges) lines.push(`- ${hhmmss(s.ts)} ${s.platform}: ${s.from ?? '?'} → ${s.to}${s.attention ? ` · uyarı: ${s.attention}` : ''}${s.detail ? ` · ${s.detail}` : ''}`);
    lines.push('');
  }
  lines.push('## Günlük özeti (uyarı/hata)', '');
  if (!byKind.size) lines.push('Uyarı/hata yok.', '');
  for (const g of [...byKind.values()].sort((a, b) => b.n - a.n)) lines.push(`- **${g.kind}** · ${g.platform ?? 'genel'} · ${g.n}× — \`${g.first.slice(0, 200).replace(/`/g, "'")}\`${g.hint ? `\n  - ↳ ${g.hint}` : ''}`);
  lines.push('');
  if (ui) {
    lines.push('## Arayüz', '');
    if (ui.skipped) lines.push(`Atlandı: ${ui.skipped}`, '');
    else {
      for (const ch of ui.checks) lines.push(`- ${ch.ok ? '✅' : '❌'} ${ch.name}${ch.detail ? ' — ' + ch.detail : ''}`);
      for (const e of ui.pageErrors) lines.push(`- ❌ sayfa hatası: \`${e}\``);
      for (const e of [...new Set(ui.consoleErrors)].slice(0, 15)) lines.push(`- ⚠️ konsol: \`${e}\``);
      for (const e of [...new Set(ui.failedRequests)].slice(0, 15)) lines.push(`- ⚠️ istek: \`${e}\``);
      for (const e of ui.toastsErr) lines.push(`- ⚠️ hata bildirimi: ${e}`);
      lines.push('');
    }
  }
  lines.push('## Son 60 uyarı/hata satırı', '', '```');
  for (const l of live.logs.filter((l) => l.level !== 'info').slice(-60)) lines.push(`${hhmmss(l.ts)} ${l.level.toUpperCase()} ${l.text.slice(0, 300)}`);
  lines.push('```', '');
  const md = path.join(OUT_DIR, `rapor-${stamp}.md`);
  fs.writeFileSync(md, lines.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `rapor-${stamp}.json`), JSON.stringify({ results, statusChanges: live.statusChanges, logs: live.logs.slice(-500), ui, health }, null, 2));
  return md;
}

/* ───────── komutlar ───────── */
async function preflight() {
  try {
    const { data } = await api('GET', '/health');
    return data;
  } catch (e) {
    console.error(red(`Çekirdeğe ulaşılamadı (${CORE}): ${e.message}\n`) + 'Önce başka bir terminalde `npm run dev` çalıştır (masaüstü Mivelo kapalı olsun).');
    process.exit(1);
  }
}

async function run(args) {
  const health = await preflight();
  if (!fs.existsSync(CFG)) {
    console.log(yellow('Önce eşleştirme: node scripts/e2e.mjs setup'));
    process.exit(1);
  }
  const { pairs } = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  const only = args.filter((a) => !a.startsWith('--'));
  const alias = { wa: 'whatsapp', tg: 'telegram', ig: 'instagram', li: 'linkedin', fb: 'messenger', im: 'imessage' };
  const want = only.map((a) => alias[a] ?? a);
  const todo = pairs.filter((p) => !want.length || want.includes(p.platform));
  const live = new Live();
  await live.start();
  // bağlı olmayan hesaplar
  for (const p of todo) for (const side of [p.a, p.b].filter(Boolean)) {
    const acc = live.accounts.get(side.accountId);
    if (!acc) say(red(`  ${p.platform}: hesap bulunamadı (${side.label}) — setup'ı yenile`));
    else if (acc.status !== 'connected') say(yellow(`  ${p.platform}: ${side.label} durumu "${acc.status}"${acc.attention ? ' · ' + acc.attention : ''}`));
  }
  const startedAt = Date.now();
  const results = [];
  console.log(bold(`\n${todo.length} platform test edilecek. Günlükler canlı akıyor; Ctrl+C ile durdurursan o ana kadarki rapor yazılır.\n`));
  let stopping = false;
  const writeAndExit = async (ui) => {
    live.stop();
    const md = report({ results, live, ui, startedAt, health });
    console.log(`\n${bold('Rapor:')} ${md}\n${dim('Bu dosyanın içeriğini Claude’a yapıştır; kök nedenleri düzeltir.')}`);
    process.exit(results.every((r) => r.ok) ? 0 : 2);
  };
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    void writeAndExit(null);
  });
  for (const p of todo) {
    if (stopping) break;
    const r = await roundTrip(live, p);
    results.push(r);
    console.log(r.ok ? green(`  ✓ ${p.platform} tamam`) : red(`  ✗ ${p.platform}: ${r.steps.map((s) => s.error).join(' | ')}`));
    await sleep(8000 + Math.random() * 4000);
  }
  // özet tablo
  console.log(bold('\nÖzet'));
  for (const r of results) console.log(`  ${r.ok ? green('✓') : red('✗')} ${r.platform.padEnd(11)} gidiş ${sec(r.deliverMs).padStart(8)}  dönüş ${sec(r.replyMs).padStart(8)}  API ${String(r.sendMs ?? '—').padStart(5)} ms  ${r.steps.length ? red(r.steps[0].error) : ''}`);
  let ui = null;
  if (args.includes('--ui')) {
    say(bold('Arayüz duman testi…'), dim(UI));
    ui = await uiSmoke(results.find((r) => r.ok)?.tag);
    for (const ch of ui.checks ?? []) console.log(`  ${ch.ok ? green('✓') : red('✗')} ${ch.name} ${dim(ch.detail ?? '')}`);
    if (ui.pageErrors?.length) console.log(red(`  sayfa hataları: ${ui.pageErrors.length}`));
  }
  await writeAndExit(ui);
}

async function watch() {
  const health = await preflight();
  const live = new Live();
  await live.start();
  const startedAt = Date.now();
  // mevcut son günlükleri de sınıflandır
  try {
    const { data } = await api('GET', '/logs');
    for (const l of data) live.logs.push(classify({ ts: l.ts, level: l.level, text: l.text }));
  } catch {}
  console.log(bold('Canlı izleme — uyarı/hata satırları sınıflandırılarak akar. Ctrl+C: rapor yaz ve çık.\n'));
  for (const a of live.accounts.values()) console.log(`  ${a.status === 'connected' ? green('●') : yellow('●')} ${a.platform.padEnd(11)} ${a.label} ${dim(a.status)}${a.attention ? yellow(' · ' + a.attention) : ''}`);
  console.log('');
  const tick = setInterval(async () => {
    try {
      const { data } = await api('GET', '/health');
      if (data.memoryMb?.rss > 1500) say(yellow(`[bellek] çekirdek RSS ${data.memoryMb.rss} MB`));
    } catch {
      say(red('[çekirdek] /api/health yanıt vermiyor — olay döngüsü kilitli ya da çekirdek düştü'));
    }
  }, 30_000);
  process.on('SIGINT', () => {
    clearInterval(tick);
    live.stop();
    const md = report({ results: [], live, ui: null, startedAt, health });
    console.log(`\n${bold('Rapor:')} ${md}`);
    process.exit(0);
  });
}

async function uiOnly() {
  await preflight();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const live = new Live();
  await live.start({ printLogs: true });
  const ui = await uiSmoke();
  for (const ch of ui.checks ?? []) console.log(`  ${ch.ok ? green('✓') : red('✗')} ${ch.name} ${dim(ch.detail ?? '')}`);
  live.stop();
  const md = report({ results: [], live, ui, startedAt: Date.now() });
  console.log(`\n${bold('Rapor:')} ${md}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'setup') await setup();
else if (cmd === 'run') await run(rest);
else if (cmd === 'watch') await watch();
else if (cmd === 'ui') await uiOnly();
else {
  console.log(`Kullanım:
  node scripts/e2e.mjs setup              ${dim('# ana ⇄ test hesap/sohbet eşleştirmesi (bir kez)')}
  node scripts/e2e.mjs run [--ui] [wa ig] ${dim('# mesaj turları + canlı günlük + (isteğe bağlı) arayüz testi → rapor')}
  node scripts/e2e.mjs watch              ${dim('# yalnız canlı günlük/durum izleme')}
  node scripts/e2e.mjs ui                 ${dim('# yalnız arayüz duman testi')}`);
}
