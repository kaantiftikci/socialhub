import { Worker } from 'node:worker_threads';
import { bus } from './bus.js';

/**
 * Kalıcı kilit bekçisi (29.09, Kaan: masaüstü "Çekirdek başlatılıyor"da kalıyor, çekirdek 7788'de dinliyor ama yanıt vermiyor,
 * core.log'da "kilitlendi" satırı YOK). index.ts'deki gecikme ölçer ana olay döngüsünde çalıştığı için döngü hiç dönmezse
 * kendisi de çalışamıyordu. Bu bekçi ayrı iş parçacığında: ana iş parçacığı 250 ms'de bir ortak sayacı artırır; 5 sn artmazsa
 * bekçi denetleyiciyle (inspector) ana iş parçacığını bir anlığına duraklatıp o an çalışan JS yığınını alır ve DOĞRUDAN stderr'e
 * (masaüstünde core.log) yazar — ana iş parçacığı kilitliyken onun günlüğü akmaz. Kilit sürerse 20 ve 60 sn'de yeniden örnekler.
 * Yalnız işlev adı + dosya:satır yazılır (içerik/kişisel veri yok). Kapatmak: MIVELO_STALL_WATCH=0.
 */
const WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
let inspector; try { inspector = require('node:inspector'); } catch {}
const hb = new Int32Array(workerData);
const MARKS = [5000, 20000, 60000];
let last = -1, since = Date.now(), next = 0, busy = false, lastLog = '';
parentPort.on('message', (m) => { if (typeof m === 'string') lastLog = m; });
const out = (s) => { try { fs.writeSync(2, '[' + new Date().toISOString() + '] ' + s + '\\n'); } catch {} };
const urls = {};
const frame = (f) => {
  const file = (f.url || urls[f.location.scriptId] || '').replace(/^file:\\/\\//, '').split(/[\\\\/]/).slice(-2).join('/');
  return (f.functionName || '(anonim)') + ' ' + (file || '?') + ':' + (f.location.lineNumber + 1);
};
function sample(ms) {
  if (!inspector || busy) return out('Olay döngüsü ' + Math.round(ms / 1000) + ' sn\\'dir yanıt vermiyor (yığın alınamadı) · son günlük: ' + lastLog);
  busy = true;
  const s = new inspector.Session();
  let finished = false;
  const finish = (txt) => {
    if (finished) return; finished = true; busy = false;
    out('Olay döngüsü ' + Math.round(ms / 1000) + ' sn\\'dir yanıt vermiyor — ' + txt + ' · son günlük: ' + lastLog);
    try { s.post('Debugger.resume', () => { s.post('Debugger.disable', () => s.disconnect()); }); } catch {}
  };
  try {
    s.connectToMainThread();
    s.on('Debugger.scriptParsed', (m) => { if (m.params.url) urls[m.params.scriptId] = m.params.url; });
    s.on('Debugger.paused', (m) => finish('yığın: ' + m.params.callFrames.slice(0, 10).map(frame).join(' < ')));
    s.post('Debugger.enable', () => s.post('Debugger.pause'));
    // yerel kodda (SQLite sorgusu, eşzamanlı dosya/işlem çağrısı) duraklama JS'e dönene dek gelmez
    setTimeout(() => { if (!finished) out('Olay döngüsü ' + Math.round(ms / 1000) + ' sn\\'dir yanıt vermiyor — yerel kodda bekliyor (SQLite/dosya/alt süreç olabilir), yığın dönünce yazılacak · son günlük: ' + lastLog); }, 4000);
  } catch (e) { finish('yığın alınamadı: ' + e.message); }
}
setInterval(() => {
  const v = Atomics.load(hb, 0);
  if (v !== last) { if (next > 0) out('Olay döngüsü yeniden yanıt veriyor (' + Math.round((Date.now() - since) / 1000) + ' sn kilitliydi)'); last = v; since = Date.now(); next = 0; return; }
  const ms = Date.now() - since;
  if (next < MARKS.length && ms >= MARKS[next]) { next++; sample(ms); }
}, 500);
`;

export function startStallWatch(): void {
  if (process.env.MIVELO_STALL_WATCH === '0') return;
  try {
    const sab = new SharedArrayBuffer(4);
    const hb = new Int32Array(sab);
    setInterval(() => Atomics.add(hb, 0, 1), 250).unref();
    const w = new Worker(WORKER, { eval: true, workerData: sab, stdout: false, stderr: false });
    w.unref();
    w.on('error', (e) => bus.log('warn', `Kilit bekçisi durdu: ${e.message}`));
    // bekçi kilit anında "son günlük" satırını yazabilsin (yalnız ilk 160 karakter)
    bus.on((ev) => {
      if (ev.type === 'log') w.postMessage(ev.text.slice(0, 160));
    });
  } catch (e) {
    bus.log('warn', `Kilit bekçisi başlatılamadı: ${(e as Error).message}`);
  }
}
