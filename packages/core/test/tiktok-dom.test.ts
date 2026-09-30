import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, type Page } from 'playwright';
import { resetTikTokState, rowIds, tiktok } from '../src/connectors/browser/tiktok.js';
import { watchDom, type Thread } from '../src/connectors/browser/bridge.js';

/**
 * TikTok DOM okuyucusu gerçek Chromium'da, sahte TikTok sayfalarıyla (gerçek siteye istek YOK; page.route):
 * (a) 2026 data-e2e düzeni (dm-new-*), (b) data-e2e'siz, durumla hash'i değişen emotion sınıfları + sol menüde "takip edilenler"
 * + açık grup sohbeti (eskiden mesaj satırları sohbet sanılıyordu), (c) Business Suite: yönlendirme + gömülü çerçeve, gün blokları,
 * <p>'siz balonlar, "Görüldü", tıklama işleyicisi iç öğede, (d) tek sohbetli liste. Chromium yoksa (CI) atlanır.
 */
const EXE = process.env.TIKTOK_TEST_CHROMIUM || '/opt/pw-browsers/chromium';
const HAS = fs.existsSync(EXE);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const IMG = (n: string) => `https://p16-sign.tiktokcdn.com/${n}.jpeg`;
/**
 * "Bugün" saatleri şimdiden GERİDE olmalı: kod bugünün ileri saatini (gerçekte olamaz) düne çeker. Sabit "09:15" gibi saatler
 * gece yarısından sonra testleri düşürüyordu → bugünkü saatler şimdi − 45 dk tabanından (gece yarısını geçmez) dakika eklenerek.
 */
const TODAY0 = (() => {
  const n = new Date();
  const mid = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  return Math.max(mid, n.getTime() - 45 * 60_000);
})();
const hm = (addMin: number) => {
  const d = new Date(TODAY0 + addMin * 60_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
/** gece yarısından hemen sonra bugünkü bloklar için yeterli geçmiş dakika yok */
const EARLY = (Date.now() - new Date(new Date().setHours(0, 0, 0, 0)).getTime()) < 30 * 60_000;

type Reply = { status?: number; body?: string };

async function withPage(handler: (u: URL) => Reply, fn: (page: Page) => Promise<void>): Promise<void> {
  resetTikTokState();
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-proxy-server'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'tr-TR' });
    // köprüdeki gibi: tsx'in __name yardımcısı + görünmez oturumun "arka planda/odaksız" taklidi
    await ctx.addInitScript({ content: 'globalThis.__name = globalThis.__name || function (t) { return t; };' });
    await ctx.addInitScript(() => {
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
      Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
      document.hasFocus = () => false;
    });
    await ctx.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (/tiktokcdn\.com$/.test(u.hostname)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      if (u.hostname !== 'www.tiktok.com') return route.abort();
      const r = handler(u);
      return route.fulfill({ status: r.status ?? 200, contentType: 'text/html; charset=utf-8', body: r.body ?? '' });
    });
    const page = await ctx.newPage();
    await fn(page);
  } finally {
    await browser.close();
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const byName = (ts: Thread[], name: string) => {
  const t = ts.find((x) => x.name === name);
  assert.ok(t, `sohbet listede yok: ${name} (liste: ${ts.map((x) => x.name).join(', ')})`);
  return t;
};
const nonIncreasing = (ts: Thread[]) => ts.every((t, i) => i === 0 || t.lastTs <= ts[i - 1].lastTs);

// ---------------------------------------------------------------- (a) data-e2e (dm-new-*) düzeni
interface AMsg {
  sep?: string;
  me?: boolean;
  text?: string;
  video?: boolean;
}
const A_CHATS: Array<{ conv: string; name: string; handle: string; time: string; preview: string; unread: number; msgs: AMsg[] }> = [
  {
    conv: '0:1:111:222',
    name: 'Ayşe Yılmaz',
    handle: 'ayse.y',
    time: '14:32',
    preview: 'Yarın görüşürüz',
    unread: 0,
    msgs: [{ sep: 'Bugün 14:20' }, { text: 'Merhaba, nasılsın?' }, { me: true, text: 'İyiyim, sen?' }, { text: 'Yarın görüşürüz' }],
  },
  { conv: '0:1:111:333', name: 'Mert', handle: 'mert', time: '13:05', preview: 'okkkk', unread: 2, msgs: [{ sep: 'Bugün 13:00' }, { text: 'Sayı tahmini?' }, { text: 'okkkk' }] },
  { conv: '0:1:111:444', name: 'Deniz', handle: 'deniz', time: 'Dün', preview: '2', unread: 0, msgs: [{ sep: 'Dün 18:10' }, { video: true }, { me: true, text: '2' }] },
];

function pageA(): string {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Mesajlar | TikTok</title>
<style>
body{margin:0;font:14px/1.3 Arial,sans-serif}
#app-header{height:60px;border-bottom:1px solid #eee;display:flex;align-items:center;padding:0 16px}
.body{display:flex;height:calc(100vh - 61px)}
.rail{width:72px;flex:none;border-right:1px solid #eee}
.drawer{width:320px;flex:none;overflow-y:auto;border-right:1px solid #eee}
.row{display:flex;align-items:center;justify-content:space-between;height:72px;padding:0 16px;cursor:pointer}
.row[aria-selected="true"]{background:#f1f1f2}
.info{display:flex;align-items:center;gap:12px;min-width:0}
.av img{width:48px;height:48px;border-radius:50%;display:block}
.txt p{margin:0}
.unr{background:#fe2c55;color:#fff;border-radius:9px;padding:0 6px;font-size:12px}
.main{flex:1;display:flex;flex-direction:column;min-width:0}
.head{height:64px;display:flex;align-items:center;gap:12px;padding:0 16px;border-bottom:1px solid #eee}
.head p{margin:0}
.list{flex:1;overflow-y:auto;padding:16px}
.item{display:flex;align-items:flex-end;gap:8px;margin:6px 0}
.item img{width:32px;height:32px;border-radius:50%;display:block}
.vert{display:flex;flex-direction:column;align-items:flex-start;flex:1}
.item.me .vert{align-items:flex-end}
.bub{background:#f1f1f2;border-radius:8px;padding:7px 12px;max-width:60%}
.bub p{margin:0}
.item.me .bub{background:#fe2c55;color:#fff}
.sepr{text-align:center;color:#888;font-size:12px;margin:12px 0}
.editor{margin:12px 16px;border:1px solid #ddd;border-radius:8px;padding:10px;min-height:20px;display:flex}
.editor .DraftEditor-root{flex:1}
</style></head><body>
<div id="app">
  <div id="app-header" class="css-b2toi6-7937d88b--DivHeaderContainer"><strong>TikTok</strong><div data-e2e="top-dm-icon" style="margin-left:auto">✉</div></div>
  <div class="body css-2kk9ks-7937d88b--BaseBodyContainer">
    <div class="rail css-1r9paic-7937d88b--DivSideNavContainer"><a data-e2e="nav-foryou" href="/">Sana Özel</a></div>
    <div class="drawer css-gp2j1n-7937d88b--DivDrawerContainer"><div class="css-14g5ixu-7937d88b--DivMessageDrawerContainer"><div data-e2e="dm-new-conversation-list" id="convs"></div></div></div>
    <div id="main-content-messages" class="main css-16jztn7-7937d88b--DivFullSideNavLayout"><div data-e2e="dm-new-chatbox" id="box" style="display:flex;flex-direction:column;height:100%"></div></div>
  </div>
</div>
<script>
const CHATS = ${JSON.stringify(A_CHATS)};
const IMG = (n) => 'https://p16-sign.tiktokcdn.com/' + n + '.jpeg';
let open = 0;
function renderList() {
  const el = document.getElementById('convs');
  el.innerHTML = CHATS.map((c, i) => '<div data-e2e="dm-new-conversation-item" data-conv-id="' + c.conv + '" aria-selected="' + (i === open) + '" tabindex="0" class="row css-5dyypj-7937d88b--DivItemWrapper">'
    + '<div class="info css-1235430-7937d88b--DivItemInfo"><div data-e2e="dm-new-conversation-avatar" class="av css-s2bdae-7937d88b--DivInfoAvatarWrapper"><span shape="circle"><img alt="" src="' + IMG('av' + i) + '"></span></div>'
    + '<div class="txt css-1xz5qg8-7937d88b--DivInfoTextWrapper"><p data-e2e="dm-new-conversation-nickname" class="css-1k2hcus-7937d88b--PInfoNickname2"><span class="css-1l7v5bm-7937d88b--SpanNicknameText2">' + c.name + '</span></p>'
    + '<p class="css-14no2wl-7937d88b--PInfoExtractTime"></p><p class="css-' + (c.unread ? '1noss6b' : 'zf4dgs') + '-7937d88b--SpanInfoExtract">' + c.preview + '</p>'
    + '<span class="css-1ihsu6w-7937d88b--SpanInfoTime">' + c.time + '</span></div></div>'
    + '<div class="css-1ckmmz1-7937d88b--DivTrailing">' + (c.unread ? '<span data-e2e="dm-new-conversation-unread"><span class="unr css-1n9k5fu-7937d88b--SpanNewMessage2">' + c.unread + '</span></span>' : '') + '<div role="button" tabindex="-1" data-e2e="conversation-more-action"></div></div></div>').join('');
  el.querySelectorAll('[data-e2e="dm-new-conversation-item"]').forEach((row, i) => row.addEventListener('click', () => { open = i; CHATS[i].unread = 0; renderList(); renderBox(); }));
}
function renderBox() {
  const c = CHATS[open];
  const msgs = c.msgs.map((m, i) => '<div data-index="' + i + '">' + (m.sep ? '<div data-e2e="dm-new-time-separator" class="sepr"><span>' + m.sep + '</span></div>'
    : '<div data-e2e="dm-new-chat-item" class="item css-9x-7937d88b--DivChatItemWrapper' + (m.me ? ' me' : '') + '">'
      + (m.me ? '' : '<a href="/@' + c.handle + '"><span data-e2e="chat-avatar"><img alt="" src="' + IMG('av' + open) + '"></span></a>')
      + '<div class="vert css-2y-7937d88b--DivMessageVerticalContainer">'
      + (m.video ? '<div data-e2e="dm-new-shared-video" style="width:180px;height:240px;border-radius:8px;background-image:url(' + IMG('cover' + open) + ');background-size:cover"></div>'
        : '<div data-e2e="dm-new-message-text" class="bub css-3z-7937d88b--DivTextContainer"><p class="css-4w-7937d88b--PText">' + m.text + '</p></div>')
      + (m.me ? '<div style="font-size:11px;color:#999">Görüldü</div>' : '') + '</div><div data-e2e="dm-warning"></div></div>') + '</div>').join('');
  const box = document.getElementById('box');
  box.innerHTML = '<div class="head css-15mk60j-7937d88b--DivChatHeader"><div tabindex="0" role="link" aria-label="' + c.name + ' profili" style="display:flex;gap:12px;align-items:center">'
    + '<a rel="opener" href="/@' + c.handle + '" target="_blank"><span data-e2e="top-chat-avatar"><img alt="" src="' + IMG('av' + open) + '" style="width:40px;height:40px;border-radius:50%"></span></a>'
    + '<a rel="opener" href="/@' + c.handle + '" target="_blank" style="color:inherit;text-decoration:none"><p data-e2e="dm-new-chat-nickname" class="css-vnhzl1-7937d88b--PNickname">' + c.name + '</p><p data-e2e="chat-uniqueid">@' + c.handle + '</p></a></div></div>'
    + '<div data-e2e="dm-new-message-list" class="list">' + msgs + '</div>'
    + '<div data-e2e="dm-new-input-editor" class="editor"><div class="DraftEditor-root"><div class="notranslate public-DraftEditor-content" contenteditable="true" role="textbox" aria-label="Mesaj gönder..."></div></div>'
    + '<svg data-e2e="dm-new-send-btn" width="24" height="24" style="display:none;cursor:pointer"><circle cx="12" cy="12" r="10" fill="#fe2c55"/></svg></div>';
  const ed = box.querySelector('[contenteditable]');
  const btn = box.querySelector('[data-e2e="dm-new-send-btn"]');
  const send = () => { const t = ed.innerText.trim(); if (!t) return; c.msgs.push({ me: true, text: t }); c.preview = t; renderList(); renderBox(); };
  ed.addEventListener('input', () => { btn.style.display = ed.innerText.trim() ? 'block' : 'none'; });
  ed.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  btn.addEventListener('click', send);
}
renderList(); renderBox();
</script></body></html>`;
}

test('TikTok DOM (a): data-e2e düzeni — liste, sıra, okunmamış, mesajlar, video, gönderim', { skip: !HAS && 'Chromium yok' }, async () => {
  await withPage(
    (u) => (u.pathname === '/messages' ? { body: pageA() } : { status: 404, body: 'yok' }),
    async (page) => {
      const ts = await tiktok.threads(page, {});
      assert.deepEqual(ts.map((t) => t.name), ['Ayşe Yılmaz', 'Mert', 'Deniz']);
      assert.deepEqual(ts.map((t) => t.unread), [0, 2, 0]);
      assert.deepEqual(ts.map((t) => t.preview), ['Yarın görüşürüz', 'okkkk', '2'], 'okunmuş satırın önizlemesi "2" rozet sanılmaz');
      assert.ok(nonIncreasing(ts), 'liste sırası zamanla uyumlu');

      const mert = await tiktok.messages(page, {}, byName(ts, 'Mert').id, 25);
      assert.deepEqual(mert.map((m) => [m.text, m.fromMe]), [['Sayı tahmini?', false], ['okkkk', false]]);
      assert.equal(mert[0].senderName, 'Mert');

      const ayse = await tiktok.messages(page, {}, byName(ts, 'Ayşe Yılmaz').id, 25);
      assert.deepEqual(ayse.map((m) => [m.text, m.fromMe]), [['Merhaba, nasılsın?', false], ['İyiyim, sen?', true], ['Yarın görüşürüz', false]], '"Görüldü" metne girmez');

      const deniz = await tiktok.messages(page, {}, byName(ts, 'Deniz').id, 25);
      assert.equal(deniz.length, 2);
      assert.equal(deniz[0].attachments?.[0]?.name, 'TikTok videosu');
      assert.equal(deniz[0].attachments?.[0]?.url, IMG('cover2'));
      assert.deepEqual([deniz[1].text, deniz[1].fromMe], ['2', true]);

      await tiktok.send(page, {}, byName(ts, 'Mert').id, 'Test mesajı ✓');
      const after = await tiktok.messages(page, {}, byName(ts, 'Mert').id, 25);
      assert.deepEqual([after.at(-1)?.text, after.at(-1)?.fromMe], ['Test mesajı ✓', true]);
      assert.equal(after.length, 3);
    },
  );
});

// ---------------------------------------------------------------- (b) data-e2e yok, hash'li sınıflar, sol menü, açık grup sohbeti
interface BMsg {
  sep?: string;
  me?: boolean;
  from?: string;
  text: string;
}
const B_CHATS: Array<{ name: string; group?: boolean; time: string; preview: string; unread: number; msgs: BMsg[] }> = [
  {
    name: 'Kod Ekibi',
    group: true,
    time: '14:50',
    preview: 'Zeynep: tamam',
    unread: 0,
    msgs: [
      { sep: 'Bugün 13:00', text: '' },
      { from: 'Mert', text: 'toplantı 3te' },
      { from: 'Zeynep', text: 'tamam' },
      { from: 'Ali', text: 'ben de geliyorum' },
      { from: 'Mert', text: 'sunum hazır mı?' },
      { from: 'Zeynep', text: 'neredeyse' },
      { from: 'Ali', text: 'bekliyoruz' },
      { from: 'Mert', text: 'süper' },
      { me: true, text: 'geliyorum' },
    ],
  },
  { name: 'Ayşe', time: '14:32', preview: 'Akşam görüşelim mi?', unread: 3, msgs: [{ sep: 'Bugün 14:30', text: '' }, { text: 'Selam!' }, { me: true, text: 'Selam, naber?' }, { text: 'Akşam görüşelim mi?' }] },
  { name: 'Burak', time: 'Dün', preview: 'Tamamdır', unread: 0, msgs: [{ sep: 'Dün 20:00', text: '' }, { me: true, text: 'Dosyayı attım' }, { text: 'Tamamdır' }] },
  { name: 'Canan', time: '2 g', preview: 'Teşekkürler', unread: 0, msgs: [{ sep: '27.09.2026 10:00', text: '' }, { text: 'Teşekkürler' }] },
];
const FOLLOWING = ['Selin Aksoy', 'Emre Demir', 'Gizem Koç', 'Hakan Şahin', 'Irmak Tunç', 'Kerem Aydın', 'Lale Öz', 'Mina Kurt'];

function pageB(nav = true): string {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Mesajlar | TikTok</title>
<style>
body{margin:0;font:14px/1.3 Arial,sans-serif}
.top{height:56px;border-bottom:1px solid #eee}
.wrap{display:flex;height:calc(100vh - 57px)}
.nav{width:240px;flex:none;border-right:1px solid #eee;overflow-y:auto;padding:8px}
.nav a{display:flex;align-items:center;gap:10px;height:48px;color:inherit;text-decoration:none;width:220px}
.nav img{width:32px;height:32px;border-radius:50%}
.nav p{margin:0}
.col{width:340px;flex:none;overflow-y:auto;border-right:1px solid #eee}
.r{display:flex;align-items:center;gap:12px;height:72px;padding:0 14px;cursor:pointer;position:relative}
.r img.one{width:48px;height:48px;border-radius:50%}
.ga{position:relative;width:48px;height:48px;flex:none}
.ga img{position:absolute;width:32px;height:32px;border-radius:50%}
.tx{flex:1;min-width:0}
.tx div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.side{display:flex;flex-direction:column;align-items:flex-end;gap:4px;font-size:12px;color:#888}
.cnt{background:#fe2c55;color:#fff;border-radius:9px;padding:0 6px}
.pane{flex:1;display:flex;flex-direction:column;min-width:0}
.ph{height:64px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid #eee}
.area{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:6px}
.t{text-align:center;color:#888;font-size:12px;margin:8px 0}
.in{display:flex;gap:8px;align-items:flex-end;max-width:60%}
.in img{width:32px;height:32px;border-radius:50%}
.nm{font-size:12px;color:#888;margin-bottom:2px}
.b{background:#f1f1f2;border-radius:8px;padding:8px 12px}
.out{display:flex;justify-content:flex-end}
.out .b{background:#fe2c55;color:#fff}
.ed{margin:12px 16px;border:1px solid #ddd;border-radius:8px;padding:10px;min-height:20px}
</style></head><body>
<div class="top css-q7-DivHeaderContainer"></div>
<div class="wrap css-a1-DivBodyContainer">
  ${
    nav
      ? `<div class="nav css-n1-DivSideNavContainer"><div class="css-nm-DivMainNav"><a href="/">Sana Özel</a><a href="/following">Takip</a></div>
    <p style="margin:12px 0 4px;color:#888">Takip edilen hesaplar</p>
    <div class="css-f1-DivUserContainer">${FOLLOWING.map((n, i) => `<a href="/@user${i}" class="css-u1-StyledLink"><img src="${IMG(`f${i}`)}"><div><p>${esc(n)}</p><p style="color:#888;font-size:12px">user${i}</p></div></a>`).join('')}</div>
  </div>`
      : '<div style="width:72px;flex:none;border-right:1px solid #eee"></div>'
  }
  <div class="col css-d1-DivListColumn"><div class="css-l1-DivConversationList" id="convs"></div></div>
  <div class="pane css-m1-DivChatPane" id="pane"></div>
</div>
<script>
const CHATS = ${JSON.stringify(B_CHATS)};
const IMG = (n) => 'https://p16-sign.tiktokcdn.com/' + n + '.jpeg';
let open = 0;
function rowClass(c, i) {
  // emotion: aynı bileşenin hash'i duruma göre değişir (okunmuş / okunmamış / seçili / grup)
  if (i === open) return 'css-9sel01-DivItemWrapper e1a2b3c0';
  if (c.group) return 'css-7grp22-DivItemWrapper e1a2b3c0';
  return (c.unread ? 'css-1rrx3i5' : 'css-1ojajeq') + '-DivItemWrapper e1a2b3c0';
}
function renderList() {
  const el = document.getElementById('convs');
  el.innerHTML = CHATS.map((c, i) => '<div class="r ' + rowClass(c, i) + '" style="' + (i === open ? 'background:#f1f1f2' : '') + '">'
    + (c.group ? '<div class="ga css-g1-DivGroupAvatar"><img src="' + IMG('g' + i + 'a') + '" style="left:0;top:0"><img src="' + IMG('g' + i + 'b') + '" style="right:0;bottom:0"></div>' : '<img class="one" src="' + IMG('b' + i) + '">')
    + '<div class="tx css-h0-DivMeta"><div class="css-h1-PTitle" style="font-weight:600">' + c.name + '</div><div class="css-h2-SpanSnippet" style="color:#888">' + c.preview + '</div></div>'
    + '<div class="side css-h9-DivSide"><span class="css-h3-SpanStamp">' + c.time + '</span>' + (c.unread ? '<span class="cnt css-u9-SpanCount">' + c.unread + '</span>' : '') + '</div></div>').join('');
  el.querySelectorAll('.r').forEach((row, i) => row.addEventListener('click', () => { open = i; CHATS[i].unread = 0; renderList(); renderPane(); }));
}
function renderPane() {
  const c = CHATS[open];
  const pane = document.getElementById('pane');
  const msgs = c.msgs.map((m, j) => m.sep ? '<div class="t css-t1-DivTime">' + m.sep + '</div>'
    : m.me ? '<div class="out css-r2-DivRow"><div class="b css-b2-DivBubble"><span>' + m.text + '</span></div></div>'
    : '<div class="in css-r1-DivRow"><img src="' + IMG((m.from || c.name) + j) + '"><div>' + (c.group ? '<div class="nm css-n2-SpanName">' + m.from + '</div>' : '') + '<div class="b css-b1-DivBubble"><span>' + m.text + '</span></div></div></div>').join('');
  pane.innerHTML = '<div class="ph css-p1-DivHead">' + (c.group ? '<div class="ga"><img src="' + IMG('g0a') + '" style="left:0;top:0;width:28px;height:28px"><img src="' + IMG('g0b') + '" style="right:0;bottom:0;width:28px;height:28px"></div>' : '<img src="' + IMG('b' + open) + '" style="width:40px;height:40px;border-radius:50%">')
    + '<div class="css-p2-SpanHeadName" style="font-weight:600">' + c.name + '</div></div>'
    + '<div class="area css-ma-DivMessageArea">' + msgs + '</div>'
    + '<div class="ed css-e1-DivEditor" contenteditable="true" role="textbox"></div>';
  const ed = pane.querySelector('[contenteditable]');
  ed.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const t = ed.innerText.trim(); if (!t) return; c.msgs.push({ me: true, text: t }); c.preview = t; renderList(); renderPane(); } });
}
renderList(); renderPane();
</script></body></html>`;
}

test('TikTok DOM (b): data-e2e yok — hash\'i değişen satırlar, grup kolajı, sol menü ve açık grubun mesajları sohbet sanılmaz', { skip: !HAS && 'Chromium yok' }, async () => {
  await withPage(
    (u) => (u.pathname === '/messages' ? { body: pageB() } : { status: 404, body: 'yok' }),
    async (page) => {
      const ts = await tiktok.threads(page, {});
      assert.deepEqual(ts.map((t) => t.name), ['Kod Ekibi', 'Ayşe', 'Burak', 'Canan'], 'yalnız sohbetler, sayfa sırasıyla (takip edilenler / grup mesajları değil)');
      assert.deepEqual(ts.map((t) => t.kind), ['group', 'direct', 'direct', 'direct']);
      assert.deepEqual(ts.map((t) => t.unread), [0, 3, 0, 0]);
      assert.deepEqual(ts.map((t) => t.preview), ['Zeynep: tamam', 'Akşam görüşelim mi?', 'Tamamdır', 'Teşekkürler']);
      assert.ok(nonIncreasing(ts), 'liste sırası zamanla uyumlu');

      const ayse = await tiktok.messages(page, {}, byName(ts, 'Ayşe').id, 25);
      assert.deepEqual(ayse.map((m) => [m.text, m.fromMe]), [['Selam!', false], ['Selam, naber?', true], ['Akşam görüşelim mi?', false]]);

      // liste açık sohbet değişince (seçili satırın hash'i değişti) aynı kalır
      const again = await tiktok.threads(page, {});
      assert.deepEqual(again.map((t) => t.name), ['Kod Ekibi', 'Ayşe', 'Burak', 'Canan']);

      const grp = await tiktok.messages(page, {}, byName(ts, 'Kod Ekibi').id, 25);
      assert.deepEqual(grp.map((m) => m.text), ['toplantı 3te', 'tamam', 'ben de geliyorum', 'sunum hazır mı?', 'neredeyse', 'bekliyoruz', 'süper', 'geliyorum']);
      assert.deepEqual(grp.map((m) => m.fromMe), [false, false, false, false, false, false, false, true]);
      assert.deepEqual(grp.slice(0, 3).map((m) => m.senderName), ['Mert', 'Zeynep', 'Ali'], 'grupta gönderen adı balonun üstündeki etiketten');
      assert.notEqual(grp[0].senderId, grp[1].senderId);

      const canan = await tiktok.messages(page, {}, byName(ts, 'Canan').id, 25);
      assert.deepEqual(canan.map((m) => [m.text, m.fromMe]), [['Teşekkürler', false]]);

      await tiktok.send(page, {}, byName(ts, 'Burak').id, 'Yarın ararım');
      const burak = await tiktok.messages(page, {}, byName(ts, 'Burak').id, 25);
      assert.deepEqual(burak.map((m) => [m.text, m.fromMe]), [['Dosyayı attım', true], ['Tamamdır', false], ['Yarın ararım', true]]);
    },
  );
});

test('TikTok DOM (b2): sol menü yokken açık grup sohbetinin üye mesajları sohbet listesi sanılmaz ("yalnız 3 grup mesajı")', { skip: !HAS && 'Chromium yok' }, async () => {
  await withPage(
    (u) => (u.pathname === '/messages' ? { body: pageB(false) } : { status: 404, body: 'yok' }),
    async (page) => {
      const ts = await tiktok.threads(page, {});
      assert.deepEqual(ts.map((t) => t.name), ['Kod Ekibi', 'Ayşe', 'Burak', 'Canan']);
      const burak = await tiktok.messages(page, {}, byName(ts, 'Burak').id, 25);
      assert.deepEqual(burak.map((m) => [m.text, m.fromMe]), [['Dosyayı attım', true], ['Tamamdır', false]]);
    },
  );
});

// ---------------------------------------------------------------- (c) Business Suite: yönlendirme + çerçeve + gün blokları
interface CMsg {
  me?: boolean;
  text: string;
  at: string;
}
const C_CHATS: Array<{ name: string; time: string; preview: string; unread: number; days: Array<{ sep: string; msgs: CMsg[] }> }> = [
  {
    name: 'Elif Şahin',
    time: hm(25),
    preview: 'Tamam, teşekkürler',
    unread: 1,
    days: [
      { sep: 'Dün 21:05', msgs: [{ text: 'Sipariş ne zaman gelir?', at: '21:05' }, { me: true, text: 'Yarın kargoda', at: '21:07' }] },
      {
        sep: `Bugün ${hm(0)}`,
        msgs: [
          { text: 'Günaydın', at: hm(0) },
          { text: 'Kargo kodu var mı?', at: hm(1) },
          { me: true, text: 'Evet: TR123', at: hm(15) },
          { me: true, text: 'Akşama elinde', at: hm(16) },
          { text: 'Tamam, teşekkürler', at: hm(25) },
        ],
      },
    ],
  },
  { name: 'Okan', time: 'Dün', preview: 'Fiyat nedir?', unread: 0, days: [{ sep: 'Dün 17:00', msgs: [{ text: 'Fiyat nedir?', at: '17:00' }] }] },
  { name: 'Pelin', time: '3 g', preview: 'Görüşürüz', unread: 0, days: [{ sep: '26.09.2026 12:00', msgs: [{ me: true, text: 'Görüşürüz', at: '12:00' }] }] },
];

function bizShell(): string {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Business Suite | TikTok</title>
<style>body{margin:0;font:14px Arial}.hd{height:56px;border-bottom:1px solid #eee}.sb{position:absolute;left:0;top:57px;width:220px;bottom:0;border-right:1px solid #eee}
.sb a{display:flex;align-items:center;gap:8px;height:44px;padding:0 12px;color:inherit;text-decoration:none}.sb img{width:28px;height:28px;border-radius:50%}
iframe{position:absolute;left:220px;top:57px;width:1220px;height:843px;border:0}</style></head><body>
<div class="hd"></div>
<div class="sb Sidebar__Nav-sc-1a2b3c"><a href="/business-suite/home"><img src="${IMG('me')}">Hesabım</a><a href="/business-suite/messages">Mesajlar</a><a href="/business-suite/comments">Yorumlar</a></div>
<iframe src="/messages?allow_label=true&lang=tr&scene=business"></iframe>
</body></html>`;
}

function bizInbox(): string {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>TikTok</title>
<style>
body{margin:0;font:14px/1.3 Arial,sans-serif}
.inbox{display:flex;height:100vh}
.lc{width:360px;flex:none;overflow-y:auto;border-right:1px solid #eee}
.req{display:flex;align-items:center;gap:12px;height:64px;padding:0 14px}
.req svg{width:40px;height:40px}
.row{display:flex;align-items:center;height:76px;padding:0 14px}
.row.sel{background:#eef}
.row-main{display:flex;align-items:center;gap:12px;flex:1;min-width:0;cursor:pointer}
.row img{width:44px;height:44px;border-radius:50%}
.meta{flex:1;min-width:0}
.meta .n{font-weight:600}
.meta .p{color:#888}
.rt{font-size:12px;color:#888;display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.dot{background:#fe2c55;color:#fff;border-radius:8px;padding:0 5px;font-size:11px}
.cc{flex:1;display:flex;flex-direction:column;min-width:0}
.chd{height:60px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid #eee}
.scroller{flex:1;overflow-y:auto;padding:12px 20px}
.day-sep{display:flex;justify-content:center;margin:10px 0}
.pill{background:#eee;border-radius:10px;padding:2px 10px;font-size:12px;color:#666}
.msg-row{display:flex;gap:8px;margin:4px 0;align-items:flex-end}
.msg-row img{width:36px;height:36px;border-radius:50%}
.grp{display:flex;flex-direction:column;align-items:flex-end;gap:4px;margin:4px 0}
.bubble{background:#f1f1f2;border-radius:12px;padding:8px 12px;max-width:420px}
.grp .bubble{background:#25f4ee}
.bubble .t{font-size:10px;color:#999;text-align:right}
.status{font-size:11px;color:#999}
.cmp{margin:10px 16px;border:1px solid #ddd;border-radius:18px;padding:10px 14px;min-height:20px}
</style></head><body>
<div class="inbox InboxLayout__Root-sc-7k2">
  <div class="lc ConversationList__Scroller-sc-3m1"><div class="rows ConversationList__Rows-sc-3m2" id="rows"></div></div>
  <div class="cc ChatColumn__Root-sc-9q1" id="cc"><div style="margin:auto;color:#999">Bir sohbet seç</div></div>
</div>
<script>
const CHATS = ${JSON.stringify(C_CHATS)};
const IMG = (n) => 'https://p16-sign.tiktokcdn.com/' + n + '.jpeg';
let open = -1;
function renderRows() {
  const el = document.getElementById('rows');
  el.innerHTML = '<div class="req css-rq1-DivRequestGroup"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#ddd"/></svg><div><div>Mesaj istekleri</div><div style="color:#888">3 yeni istek</div></div></div>'
    + CHATS.map((c, i) => '<div class="row ConversationRow__Wrapper-sc-4p' + (i === open ? '1 sel' : '0') + '"><div class="row-main">'
      + '<img src="' + IMG('c' + i) + '"><div class="meta"><div class="n">' + c.name + '</div><div class="p">' + c.preview + '</div></div>'
      + '<div class="rt"><span>' + c.time + '</span>' + (c.unread ? '<span class="dot">' + c.unread + '</span>' : '') + '</div></div></div>').join('');
  // tıklama işleyicisi YALNIZ iç öğede (dış satıra .click() bir şey yapmaz)
  el.querySelectorAll('.row-main').forEach((m, i) => m.addEventListener('click', () => { open = i; CHATS[i].unread = 0; renderRows(); renderChat(); }));
}
function renderChat() {
  const c = CHATS[open];
  const days = c.days.map((d) => {
    let html = '<div class="day-block"><div class="day-sep"><span class="pill">' + d.sep + '</span></div><div class="msgs">';
    let k = 0;
    while (k < d.msgs.length) {
      const m = d.msgs[k];
      if (m.me) {
        // ardışık kendi mesajlarım tek blokta, sonda tek "Görüldü"
        let g = '<div class="grp">';
        while (k < d.msgs.length && d.msgs[k].me) { g += '<div class="bubble"><span>' + d.msgs[k].text + '</span><div class="t">' + d.msgs[k].at + '</div></div>'; k++; }
        html += g + '<div class="status">Görüldü</div></div>';
      } else {
        html += '<div class="msg-row"><img src="' + IMG('c' + open) + '"><div class="bubble"><span>' + m.text + '</span><div class="t">' + m.at + '</div></div></div>';
        k++;
      }
    }
    return html + '</div></div>';
  }).join('');
  const cc = document.getElementById('cc');
  cc.innerHTML = '<div class="chd"><img src="' + IMG('c' + open) + '" style="width:36px;height:36px;border-radius:50%"><div><div style="font-weight:600">' + c.name + '</div></div></div>'
    + '<div class="scroller">' + days + '</div><div class="cmp" contenteditable="true" role="textbox" aria-label="Mesaj yaz"></div>';
  const ed = cc.querySelector('[contenteditable]');
  ed.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const t = ed.innerText.trim(); if (!t) return; c.days[c.days.length - 1].msgs.push({ me: true, text: t, at: '10:00' }); c.preview = t; renderRows(); renderChat(); } });
}
renderRows();
</script></body></html>`;
}

test('TikTok DOM (c): Business Suite — yönlendirme, gömülü çerçeve, gün blokları, <p>\'siz balonlar, "Görüldü", iç öğede tıklama', { skip: (!HAS && 'Chromium yok') || (EARLY && 'gece yarısından hemen sonra') }, async () => {
  await withPage(
    (u) => {
      if (u.pathname === '/messages' && u.searchParams.get('scene') === 'business') return { body: bizInbox() };
      // TikTok'un istemci tarafı yönlendirmesi gibi (kişisel hesap da Business Suite'e düşebiliyor)
      if (u.pathname === '/messages') return { body: `<!doctype html><meta charset="utf-8"><title>TikTok</title><script>location.replace('/business-suite/messages?from=dm')</script>` };
      if (u.pathname === '/business-suite/messages') return { body: bizShell() };
      return { status: 404, body: 'yok' };
    },
    async (page) => {
      const ts = await tiktok.threads(page, {});
      assert.match(page.url(), /business-suite\/messages/);
      assert.deepEqual(ts.map((t) => t.name), ['Elif Şahin', 'Okan', 'Pelin'], '"Mesaj istekleri" satırı sohbet değil');
      assert.deepEqual(ts.map((t) => t.unread), [1, 0, 0]);
      assert.ok(nonIncreasing(ts));

      const elif = await tiktok.messages(page, {}, byName(ts, 'Elif Şahin').id, 25);
      assert.deepEqual(
        elif.map((m) => [m.text, m.fromMe]),
        [
          ['Sipariş ne zaman gelir?', false],
          ['Yarın kargoda', true],
          ['Günaydın', false],
          ['Kargo kodu var mı?', false],
          ['Evet: TR123', true],
          ['Akşama elinde', true],
          ['Tamam, teşekkürler', false],
        ],
        'gün blokları açılır, saat ve "Görüldü" metne girmez',
      );
      assert.ok(elif.every((m, i) => i === 0 || m.ts > elif[i - 1].ts), 'mesaj sırası zamanla uyumlu');
      const today = new Date();
      assert.equal(new Date(elif[2].ts).getDate(), today.getDate(), 'bugünkü blok ayırıcının zamanını alır');

      const okan = await tiktok.messages(page, {}, byName(ts, 'Okan').id, 25);
      assert.deepEqual(okan.map((m) => [m.text, m.fromMe]), [['Fiyat nedir?', false]]);

      await tiktok.send(page, {}, byName(ts, 'Pelin').id, 'Merhaba Pelin');
      const pelin = await tiktok.messages(page, {}, byName(ts, 'Pelin').id, 25);
      assert.deepEqual(pelin.map((m) => [m.text, m.fromMe]), [['Görüşürüz', true], ['Merhaba Pelin', true]]);
    },
  );
});

// ---------------------------------------------------------------- (d) tek sohbetli liste
function pageD(): string {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Mesajlar | TikTok</title>
<style>body{margin:0;font:14px Arial}.w{display:flex;height:100vh}.l{width:330px;border-right:1px solid #eee;overflow-y:auto}
.it{display:flex;align-items:center;gap:12px;height:70px;padding:0 12px;cursor:pointer}.it img{width:46px;height:46px;border-radius:50%}
.c{flex:1;display:flex;flex-direction:column}.a{flex:1;overflow-y:auto;padding:16px}.m{margin:6px 0;display:flex;gap:8px;align-items:center}
.m img{width:30px;height:30px;border-radius:50%}.m div{background:#f1f1f2;border-radius:10px;padding:8px 12px}.m.o{justify-content:flex-end}.m.o div{background:#fe2c55;color:#fff}
.e{margin:12px;border:1px solid #ddd;border-radius:8px;padding:10px}</style></head><body>
<div class="w"><div class="l css-z1-DivList"><div class="it css-z2-DivItem"><img src="${IMG('solo')}"><div style="flex:1"><div>Tek Kişi</div><div style="color:#888">Nasılsın?</div></div><span style="font-size:12px;color:#888">11:05</span></div></div>
<div class="c" id="c"><div style="margin:auto;color:#999">Bir sohbet seç</div></div></div>
<script>
const msgs = [{ o: 0, t: 'Nasılsın?' }];
function render() {
  const c = document.getElementById('c');
  c.innerHTML = '<div style="height:56px;border-bottom:1px solid #eee;display:flex;align-items:center;padding:0 12px">Tek Kişi</div><div class="a">'
    + msgs.map((m) => '<div class="m' + (m.o ? ' o' : '') + '">' + (m.o ? '' : '<img src="https://p16-sign.tiktokcdn.com/solo.jpeg">') + '<div>' + m.t + '</div></div>').join('')
    + '</div><div class="e" contenteditable="true"></div>';
  const ed = c.querySelector('[contenteditable]');
  ed.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); msgs.push({ o: 1, t: ed.innerText.trim() }); render(); } });
}
document.querySelector('.it').addEventListener('click', render);
</script></body></html>`;
}

test('TikTok DOM (d): tek sohbetli liste', { skip: !HAS && 'Chromium yok' }, async () => {
  await withPage(
    (u) => (u.pathname === '/messages' ? { body: pageD() } : { status: 404, body: 'yok' }),
    async (page) => {
      const ts = await tiktok.threads(page, {});
      assert.deepEqual(ts.map((t) => [t.name, t.preview, t.kind]), [['Tek Kişi', 'Nasılsın?', 'direct']]);
      const ms = await tiktok.messages(page, {}, ts[0].id, 25);
      assert.deepEqual(ms.map((m) => [m.text, m.fromMe]), [['Nasılsın?', false]]);
      await tiktok.send(page, {}, ts[0].id, 'İyiyim');
      const after = await tiktok.messages(page, {}, ts[0].id, 25);
      assert.deepEqual(after.map((m) => [m.text, m.fromMe]), [['Nasılsın?', false], ['İyiyim', true]]);
    },
  );
});

// ---------------------------------------------------------------- (e) sanal (yalnız görünen satırları çizen) uzun liste
function pageE(): string {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Mesajlar | TikTok</title>
<style>body{margin:0;font:14px Arial}.w{display:flex;height:100vh}.l{width:330px;border-right:1px solid #eee;overflow-y:auto;position:relative}
.sp{position:relative}.it{position:absolute;left:0;right:0;display:flex;align-items:center;gap:12px;height:72px;padding:0 12px;cursor:pointer;box-sizing:border-box}
.it img{width:46px;height:46px;border-radius:50%}.c{flex:1;display:flex;flex-direction:column}.a{flex:1;overflow-y:auto;padding:16px}
.m{margin:6px 0;display:flex;gap:8px;align-items:center}.m img{width:30px;height:30px;border-radius:50%}.m div{background:#f1f1f2;border-radius:10px;padding:8px 12px}
.e{margin:12px;border:1px solid #ddd;border-radius:8px;padding:10px}</style></head><body>
<div class="w"><div class="l" id="l"><div class="sp" id="sp"></div></div><div class="c" id="c"><div style="margin:auto;color:#999">Bir sohbet seç</div></div></div>
<script>
const N = 60, RH = 72;
const name = (i) => 'Kişi ' + i;
const l = document.getElementById('l'), sp = document.getElementById('sp');
sp.style.height = N * RH + 'px';
function draw() {
  const a = Math.max(0, Math.floor(l.scrollTop / RH) - 2), b = Math.min(N, Math.ceil((l.scrollTop + l.clientHeight) / RH) + 2);
  let h = '';
  for (let i = a; i < b; i++) h += '<div class="it" data-i="' + i + '" style="top:' + i * RH + 'px"><img src="https://p16-sign.tiktokcdn.com/k' + i + '.jpeg"><div style="flex:1"><div>' + name(i) + '</div><div style="color:#888">mesaj ' + i + '</div></div><span style="font-size:12px;color:#888">' + (i + 1) + ' g</span></div>';
  sp.innerHTML = h;
  sp.querySelectorAll('.it').forEach((r) => r.addEventListener('click', () => openChat(Number(r.dataset.i))));
}
function openChat(i) {
  document.getElementById('c').innerHTML = '<div style="height:56px;border-bottom:1px solid #eee;display:flex;align-items:center;padding:0 12px">' + name(i) + '</div><div class="a"><div class="m"><img src="https://p16-sign.tiktokcdn.com/k' + i + '.jpeg"><div>mesaj ' + i + '</div></div></div><div class="e" contenteditable="true"></div>';
}
l.addEventListener('scroll', draw);
draw();
</script></body></html>`;
}

test('TikTok DOM (e): sanal uzun liste — aşağıdaki sohbet ekran ekran inilerek bulunur, sonra liste başa döner; daha eski sohbetler', { skip: !HAS && 'Chromium yok' }, async () => {
  await withPage(
    (u) => (u.pathname === '/messages' ? { body: pageE() } : { status: 404, body: 'yok' }),
    async (page) => {
      const ts = await tiktok.threads(page, {});
      assert.equal(ts[0].name, 'Kişi 0');
      assert.ok(ts.length >= 10 && ts.length < 30, `yalnız çizilen satırlar: ${ts.length}`);
      assert.ok(nonIncreasing(ts));
      const far = rowIds([{ name: 'Kişi 45' }])[0];
      const ms = await tiktok.messages(page, {}, far, 25);
      assert.deepEqual(ms.map((m) => [m.text, m.fromMe]), [['mesaj 45', false]]);
      const again = await tiktok.threads(page, {});
      assert.equal(again[0].name, 'Kişi 0', 'sonraki turda liste yine baştan okunur');
      const more = await tiktok.moreThreads!(page, {}, 1);
      assert.ok(more.length > 0 && !more.some((t) => ts.some((x) => x.id === t.id)), 'daha eski sohbetler yalnız yeni satırlar');
      assert.ok(Math.max(...more.map((t) => t.lastTs)) < Math.min(...ts.map((t) => t.lastTs)), 'eski sayfa üst sayfanın altında');
    },
  );
});

// ---------------------------------------------------------------- (f) genel sahte sayfa: kırıcı/inceleme bulgularının regresyonları
interface FMsg {
  sep?: string;
  me?: boolean;
  text?: string;
  from?: string;
  /** grup düzeni: ad bir kez, altında aynı gönderenin balonları (ad satırların KARDEŞİ) */
  block?: string[];
  /** arka plansız büyük emoji */
  emoji?: boolean;
}
interface FChat {
  name: string;
  time: string;
  preview: string;
  unread: number;
  group?: boolean;
  msgs: FMsg[];
}
interface FOpts {
  chats: FChat[];
  open?: number;
  lang?: string;
  css?: string;
  railHtml?: string;
  navW?: number;
  list?: { virtual?: boolean; recycle?: boolean; requestsRow?: boolean; badgeInner?: boolean };
}
function pageF(o: FOpts): string {
  return `<!doctype html><html lang="${o.lang || 'tr'}"><head><meta charset="utf-8"><title>Mesajlar | TikTok</title><style>
body{margin:0;font:14px/1.3 Arial,sans-serif}
.top{height:56px;border-bottom:1px solid #eee}
.wrap{display:flex;height:calc(100vh - 57px)}
.rail{width:${o.navW || 72}px;flex:none;border-right:1px solid #eee}
.col{width:340px;flex:none;overflow-y:auto;border-right:1px solid #eee;position:relative}
.r{display:flex;align-items:center;gap:12px;height:72px;padding:0 14px;cursor:pointer;box-sizing:border-box;width:100%}
.av{width:48px;height:48px;border-radius:50%;flex:none}
.avc{width:48px;height:48px;border-radius:50%;flex:none}
.tx{flex:1;min-width:0}.tx div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.side{display:flex;flex-direction:column;align-items:flex-end;gap:4px;font-size:12px;color:#888}
.cnt{background:#fe2c55;color:#fff;border-radius:9px;padding:0 6px;min-width:10px;text-align:center}
.pane{flex:1;display:flex;flex-direction:column;min-width:0}
.ph{height:64px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid #eee}
.area{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:6px}
.t{text-align:center;color:#888;font-size:12px;margin:8px 0}
.in{display:flex;gap:8px;align-items:flex-end;max-width:60%}
.in img.a{width:32px;height:32px;border-radius:50%}
.nm{font-size:12px;color:#888;margin-bottom:2px}
.b{background:#f1f1f2;border-radius:8px;padding:8px 12px}
.out{display:flex;justify-content:flex-end}
.out .b{background:#fe2c55;color:#fff}
.emo{font-size:40px;line-height:48px}
.ed{margin:12px 16px;border:1px solid #ddd;border-radius:8px;padding:10px;min-height:20px}
.grp{display:flex;flex-direction:column;gap:4px;align-items:flex-start}
${o.css || ''}
</style></head><body>
<div class="top css-q7x-DivHeaderContainer"></div>
<div class="wrap css-a1x-DivBodyContainer">
<div class="rail css-n1x">${o.railHtml || ''}</div>
<div class="col css-d1x" id="col"><div id="convs" class="css-l1x"></div></div>
<div class="pane css-m1x" id="pane"></div></div>
<script>
const O = ${JSON.stringify(o)};
const CHATS = O.chats;
const IMG = (n) => 'https://p16-sign.tiktokcdn.com/' + encodeURIComponent(n) + '.jpeg';
let open = O.open ?? 0;
const L = O.list || {};
function rowHtml(c, i) {
  const av = c.group ? '<div style="position:relative;width:48px;height:48px;flex:none"><img src="'+IMG('g'+i+'a')+'" style="position:absolute;left:0;top:0;width:32px;height:32px;border-radius:50%"><img src="'+IMG('g'+i+'b')+'" style="position:absolute;right:0;bottom:0;width:32px;height:32px;border-radius:50%"></div>'
    : '<img class="av" src="'+IMG('av'+i)+'">';
  const badge = c.unread ? (L.badgeInner ? '<div class="cnt css-bb1"><span>'+c.unread+'</span></div>' : '<span class="cnt css-bb2">'+c.unread+'</span>') : '';
  return '<div class="r css-'+(i===open?'sel':c.unread?'unr':'rd')+i%3+'-x" data-i="'+i+'" style="'+(i===open?'background:#f1f1f2;':'')+(L.virtual?'position:absolute;left:0;top:'+(i*72)+'px;':'')+'">' + av
   + '<div class="tx css-tx1"><div style="font-weight:600">'+c.name+'</div><div style="color:#888">'+c.preview+'</div></div>'
   + '<div class="side css-sd1"><span>'+c.time+'</span>'+badge+'</div></div>';
}
function renderList() {
  const el = document.getElementById('convs');
  let html = '';
  if (L.requestsRow) html += '<div class="r css-rq1" data-req="1"><div class="avc" style="background:#eee"><svg width="24" height="24"><circle cx="12" cy="12" r="10"/></svg></div><div class="tx"><div style="font-weight:600">Mesaj istekleri</div><div style="color:#888">Ahmet: selam</div></div><div class="side"><span>2</span></div></div>';
  if (L.virtual) {
    const col = document.getElementById('col');
    const st = col.scrollTop, h = col.clientHeight;
    const first = Math.max(0, Math.floor(st / 72) - 2), last = Math.min(CHATS.length, Math.ceil((st + h) / 72) + 2);
    let idx = []; for (let i = first; i < last; i++) idx.push(i);
    // yeniden kullanılan düğümler: DOM sırası görsel sıra değil
    if (L.recycle) idx = idx.map((_x, k) => idx[(k * 7 + 3) % idx.length]).filter((v, k, a) => a.indexOf(v) === k).concat(idx).filter((v, k, a) => a.indexOf(v) === k);
    el.style.cssText = 'position:relative;height:' + (CHATS.length * 72) + 'px';
    html += idx.map((i) => rowHtml(CHATS[i], i)).join('');
  } else html += CHATS.map(rowHtml).join('');
  el.innerHTML = html;
  el.querySelectorAll('.r[data-i]').forEach((row) => row.querySelector('.tx').addEventListener('click', () => { const i = +row.dataset.i; open = i; CHATS[i].unread = 0; renderList(); renderPane(); }));
  el.querySelectorAll('[data-req]').forEach((row) => row.addEventListener('click', () => { window.__reqOpened = (window.__reqOpened || 0) + 1; }));
}
if (L.virtual) document.getElementById('col').addEventListener('scroll', renderList);
function msgHtml(m, j, c) {
  if (m.sep) return '<div class="t css-t1x">' + m.sep + '</div>';
  if (m.block) return '<div class="grp css-gb1">' + (m.from ? '<div class="nm">' + m.from + '</div>' : '') + m.block.map((x) => '<div class="in"><img class="a" src="'+IMG(m.from)+'"><div class="b"><span>'+x+'</span></div></div>').join('') + '</div>';
  const inner = m.emoji ? '<div class="emo">'+m.text+'</div>' : '<div class="b"><span>' + m.text + '</span></div>';
  if (m.me) return '<div class="out css-r2x">' + inner + '</div>';
  return '<div class="in css-r1x"><img class="a" src="' + IMG(m.from || c.name) + '"><div>' + (m.from ? '<div class="nm">' + m.from + '</div>' : '') + inner + '</div></div>';
}
function renderPane() {
  const c = CHATS[open];
  const pane = document.getElementById('pane');
  pane.innerHTML = '<div class="ph"><img src="'+IMG('av'+open)+'" style="width:40px;height:40px;border-radius:50%"><div style="font-weight:600">' + c.name + '</div></div>'
   + '<div class="area css-ma1">' + c.msgs.map((m, j) => msgHtml(m, j, c)).join('') + '</div>'
   + '<div class="ed" contenteditable="true" role="textbox"></div>';
  const ed = pane.querySelector('[contenteditable]');
  ed.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const t = ed.innerText.trim(); if (!t) return; const m = { me: true, text: t }; if (O.css && O.css.includes('column-reverse')) c.msgs.unshift(m); else c.msgs.push(m); c.preview = t; renderList(); renderPane(); } });
}
renderList(); renderPane();
</script></body></html>`;
}
const serveF = (o: FOpts) => (u: URL): Reply => (u.pathname === '/messages' || u.pathname === '/business-suite/messages' ? { body: pageF(o) } : { status: 404, body: 'yok' });
const pairs = (ms: Array<{ text: string; fromMe: boolean }>) => ms.map((m) => [m.text, m.fromMe]);

test('TikTok DOM (f1): aynı adlı iki sohbet — okuma ve GÖNDERİM doğru kişiye (ad eşitliği "zaten açık" sayılmaz)', { skip: !HAS && 'Chromium yok' }, async () => {
  const o: FOpts = {
    open: 0,
    chats: [
      { name: 'Ali', time: '14:32', preview: 'birinci ali', unread: 0, msgs: [{ sep: 'Bugün 14:30' }, { text: 'birinci ali' }] },
      { name: 'Ali', time: '13:00', preview: 'ikinci ali', unread: 0, msgs: [{ sep: 'Bugün 13:00' }, { text: 'ikinci ali' }] },
    ],
  };
  await withPage(serveF(o), async (page) => {
    const ts = await tiktok.threads(page, {});
    assert.equal(ts.length, 2);
    assert.notEqual(ts[0].id, ts[1].id);
    assert.deepEqual(pairs(await tiktok.messages(page, {}, ts[1].id, 25)), [['ikinci ali', false]], 'birinci Ali açıkken ikinci Ali okunur');
    assert.deepEqual(pairs(await tiktok.messages(page, {}, ts[0].id, 25)), [['birinci ali', false]]);
    await tiktok.send(page, {}, ts[1].id, 'Ali2ye gidecek');
    const last = await page.evaluate('CHATS.map((c) => c.msgs[c.msgs.length - 1].text)');
    assert.deepEqual(last, ['birinci ali', 'Ali2ye gidecek'], 'mesaj ikinci Ali\'ye gitti');
  });
});

test('TikTok DOM (f2): column-reverse mesaj alanı — en yeni blok kaybolmaz, sıra ve zamanlar doğru', { skip: (!HAS && 'Chromium yok') || (EARLY && 'gece yarısından hemen sonra') }, async () => {
  const msgs: FMsg[] = [{ sep: 'Dün 10:00' }, { text: 'eski1' }, { me: true, text: 'eski2' }, { sep: `Bugün ${hm(0)}` }, { text: 'yeni1' }, { me: true, text: 'yeni2' }];
  const o: FOpts = { css: '.area{flex-direction:column-reverse}', chats: [{ name: 'Ayşe', time: hm(0), preview: 'yeni2', unread: 0, msgs: msgs.slice().reverse() }, { name: 'Bora', time: 'Dün', preview: 'y', unread: 0, msgs: [{ text: 'y' }, { sep: 'Dün 10:00' }] }] };
  await withPage(serveF(o), async (page) => {
    const ts = await tiktok.threads(page, {});
    const ms = await tiktok.messages(page, {}, byName(ts, 'Ayşe').id, 25);
    assert.deepEqual(pairs(ms), [['eski1', false], ['eski2', true], ['yeni1', false], ['yeni2', true]]);
    const now = new Date();
    assert.equal(new Date(ms[0].ts).getDate(), new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getDate(), 'eski blok dünün');
    assert.equal(new Date(ms[2].ts).getHours(), Number(hm(0).slice(0, 2)));
    assert.ok(ms.every((m, i) => !i || m.ts > ms[i - 1].ts));
    assert.deepEqual(pairs(await tiktok.messages(page, {}, byName(ts, 'Bora').id, 25)), [['y', false]]);
  });
});

test('TikTok DOM (f3): grup — ad bir kez balon bloğunun üstünde; emoji-only balonsuz mesaj; ABD tarihli ayırıcı; "Mesaj istekleri"; iç içe rozet', { skip: !HAS && 'Chromium yok' }, async () => {
  const o: FOpts = {
    lang: 'en',
    list: { requestsRow: true, badgeInner: true },
    chats: [
      { name: 'Ayşe', time: '2:32 PM', preview: 'Akşam?', unread: 3, msgs: [{ sep: 'Today 2:30 PM' }, { text: 'Selam!' }, { me: true, text: 'Naber' }, { emoji: true, text: '😂😂' }, { text: 'Akşam?' }] },
      { name: 'Kod Ekibi', group: true, time: 'Yesterday', preview: 'Zeynep: z2', unread: 0, msgs: [{ sep: 'Yesterday 9:00 AM' }, { from: 'Mert', block: ['a1 mert', 'a2 mert'] }, { from: 'Zeynep', block: ['z1', 'z2'] }, { me: true, text: 'ben' }] },
      { name: 'Deniz', time: '9/20/2026', preview: 'yeni', unread: 0, msgs: [{ sep: '9/12/2026 3:05 PM' }, { text: 'eski' }, { sep: '9/20/2026 1:00 PM' }, { text: 'yeni' }] },
    ],
  };
  await withPage(serveF(o), async (page) => {
    const ts = await tiktok.threads(page, {});
    assert.deepEqual(ts.map((t) => t.name), ['Ayşe', 'Kod Ekibi', 'Deniz'], '"Mesaj istekleri" sohbet değil');
    assert.deepEqual(ts.map((t) => t.unread), [3, 0, 0], 'renk sarmalayıcıda olan rozet');
    const ayse = await tiktok.messages(page, {}, byName(ts, 'Ayşe').id, 25);
    assert.deepEqual(pairs(ayse), [['Selam!', false], ['Naber', true], ['😂😂', false], ['Akşam?', false]], 'balonsuz emoji mesajı');
    const grp = await tiktok.messages(page, {}, byName(ts, 'Kod Ekibi').id, 25);
    assert.deepEqual(grp.map((m) => [m.text, m.senderName]), [['a1 mert', 'Mert'], ['a2 mert', 'Mert'], ['z1', 'Zeynep'], ['z2', 'Zeynep'], ['ben', 'Ben']]);
    assert.notEqual(grp[0].senderId, grp[2].senderId);
    const deniz = await tiktok.messages(page, {}, byName(ts, 'Deniz').id, 25);
    assert.deepEqual(pairs(deniz), [['eski', false], ['yeni', false]], 'ABD tarihli ayırıcılar okunur, mesaj atılmaz');
    assert.equal(new Date(deniz[0].ts).getMonth(), 8);
    assert.equal(new Date(deniz[0].ts).getDate(), 12);
    assert.equal(new Date(deniz[0].ts).getHours(), 15);
    assert.equal(await page.evaluate(() => (window as unknown as { __reqOpened?: number }).__reqOpened ?? 0), 0, 'istekler girişine hiç tıklanmadı');
  });
});

test('TikTok DOM (f4): Business Suite — düğme menüsü (svg simgeli, rozetli) tek sohbetli listeyi ezmez', { skip: !HAS && 'Chromium yok' }, async () => {
  const NAV = ['Ana sayfa', 'Gönderiler', 'Yorumlar', 'Mesajlar', 'Analiz', 'Reklamlar', 'Ayarlar', 'Yardım'];
  const railHtml =
    '<div style="padding:8px">' +
    NAV.map(
      (n, i) =>
        `<div role="button" class="css-nv${i}" style="display:flex;align-items:center;gap:10px;height:44px;width:220px;cursor:pointer;border-radius:8px${i === 3 ? ';background:#eee' : ''}"><svg width="20" height="20"><rect width="20" height="20" rx="4"/></svg><span>${n}</span>${i === 3 ? '<span style="background:#fe2c55;color:#fff;border-radius:9px;padding:0 6px;margin-left:auto">3</span>' : ''}</div>`,
    ).join('') +
    '</div>';
  const o: FOpts = { navW: 240, railHtml, chats: [{ name: 'Ayşe', time: '14:32', preview: 'Naber', unread: 1, msgs: [{ sep: 'Bugün 14:30' }, { text: 'Selam!' }, { me: true, text: 'Naber' }] }] };
  await withPage(serveF(o), async (page) => {
    await page.goto('https://www.tiktok.com/business-suite/messages');
    const ts = await tiktok.threads(page, {});
    assert.deepEqual(ts.map((t) => t.name), ['Ayşe']);
    assert.deepEqual(pairs(await tiktok.messages(page, {}, ts[0].id, 25)), [['Selam!', false], ['Naber', true]]);
  });
});

test('TikTok DOM (f5): sanal liste, yeniden kullanılan düğümler DOM\'da karışık — sıra görsel sıra; daha eski sohbetler sıralı', { skip: !HAS && 'Chromium yok' }, async () => {
  const chats: FChat[] = Array.from({ length: 40 }, (_x, i) => ({ name: `Kişi ${String(i).padStart(2, '0')}`, time: `${i + 1} g`, preview: `önizleme ${i}`, unread: 0, msgs: [{ sep: 'Dün 10:00' }, { text: `mesaj ${i}` }] }));
  await withPage(serveF({ chats, list: { virtual: true, recycle: true } }), async (page) => {
    const ts = await tiktok.threads(page, {});
    assert.deepEqual(ts.map((t) => t.name), ts.map((t) => t.name).slice().sort());
    assert.equal(ts[0].name, 'Kişi 00');
    assert.ok(nonIncreasing(ts));
    const more = await tiktok.moreThreads!(page, {}, 1);
    assert.ok(more.length > 0);
    assert.deepEqual(more.map((t) => t.name), more.map((t) => t.name).slice().sort());
    assert.equal(Number(more[0].name.slice(5)), Number(ts.at(-1)!.name.slice(5)) + 1, 'daha eski sayfa kaldığı yerden');
    assert.ok(nonIncreasing(more));
  });
});

test('TikTok DOM (c2): Business Suite çerçevesindeki liste değişince DOM izleyicisi olay verir (izleyici çerçevede de çalışır)', { skip: !HAS && 'Chromium yok' }, async () => {
  await withPage(
    (u) => {
      if (u.pathname === '/messages' && u.searchParams.get('scene') === 'business') return { body: bizInbox() };
      if (u.pathname === '/messages') return { body: `<!doctype html><meta charset="utf-8"><title>TikTok</title><script>location.replace('/business-suite/messages?from=dm')</script>` };
      if (u.pathname === '/business-suite/messages') return { body: bizShell() };
      return { status: 404, body: 'yok' };
    },
    async (page) => {
      const events: string[] = [];
      await watchDom(page, tiktok.watchSelector!, (k) => events.push(k));
      const ts = await tiktok.threads(page, {});
      assert.equal(ts.length, 3);
      const frame = page.frames().find((f) => f !== page.mainFrame())!;
      await page.waitForTimeout(2500);
      events.length = 0;
      // React gibi yerinde güncelle (düğüm yeniden oluşturulmaz)
      await frame.evaluate(() => {
        const p = document.querySelectorAll('.row .meta .p')[1] as HTMLElement;
        p.textContent = 'Yeni mesaj geldi';
      });
      await page.waitForTimeout(4500);
      assert.ok(events.includes('event'), `olay yok: ${events.join(',')}`);
    },
  );
});
