import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ePttAVM (SOAP, WS-Security): yalnız siparişler. Yanıt biçimi WSDL'den üretilmiş istemcideki TedarikciSiparisKontrolV2 şemasına göre.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kavsak-ptt-'));
process.env.KAVSAK_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { PttAvmConnector, parsePttConfig, pttStatus } = await import('../src/connectors/pttavm.js');

const ORDER = (no: string, durum: string, kargo = '') => `<a:TedarikciSiparisKontrolV2>
  <a:Eposta>alici@example.com</a:Eposta><a:IslemTarihi>2026-09-27T14:05:00</a:IslemTarihi><a:KargoBarkod>${kargo}</a:KargoBarkod>
  <a:MusteriAdi>Ayşe</a:MusteriAdi><a:MusteriSoyadi>Yılmaz</a:MusteriSoyadi><a:SiparisAdresi>Bağdat Cad. No:1 &amp; D:2</a:SiparisAdresi>
  <a:SiparisIlce>Kadıköy</a:SiparisIlce><a:SiparisIli>İstanbul</a:SiparisIli><a:SiparisNo>${no}</a:SiparisNo><a:TelefonNo>5551112233</a:TelefonNo>
  <a:SiparisUrunler><a:SiparisUrun><a:KdvDahilToplamTutar>249,90</a:KdvDahilToplamTutar><a:LineItemId>9001</a:LineItemId>
  <a:SiparisDurumu>${durum}</a:SiparisDurumu><a:SiparisNotu>Hediye paketi</a:SiparisNotu><a:ToplamIslemAdedi>2</a:ToplamIslemAdedi>
  <a:Urun>Seramik Kupa</a:Urun><a:UrunBarkod>868000111</a:UrunBarkod></a:SiparisUrun></a:SiparisUrunler>
</a:TedarikciSiparisKontrolV2>`;
const RESP = (orders: string) =>
  `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><SiparisKontrolListesiV2Response xmlns="http://tempuri.org/"><SiparisKontrolListesiV2Result xmlns:a="http://schemas.datacontract.org/2004/07/ePttAVMService">${orders}</SiparisKontrolListesiV2Result></SiparisKontrolListesiV2Response></s:Body></s:Envelope>`;

function fake(handler: (body: string) => { status?: number; text: string }) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = String(init.body ?? '');
    calls.push({ url: String(input), headers: init.headers as Record<string, string>, body });
    const r = handler(body);
    return new Response(r.text, { status: r.status ?? 200, headers: { 'content-type': 'text/xml' } });
  }) as typeof fetch;
  return calls;
}

let n = 0;
function setup(cfg = JSON.stringify({ username: 'magaza<1>', password: 's&fre' })) {
  const store = new Store(path.join(tmp, `p${++n}.db`));
  const account = { id: `pttavm:t${n}`, platform: 'pttavm' as const, label: 'ePttAVM', status: 'disconnected' as const, createdAt: Date.now() };
  store.upsertAccount(account);
  return { store, account, c: new PttAvmConnector(account, store, cfg) };
}

test('pttStatus: Türkçe durum metinleri ortak koda', () => {
  assert.equal(pttStatus('Kargoya Verildi').code, 'Shipped');
  assert.equal(pttStatus('Teslim Edildi').code, 'Delivered');
  assert.equal(pttStatus('İptal Edildi').code, 'Cancelled');
  assert.equal(pttStatus('İade Talebi').code, 'Returned');
  assert.equal(pttStatus('Onay Bekliyor').code, 'Created');
  assert.equal(parsePttConfig('{"username":"a"}'), undefined);
});

test('ilk yoklama: WS-Security zarfı, sipariş sohbeti + yeni sipariş mesajı; durum değişince olay mesajı', async () => {
  let durum = 'Onay Bekliyor';
  const calls = fake(() => ({ text: RESP(ORDER('PTT-1001', durum)) }));
  const { c, store, account } = setup();
  await c.start();
  assert.equal(account.status, 'connected', account.detail);
  assert.equal(account.label, 'ePttAVM · magaza<1>');
  const first = calls[0];
  assert.equal(first.url, 'https://ws.pttavm.com:93/service.svc');
  assert.equal(first.headers.soapaction, '"http://tempuri.org/IService/SiparisKontrolListesiV2"');
  assert.match(first.body, /<wsse:Username>magaza&lt;1&gt;<\/wsse:Username>/);
  assert.match(first.body, /<wsse:Password>s&amp;fre<\/wsse:Password>/);
  assert.match(first.body, /<tem:AktifSiparisler>0<\/tem:AktifSiparisler>/);
  assert.equal(calls.length, 4, 'ilk eşitleme 4 haftalık dilim');

  const chat = store.getChat(`${account.id}/order-PTT-1001`)!;
  assert.equal(chat.name, '#PTT-1001 · Ayşe Yılmaz');
  const order = chat.meta!.order as { status: string; totals: { total: number }; shipping: { address: string }; items: Array<{ quantity: number; title: string }>; note?: string };
  assert.equal(order.status, 'Created');
  assert.equal(order.totals.total, 249.9);
  assert.equal(order.items[0].quantity, 2);
  assert.equal(order.shipping.address, 'Bağdat Cad. No:1 & D:2, Kadıköy, İstanbul');
  assert.equal(order.note, 'Hediye paketi');
  const msgs = store.listMessages(chat.id);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /Yeni sipariş #PTT-1001/);

  durum = 'Kargoya Verildi';
  await (c as unknown as { poll(first: boolean): Promise<void> }).poll(false);
  const after2 = store.listMessages(chat.id);
  assert.equal(after2.length, 2);
  assert.match(after2[1].text, /Kargoya Verildi/);
  assert.equal((store.getChat(chat.id)!.meta!.order as { status: string }).status, 'Shipped');
  await c.stop();
});

test('kimlik reddi: SOAP fault → hata durumu, anlaşılır ileti', async () => {
  fake(() => ({ status: 500, text: '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>Kullanıcı adı veya şifre hatalı</faultstring></s:Fault></s:Body></s:Envelope>' }));
  const { c, account } = setup();
  await c.start();
  assert.equal(account.status, 'error');
  assert.match(account.detail ?? '', /kimlik bilgileri reddedildi/);
});
