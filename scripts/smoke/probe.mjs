// Çekirdeğin yanıt verebilirliğini ölçer: süre boyunca 0,5 sn'de bir sağlık/hesap/sohbet uçlarını çağırır (arayüzün açılışta yaptığı gibi),
// ilk dinleme, ilk yanıt, en uzun yanıt ve 3 sn'yi aşan istek sayısını yazar. Kullanım: node scripts/smoke/probe.mjs <saniye> [etiket]
const secs = Number(process.argv[2] ?? 120);
const label = process.argv[3] ?? 'çekirdek';
const base = 'http://127.0.0.1:7788';
const start = Date.now();
const stats = {};
let firstListen = null;
let firstOk = null;
const call = async (p) => {
  const t = Date.now();
  try {
    const r = await fetch(base + p, { headers: { origin: 'tauri://localhost', 'x-mivelo-client': '1' }, signal: AbortSignal.timeout(15_000) });
    await r.text();
    if (firstListen === null) firstListen = Date.now() - start;
    if (r.status < 500 && p === '/api/health' && firstOk === null) firstOk = Date.now() - start;
    return { ms: Date.now() - t, code: r.status };
  } catch (e) {
    return { ms: Date.now() - t, code: e.name === 'TimeoutError' ? 'zaman aşımı' : 'bağlanamadı' };
  }
};
while (Date.now() - start < secs * 1000) {
  const res = await Promise.all(['/api/health', '/api/accounts', '/api/chats'].map(async (p) => [p, await call(p)]));
  for (const [p, r] of res) {
    const s = (stats[p] ??= { n: 0, max: 0, slow: 0, codes: {} });
    if (r.code === 'bağlanamadı') continue;
    s.n++;
    s.max = Math.max(s.max, r.ms);
    if (r.ms > 3000) s.slow++;
    s.codes[r.code] = (s.codes[r.code] ?? 0) + 1;
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`\n=== ${label}: ilk dinleme ${firstListen ?? '—'} ms, ilk sağlık yanıtı ${firstOk ?? '—'} ms ===`);
for (const [p, s] of Object.entries(stats)) console.log(`${p.padEnd(14)} istek ${s.n}  en uzun ${s.max} ms  >3 sn: ${s.slow}  kodlar ${JSON.stringify(s.codes)}`);
