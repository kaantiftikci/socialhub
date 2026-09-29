import './boot-env.js';
import { Store } from './store.js';
import { Registry } from './registry.js';
import { createServer } from './server.js';
import { bus } from './bus.js';
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_MODE, PORT, ensureDirs, DATA_DIR } from './config.js';
import { getDbKey } from './dbkey.js';
import { startStallWatch } from './stall-watch.js';
import { LICENSE_REQUIRED, licensed, onLicenseChange, startLicenseChecks, whenLicensed } from './license.js';

// libsignal (WhatsApp şifre kütüphanesi) çözülemeyen eski/yinelenen paketleri doğrudan console.error ile basar;
// zararsızdır (WhatsApp Web de aynı paketleri sessizce atar). Terminali kirletmesin.
const NOISE = [/Failed to decrypt message with any known session/, /Session error:\s*MessageCounterError/, /Bad MAC/, /Closing (open )?session/];
let decryptFails = 0;
setInterval(() => {
  if (decryptFails > 0) {
    bus.log('warn', `WhatsApp: son 1 dakikada ${decryptFails} mesaj çözülemedi (oturum anahtarı uyuşmazlığı; telefonda Bağlı cihazlar → cihazı kaldırıp yeniden eşleştirmek çözer)`);
    decryptFails = 0;
  }
}, 60_000).unref();
for (const k of ['error', 'log', 'warn', 'info', 'debug'] as const) {
  const orig = console[k].bind(console);
  console[k] = (...args: unknown[]) => {
    const first = String(args[0] ?? '');
    if (NOISE.some((re) => re.test(first))) {
      if (/Failed to decrypt|Bad MAC/.test(first)) decryptFails++;
      return;
    }
    // libsignal oturum nesnesini (anahtarlarla birlikte!) ayrı bir çağrıyla döküyor: günlüğe yazma
    if (args.some((x) => x && typeof x === 'object' && ('ephemeralKeyPair' in (x as object) || 'indexInfo' in (x as object) || 'pendingPreKey' in (x as object) || 'currentRatchet' in (x as object) || '_chains' in (x as object)))) return;
    orig(...args);
  };
}

// Yakalanmamış hatalar süreci düşürmesin (Node 22 varsayılanı: unhandledRejection → çıkış)
process.on('unhandledRejection', (e) => bus.log('error', `Yakalanmamış söz reddi: ${(e as Error)?.stack ?? String(e)}`));
process.on('uncaughtException', (e) => bus.log('error', `Yakalanmamış hata: ${e.stack ?? String(e)}`));

/** 60 günden eski medya önbelleği dosyalarını sil (sessions/<hesap>/media, media-index): disk sınırsız büyümesin */
function pruneMediaCache(): void {
  try {
    const sessions = path.join(DATA_DIR, 'sessions');
    if (!fs.existsSync(sessions)) return;
    const cutoff = Date.now() - 60 * 86_400_000;
    let n = 0;
    for (const acc of fs.readdirSync(sessions)) {
      for (const sub of ['media', 'media-index']) {
        const dir = path.join(sessions, acc, sub);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          const fp = path.join(dir, f);
          try {
            if (fs.statSync(fp).mtimeMs < cutoff) {
              fs.rmSync(fp, { force: true });
              n++;
            }
          } catch {
            /* yok */
          }
        }
      }
    }
    if (n) bus.log('info', `Medya önbelleği: ${n} eski dosya silindi`);
  } catch {
    /* yok */
  }
}

async function main(): Promise<void> {
  // Yeni dosyalar (oturum, önbellek, günlük) yalnızca bu kullanıcıya okunur olsun
  process.umask(0o077);
  ensureDirs();
  pruneMediaCache();
  const store = new Store(undefined, getDbKey()); // diskte şifreli (SQLCipher); anahtar Anahtar Zinciri'nde
  const registry = new Registry(store);
  bus.log('info', `Veri dizini: ${DATA_DIR}${DEMO_MODE ? '  (DEMO MODU)' : ''}`);

  const server = createServer(store, registry, PORT);
  // Aynı anda ikinci bir çekirdek (uygulama iki kez açıldı vb.) aynı oturum dosyalarını kullanıp WhatsApp'ın Signal
  // oturumunu bozuyordu: port doluysa connector'ları hiç başlatmadan çık
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  }).catch((e: NodeJS.ErrnoException) => {
    bus.log('error', e.code === 'EADDRINUSE' ? `Port ${PORT} dolu: başka bir Mivelo çekirdeği çalışıyor, bu kopya kapanıyor` : `Sunucu başlatılamadı: ${e.message}`);
    process.exit(e.code === 'EADDRINUSE' ? 0 : 1);
  });

  // Tanı: olay döngüsü 1,5 sn'den uzun kilitlenirse (eşzamanlı ağır iş) süresi ve kilitten hemen önceki son günlük satırı yazılır —
  // masaüstünde "Çekirdek başlatılıyor"da kalmanın kaynağı core.log'dan okunabilsin (29.09: dinliyor ama yanıt vermiyordu)
  // döngü hiç dönmezse yukarıdaki ölçer de çalışamaz: ayrı iş parçacığındaki bekçi yığını core.log'a yazar (stall-watch.ts)
  startStallWatch();
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - 1000;
    lastTick = now;
    if (lag > 1500) {
      const before = bus.recent.filter((r) => r.ts <= now - lag).slice(-1)[0];
      bus.log('warn', `Olay döngüsü ${(lag / 1000).toFixed(1)} sn kilitlendi (öncesinde: ${before ? before.text.slice(0, 120) : '—'})`);
    }
  }, 1000).unref();

  if (DEMO_MODE) {
    const existing = registry.list().find((a) => a.platform === 'demo');
    if (existing) await registry.restart(existing.id);
    else await registry.add('demo', { label: 'Demo hesabı' });
  }
  // Paketli uygulama: lisans etkinleşmeden hiçbir kanal başlamaz; lisans iptal edilirse kanallar durur
  startLicenseChecks();
  if (LICENSE_REQUIRED && !licensed()) bus.log('info', 'Lisans bekleniyor: kanallar lisans etkinleşince başlayacak');
  await whenLicensed();
  await registry.bootAll();
  let booted = true;
  onLicenseChange((valid) => {
    if (!valid && booted) {
      booted = false;
      bus.log('warn', 'Lisans geçersiz: kanallar durduruldu');
      void registry.stopAll();
    } else if (valid && !booted) {
      booted = true;
      void registry.bootAll();
    }
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return; // ikinci SIGINT/SIGTERM kapanışı yeniden başlatmasın
    closing = true;
    bus.log('info', 'Kapatılıyor…');
    // son çare: connector'lar (her biri ≤10 sn) takılsa da süreç 20 sn içinde çıkar
    setTimeout(() => process.exit(0), 20_000).unref();
    await registry.stopAll();
    server.close();
    try {
      store.close();
    } catch {
      /* zaten kapalı */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
