import { Store } from './store.js';
import { Registry } from './registry.js';
import { createServer } from './server.js';
import { bus } from './bus.js';
import { DEMO_MODE, PORT, ensureDirs, DATA_DIR } from './config.js';

// libsignal (WhatsApp şifre kütüphanesi) çözülemeyen eski/yinelenen paketleri doğrudan console.error ile basar;
// zararsızdır (WhatsApp Web de aynı paketleri sessizce atar). Terminali kirletmesin.
const NOISE = [/Failed to decrypt message with any known session/, /Session error:\s*MessageCounterError/, /Bad MAC/, /Closing (open )?session/];
for (const k of ['error', 'log', 'warn'] as const) {
  const orig = console[k].bind(console);
  console[k] = (...args: unknown[]) => {
    const first = String(args[0] ?? '');
    if (NOISE.some((re) => re.test(first))) return;
    // libsignal oturum nesnesini (anahtarlarla birlikte!) ayrı bir çağrıyla döküyor: günlüğe yazma
    if (args.some((x) => x && typeof x === 'object' && ('ephemeralKeyPair' in (x as object) || 'indexInfo' in (x as object) || 'pendingPreKey' in (x as object)))) return;
    orig(...args);
  };
}

// Yakalanmamış hatalar süreci düşürmesin (Node 22 varsayılanı: unhandledRejection → çıkış)
process.on('unhandledRejection', (e) => bus.log('error', `Yakalanmamış söz reddi: ${(e as Error)?.stack ?? String(e)}`));
process.on('uncaughtException', (e) => bus.log('error', `Yakalanmamış hata: ${e.stack ?? String(e)}`));

async function main(): Promise<void> {
  ensureDirs();
  const store = new Store();
  const registry = new Registry(store);
  bus.log('info', `Veri dizini: ${DATA_DIR}${DEMO_MODE ? '  (DEMO MODU)' : ''}`);

  const server = createServer(store, registry, PORT);

  if (DEMO_MODE) {
    const existing = registry.list().find((a) => a.platform === 'demo');
    if (existing) await registry.restart(existing.id);
    else await registry.add('demo', { label: 'Demo hesabı' });
  }
  await registry.bootAll();

  const shutdown = async () => {
    bus.log('info', 'Kapatılıyor…');
    await registry.stopAll();
    server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
