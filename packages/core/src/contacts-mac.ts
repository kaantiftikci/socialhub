import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { bus } from './bus.js';

/**
 * macOS Kişiler (AddressBook) veritabanından numara → ad eşlemesi.
 * WhatsApp rehber adlarını geç/eksik gönderdiğinde yedek kaynak. Yalnızca okunur;
 * Tam Disk Erişimi yoksa sessizce boş döner.
 */
let cache: Map<string, string> | undefined;
let loadedAt = 0;

export function normalizePhone(p: string): string {
  let d = p.replace(/[^\d+]/g, '').replace(/^00/, '+');
  if (!d.startsWith('+')) {
    if (d.startsWith('0') && d.length === 11) d = '+9' + d; // 05xx → +905xx (TR varsayımı)
    else d = '+' + d;
  }
  return d;
}

export function macContacts(): Map<string, string> {
  if (cache && Date.now() - loadedAt < 10 * 60_000) return cache;
  const m = new Map<string, string>();
  cache = m;
  loadedAt = Date.now();
  if (process.platform !== 'darwin') return m;
  try {
    const dbs: string[] = [];
    const root = path.join(os.homedir(), 'Library', 'Application Support', 'AddressBook', 'AddressBook-v22.abcddb');
    if (fs.existsSync(root)) dbs.push(root);
    const srcDir = path.join(os.homedir(), 'Library', 'Application Support', 'AddressBook', 'Sources');
    if (fs.existsSync(srcDir))
      for (const s of fs.readdirSync(srcDir)) {
        const p = path.join(srcDir, s, 'AddressBook-v22.abcddb');
        if (fs.existsSync(p)) dbs.push(p);
      }
    for (const file of dbs) {
      try {
        const ab = new Database(file, { readonly: true, fileMustExist: true });
        const rows = ab
          .prepare(`SELECT r.ZFIRSTNAME AS f, r.ZLASTNAME AS l, r.ZORGANIZATION AS o, p.ZFULLNUMBER AS phone FROM ZABCDRECORD r JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK`)
          .all() as Array<{ f: string | null; l: string | null; o: string | null; phone: string | null }>;
        for (const r of rows) {
          const name = [r.f, r.l].filter(Boolean).join(' ').trim() || (r.o ?? '').trim();
          if (name && r.phone) m.set(normalizePhone(r.phone), name);
        }
        ab.close();
      } catch {
        /* bu kaynak okunamadı */
      }
    }
    if (m.size) bus.log('info', `macOS Kişiler: ${m.size} numara yüklendi`);
  } catch {
    /* erişim yok */
  }
  return m;
}
