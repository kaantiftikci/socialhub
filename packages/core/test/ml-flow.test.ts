import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mivelo-mlflow-'));
process.env.KAVSAK_DATA_DIR = tmp;
process.env.MIVELO_DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = ''; // çeviri yerel (sahte) motorla
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { Store } = await import('../src/store.js');
const { bus } = await import('../src/bus.js');
const { setMlBackend } = await import('../src/ml/engine.js');
const { saveMlSettings, resetMlSettingsCache } = await import('../src/ml/config.js');
const { TranscribeService } = await import('../src/ml/transcribe.js');
const { SemanticIndex } = await import('../src/ml/semantic.js');
const { getTranscript, chatTranscripts } = await import('../src/ml/ml-store.js');
const { translateMessage, chatLanguage, translationEngine } = await import('../src/ml/translate.js');
const { isOgg } = await import('../src/ml/audio.js');
type Message = import('../src/model.js').Message;

const TINY_OGG = Buffer.from('T2dnUwACAAAAAAAAAAA0EXRHAAAAAEXfxpcBE09wdXNIZWFkAQE4AYA+AAAAAABPZ2dTAAAAAAAAAAAAADQRdEcBAAAA98xNeAT///8aT3B1c1RhZ3MLAAAAbGlib3B1cyAxLjQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABPZ2dTAAT4XgAAAAAAADQRdEcCAAAAr8d0/RoPFhAQFBATEhUQEBMREA8WDRMTDhIRERQUCgiE5HULn4wvWR0gzSt5wAi0r7nspIiCA2UUTNUE8YBd/qHsyQoIrOeK+v7iyMiWqH9u4Z5ACKznivr6ZyjegygWlPCI4Ais54r6/uLJGXVodZdLNi9acgqACK6NYvsyoSVv2Qeeg/JSMAiumkr6/uK+vllJdqefluokxrAIro1i+zKhJW/vrlhglYpFA8AIrppJBPq1rQ9kNaEo5DVZYPvb554IrppK+v7iyRl2n+L352OoCK6aSvr6ZyorFW+nciRn6giujWL7MqCx6/uGavbnkFWrkHAIro1i+49KgovJOwOA/YBpFQiumkr6/uK+vItZkZ9zpRoIrppK+v7iyMiBn/DhXHAIrq5qMlk+tYdKy12mOYQLlVOdrCoMCK6aSvr+4sX4oE8nPAiujWL7MqEj9LQHLJlM4xiu9kAIrppK+v7ivrfirNGTNfKGDYvICK6aSvr+4skZoOqYb8AIrppK+vpnKOMAYBTvZ+yk2YAIrppK+v7ixfjdxFnCbkx7gAiujWL7MqEj9M1wgoZ8BpfwCK7FnO7l+i21BGeLIIimnteoOcYIsE0JBPVQmMWepY1O02ut6BCf5QC9UIHoOsTFqKs=', 'base64');

/** Sahte gömme: kelime torbası (4 harflik kökler, eşanlamlılar aynı kök) → 384 boyut, birim uzunluk */
const SYN: Record<string, string> = { invoice: 'fatu', bill: 'fatu', payment: 'ödem', meeting: 'topl' };
function fakeEmbed(text: string): Float32Array {
  const v = new Float32Array(384);
  const body = text.replace(/^(query|passage): /, '').toLocaleLowerCase('tr-TR');
  for (const w of body.split(/[^\p{L}]+/u).filter((x) => x.length >= 3)) {
    const k = SYN[w] ?? w.slice(0, 4);
    let h = 0;
    for (const ch of k) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
    v[h % 384] += 1;
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

const calls = { transcribe: 0, embed: 0, translate: 0 };
setMlBackend({
  async transcribe(audio, language) {
    calls.transcribe++;
    assert.ok(isOgg(audio), 'ses işçiye Ogg olarak gider');
    return { text: 'yarın saat üçte faturayı gönderiyorum', lang: language ?? 'tr', seconds: 0.5 };
  },
  async embed(texts) {
    calls.embed++;
    return texts.map(fakeEmbed);
  },
});
// çeviri: Google Cloud Translation (sahte fetch + yer tutucu anahtar)
const { resetGoogleKeyCache } = await import('../src/ml/google-translate.js');
resetGoogleKeyCache('AIza' + 'x'.repeat(35));
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  if (!String(url).includes('translation.googleapis.com')) return realFetch(url, init);
  calls.translate++;
  const b = JSON.parse(String(init?.body)) as { q: string[]; target: string; source?: string };
  return new Response(JSON.stringify({ data: { translations: b.q.map((t) => ({ translatedText: `[${b.source ?? '?'}>${b.target}] ${t}`, detectedSourceLanguage: b.source ?? 'en' })) } }), { status: 200 });
}) as typeof fetch;
resetMlSettingsCache();
saveMlSettings({ semanticIndex: true, autoTranscribe: false });

const DAY = 86400e3;
const NOW = new Date(2026, 8, 30, 12, 0);

function seed() {
  const store = new Store(path.join(tmp, `f${Math.random().toString(36).slice(2)}.db`));
  const acc = { id: 'whatsapp:905000000099', platform: 'whatsapp' as const, label: 'x', status: 'connected' as const, createdAt: 1 };
  store.upsertAccount(acc);
  const chat = (rid: string, name: string) => {
    const id = `${acc.id}/${rid}`;
    store.upsertChat({ id, accountId: acc.id, platform: 'whatsapp', remoteId: rid, name, kind: 'direct', unread: 0, lastMessageAt: 0, lastPreview: '', tags: [] });
    return id;
  };
  const ahmet = chat('905000000001@s.whatsapp.net', 'Ahmet Yılmaz');
  const ayse = chat('905000000002@s.whatsapp.net', 'Ayşe Kaya');
  const msg = (chatId: string, rid: string, text: string, ts: number, extra: Partial<Message> = {}): Message => {
    const m: Message = { id: `${chatId}#${rid}`, chatId, remoteId: rid, senderId: 'x', senderName: 'x', fromMe: false, text, ts, status: 'delivered', ...extra };
    store.upsertMessage(m);
    return m;
  };
  const aug = new Date(2026, 7, 14).getTime();
  const m1 = msg(ahmet, 'A1', 'Ağustos faturası ekte, ödeme için IBAN aşağıda', aug);
  const m2 = msg(ahmet, 'A2', 'Hafta sonu maça gidiyor muyuz?', aug + DAY);
  const m3 = msg(ayse, 'B1', 'Invoice for the August order is attached', aug + 2 * DAY);
  const m4 = msg(ayse, 'B2', 'Hello, when will my order ship? Thanks!', NOW.getTime() - DAY);
  const m5 = msg(ahmet, 'A3', 'Toplantıyı perşembeye alalım mı?', NOW.getTime() - 3 * DAY);
  const voice = msg(ahmet, 'V1', '', NOW.getTime() - 2 * DAY, {
    attachments: [{ kind: 'audio', name: 'Sesli mesaj · 0:01', mime: 'audio/ogg; codecs=opus', link: `/api/media/${encodeURIComponent(acc.id)}?u=${encodeURIComponent('wa:905000000001@s.whatsapp.net/V1')}` }],
  });
  return { store, acc, ahmet, ayse, m1, m2, m3, m4, m5, voice };
}

test('ml akış: sesli mesaj yazıya dökülür, olay yayılır, tam metin aramada bulunur; mesaj silinince metin de gider', async () => {
  const s = seed();
  const media = { get: (id: string) => (id === s.acc.id ? { fetchMedia: async (u: string) => (u.endsWith('/V1') ? { body: TINY_OGG, type: 'audio/ogg' } : undefined) } : undefined) };
  const svc = new TranscribeService(s.store, media);
  const events: string[] = [];
  const done = new Promise<void>((resolve) => {
    const off = bus.on((ev) => {
      if (ev.type !== 'transcript.update' || ev.messageId !== s.voice.id) return;
      events.push(ev.transcript.status);
      if (ev.transcript.status !== 'pending') (off(), resolve());
    });
  });
  const first = svc.request(s.voice.id);
  assert.equal(first.status, 'pending');
  await done;
  assert.deepEqual(events, ['pending', 'done']);
  const t = getTranscript(s.store, s.voice.id)!;
  assert.equal(t.status, 'done');
  assert.match(t.text, /fatura/);
  assert.equal(chatTranscripts(s.store, s.ahmet).length, 1);
  assert.equal(chatTranscripts(s.store, s.ayse).length, 0, 'aralık taraması yalnız o sohbet');
  const hits = s.store.search('faturayı', 20);
  const hit = hits.find((h) => h.message.id === s.voice.id);
  assert.ok(hit, 'sesli mesaj metni aramada');
  assert.match(hit!.transcript ?? '', /faturayı/);
  // metinsiz ses yok → istek reddedilir
  assert.throws(() => svc.request(s.m1.id), /ses yok/);
  // hesap kaldırılınca (dilimli silme) yabancı anahtarla metin + FTS temizlenir
  await s.store.purgeAccount(s.acc.id);
  assert.equal(getTranscript(s.store, s.voice.id), undefined);
  assert.equal(s.store.search('faturayı', 20).length, 0);
  assert.equal(calls.transcribe, 1);
});

test('ml akış: anlamsal dizin + hibrit arama (tarih/kişi ipuçları), silinen mesaj sonuçtan düşer', async () => {
  const s = seed();
  const idx = new SemanticIndex(s.store);
  // dizinleme döngüsü: olay aboneliği yok, doğrudan tetikle ve bitmesini bekle
  (idx as unknown as { stopped: boolean }).stopped = false;
  idx.kick(0);
  for (let i = 0; i < 200 && (idx.status().running || idx.status().indexed < 5); i++) await new Promise((r) => setTimeout(r, 20));
  const st = idx.status();
  assert.equal(st.indexed, 5, 'metinli 5 mesaj dizinlendi (boş sesli mesaj hariç)');
  assert.equal(st.pct, 100);

  const r = await idx.search("geçen ay Ahmet'in gönderdiği fatura", 10, NOW);
  assert.equal(r.hints.dateLabel, 'geçen ay');
  assert.deepEqual(r.hints.people, ['ahmet']);
  assert.equal(r.hits[0]?.message.id, s.m1.id);
  assert.ok(r.hits.every((h) => h.chat.id === s.ahmet), 'yalnız Ahmet');
  assert.ok(!r.hits.some((h) => h.message.id === s.m5.id), 'tarih aralığı dışı elendi');

  // eşanlam: "invoice" sorgusu Türkçe faturayı da bulur (anlamsal kol), İngilizceyi de
  const inv = await idx.search('invoice', 10, NOW);
  const ids = inv.hits.map((h) => h.message.id);
  assert.ok(ids.includes(s.m1.id) && ids.includes(s.m3.id));
  assert.equal(inv.mode, 'semantic');

  // yalnız kişi ipucu: o kişinin mesajları (en yeni önce)
  const onlyAyse = await idx.search("Ayşe'nin mesajları", 10, NOW);
  assert.ok(onlyAyse.hits.length > 0 && onlyAyse.hits.every((h) => h.chat.id === s.ayse));

  // mesaj silinince vektör de gider (CASCADE) ve arama onu döndürmez
  s.store.mlStmt('DELETE FROM messages WHERE id = ?').run(s.m1.id);
  assert.equal((s.store.mlStmt('SELECT COUNT(*) AS n FROM embeddings WHERE message_id = ?').get(s.m1.id) as { n: number }).n, 0);
  const again = await idx.search('fatura', 10, NOW);
  assert.ok(!again.hits.some((h) => h.message.id === s.m1.id));
  idx.stop();
});

test('ml akış: çeviri — yabancı mesaj çevrilir ve önbelleklenir, Türkçe mesaj modele gitmez, düzenleme önbelleği siler', async () => {
  const s = seed();
  assert.equal(translationEngine(), 'google');
  const before = calls.translate;
  const tr = await translateMessage(s.store, s.m4.id, 'tr');
  assert.equal(tr.source, 'en');
  assert.equal(tr.engine, 'google');
  assert.equal(tr.text, '[en>tr] Hello, when will my order ship? Thanks!');
  const cached = await translateMessage(s.store, s.m4.id, 'tr');
  assert.equal(cached.cached, true);
  assert.equal(calls.translate, before + 1, 'ikinci istek önbellekten');
  const same = await translateMessage(s.store, s.m2.id, 'tr');
  assert.equal(same.same, true);
  assert.equal(calls.translate, before + 1, 'Türkçe mesaj çevrilmez');
  // metin değişince (düzenleme) çeviri önbelleği silinir
  s.store.applyEdit(s.m4.id, 'Hello again, any update on shipping?');
  const fresh = await translateMessage(s.store, s.m4.id, 'tr');
  assert.ok(!fresh.cached);
  assert.equal(calls.translate, before + 2);
  // sohbetin dili: Ayşe İngilizce yazıyor
  assert.equal(chatLanguage(s.store, s.ayse).lang, 'en');
  assert.equal(chatLanguage(s.store, s.ahmet).lang, 'tr');
  // hesap silinince çeviri satırları da gider
  s.store.deleteAccount(s.acc.id);
  assert.equal((s.store.mlStmt('SELECT COUNT(*) AS n FROM translations').get() as { n: number }).n, 0);
});

test('ml uçları: durum, ayar kaydı, hata eşleme (409 model yok → Türkçe ileti), metin çevirisi', async () => {
  const { registerMlRoutes } = await import('../src/ml/routes.js');
  const s = seed();
  const routes = new Map<string, (req: unknown, res: unknown, params: Record<string, string>, body: unknown) => unknown>();
  class HttpErr extends Error {
    constructor(
      public status: number,
      msg: string,
    ) {
      super(msg);
    }
  }
  const { semantic, transcribe } = registerMlRoutes((m, p, h) => routes.set(`${m} ${p}`, h), { store: s.store, media: { get: () => undefined }, httpError: (st, msg) => new HttpErr(st, msg) });
  try {
    const call = (key: string, body?: unknown, url = '/', params: Record<string, string> = {}) => routes.get(key)!({ url }, {}, params, body);
    const st = (await call('GET /api/ml')) as { models: Array<{ key: string }>; settings: { semanticIndex: boolean } };
    assert.deepEqual(st.models.map((m) => m.key), ['whisper', 'embed']);
    const saved = (await call('POST /api/ml/settings', { autoTranscribe: true, translateTarget: 'xx-bad' })) as { settings: { autoTranscribe: boolean; translateTarget: string } };
    assert.equal(saved.settings.autoTranscribe, true);
    assert.equal(saved.settings.translateTarget, 'tr', 'geçersiz dil kodu yok sayılır');
    await assert.rejects(Promise.resolve().then(() => call('POST /api/ml/transcribe', {})), (e: HttpErr) => e.status === 400);
    await assert.rejects(Promise.resolve().then(() => call('POST /api/ml/models/:key/download', undefined, '/', { key: 'yok' })), (e: HttpErr) => e.status === 404);
    const tr = (await call('POST /api/ml/translate-text', { text: 'Almanya’ya gönderiyoruz, teşekkürler', target: 'en' })) as { text: string; engine: string };
    assert.match(tr.text, /^\[\?>en\]/);
    // model "yok" sayılınca anlaşılır 409
    setMlBackend(
      { transcribe: async () => ({ text: '', lang: null }), embed: async () => [] },
      [],
    );
    await assert.rejects(Promise.resolve().then(() => call('POST /api/ml/transcribe', { messageId: s.voice.id })), (e: HttpErr) => e.status === 409 && /modeli indir/.test(e.message));
    const lang = (await call('GET /api/ml/chat-lang', undefined, `/api/ml/chat-lang?chat=${encodeURIComponent(s.ayse)}`)) as { lang: string };
    assert.equal(lang.lang, 'en');
  } finally {
    semantic.stop();
    transcribe.stop();
  }
});
