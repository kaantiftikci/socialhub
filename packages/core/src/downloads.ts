import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bus } from './bus.js';
import { IS_MAC, IS_WINDOWS, openExternal } from './platform.js';

/**
 * Arayüzün ürettiği dosyayı (Raporum paylaşım kartı PNG'si, kütüphaneden seçilen medya) İndirilenler klasörüne yaz.
 * Masaüstünde (Tauri/WKWebView) `<a download>` çalışmadığı için bu yol kullanılır. Aynı adlı dosya varsa "ad (2).png".
 */
export function saveDownload(name: string, data: Buffer, opts: { dir?: string; reveal?: boolean } = {}): string {
  if (!data.length) throw new Error('Dosya boş');
  const base = String(name || 'mivelo').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/^\.+/, '').trim().slice(0, 120) || 'mivelo';
  const dir = opts.dir ?? path.join(os.homedir(), 'Downloads');
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let file = path.join(dir, base);
  for (let i = 2; fs.existsSync(file) && i < 1000; i++) file = path.join(dir, `${stem} (${i})${ext}`);
  fs.writeFileSync(file, data, { flag: 'wx' });
  if (opts.reveal !== false) revealFile(file);
  return file;
}

/** Dosyayı Finder/Gezgin'de seçili göster (Linux: klasörü aç) */
export function revealFile(file: string): void {
  try {
    if (IS_MAC || IS_WINDOWS) {
      const child = IS_MAC ? spawn('open', ['-R', file], { detached: true, stdio: 'ignore' }) : spawn('explorer.exe', [`/select,${file}`], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', (e) => bus.log('warn', `Dosya gösterilemedi: ${e.message}`));
      child.unref();
    } else openExternal(path.dirname(file));
  } catch (e) {
    bus.log('warn', `Dosya gösterilemedi: ${(e as Error).message}`);
  }
}
