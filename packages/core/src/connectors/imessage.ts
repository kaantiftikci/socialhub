import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import Database from 'better-sqlite3';
import { BaseConnector } from './base.js';
import { bus } from '../bus.js';
import type { Attachment } from '../model.js';

/**
 * iMessage (yalnızca macOS): Mesajlar uygulamasının yerel veritabanı
 * ~/Library/Messages/chat.db salt-okunur açılır, yeni satırlar 3 sn'de bir yoklanır.
 * Gönderme AppleScript (osascript) ile Mesajlar uygulaması üzerinden yapılır.
 * Gerekli izin: Sistem Ayarları → Gizlilik ve Güvenlik → Tam Disk Erişimi → terminalin/Node.
 */
const DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const APPLE_EPOCH_MS = 978_307_200_000; // 2001-01-01

interface Row {
  rowid: number;
  guid: string;
  text: string | null;
  attributedBody: Buffer | null;
  date: number;
  is_from_me: number;
  handle: string | null;
  chat_identifier: string;
  chat_guid: string;
  display_name: string | null;
  cache_has_attachments: number;
  item_type: number;
}

export class IMessageConnector extends BaseConnector {
  private db?: Database.Database;
  private timer?: NodeJS.Timeout;
  private lastRowId = 0;
  private names = new Map<string, string>();

  async start(): Promise<void> {
    if (process.platform !== 'darwin') {
      this.setStatus('error', 'iMessage yalnızca macOS üzerinde çalışır');
      return;
    }
    if (!fs.existsSync(DB)) {
      this.setStatus('error', 'chat.db bulunamadı; Mesajlar uygulaması bu Mac’te kurulu mu?');
      return;
    }
    this.setStatus('connecting');
    try {
      this.db = new Database(DB, { readonly: true, fileMustExist: true });
      this.db.prepare('SELECT COUNT(*) FROM message').get();
    } catch (e) {
      // Sistem Ayarları → Gizlilik ve Güvenlik → Tam Disk Erişimi bölmesini doğrudan aç
      execFile('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'], () => undefined);
      this.setStatus(
        'error',
        'Tam Disk Erişimi gerekli — açılan Sistem Ayarları penceresinde listeye Kavşak’ı (geliştirme modunda Terminal’i) ekleyip anahtarı aç, sonra “Yeniden dene” de',
      );
      void e;
      return;
    }
    this.account.label = os.userInfo().username;
    this.setStatus('connected');
    this.loadContacts();
    this.backfill();
    this.timer = setInterval(() => this.poll(), 3000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.db?.close();
    this.db = undefined;
    this.setStatus('disconnected');
  }

  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    // remoteChatId = chat_guid (ör. "iMessage;-;+905xxxxxxxxx" veya "iMessage;+;chat1234…")
    const isGroup = remoteChatId.includes(';+;');
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = isGroup
      ? `tell application "Messages"\n send "${esc(text)}" to chat id "${esc(remoteChatId)}"\nend tell`
      : `tell application "Messages"\n set svc to 1st account whose service type = iMessage\n set tgt to participant "${esc(remoteChatId.split(';').pop() ?? '')}" of svc\n send "${esc(text)}" to tgt\nend tell`;
    await new Promise<void>((resolve, reject) => {
      execFile('osascript', ['-e', script], (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
    });
    const id = `local-${Date.now()}`;
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'sent' });
    return { remoteId: id };
  }

  /** Kişi adları: AddressBook veritabanı okunabiliyorsa numaradan/e-postadan isim çöz. */
  private loadContacts(): void {
    try {
      const abDir = path.join(os.homedir(), 'Library', 'Application Support', 'AddressBook', 'Sources');
      const dbs: string[] = [];
      const root = path.join(os.homedir(), 'Library', 'Application Support', 'AddressBook', 'AddressBook-v22.abcddb');
      if (fs.existsSync(root)) dbs.push(root);
      if (fs.existsSync(abDir)) for (const s of fs.readdirSync(abDir)) {
        const p = path.join(abDir, s, 'AddressBook-v22.abcddb');
        if (fs.existsSync(p)) dbs.push(p);
      }
      for (const file of dbs) {
        const ab = new Database(file, { readonly: true });
        const rows = ab
          .prepare(
            `SELECT r.ZFIRSTNAME AS f, r.ZLASTNAME AS l, p.ZFULLNUMBER AS phone, e.ZADDRESS AS email
             FROM ZABCDRECORD r LEFT JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK LEFT JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK`,
          )
          .all() as Array<{ f: string | null; l: string | null; phone: string | null; email: string | null }>;
        for (const r of rows) {
          const name = [r.f, r.l].filter(Boolean).join(' ').trim();
          if (!name) continue;
          if (r.phone) this.names.set(normalizePhone(r.phone), name);
          if (r.email) this.names.set(r.email.toLowerCase(), name);
        }
        ab.close();
      }
    } catch {
      /* rehber okunamadı; numaralar gösterilir */
    }
  }

  private nameOf(handle: string | null, display: string | null, chatId: string): string {
    if (display) return display;
    if (handle) return this.names.get(normalizePhone(handle)) ?? this.names.get(handle.toLowerCase()) ?? handle;
    return chatId;
  }

  private query(afterRowId: number, limit: number): Row[] {
    return this.db!
      .prepare(
        `SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.date, m.is_from_me, m.cache_has_attachments, m.item_type,
                h.id AS handle, c.chat_identifier, c.guid AS chat_guid, c.display_name
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         JOIN chat c ON c.ROWID = cmj.chat_id
         LEFT JOIN handle h ON h.ROWID = m.handle_id
         WHERE m.ROWID > ? ORDER BY m.ROWID ASC LIMIT ?`,
      )
      .all(afterRowId, limit) as Row[];
  }

  private backfill(): void {
    if (!this.db) return;
    const max = (this.db.prepare('SELECT MAX(ROWID) AS m FROM message').get() as { m: number | null }).m ?? 0;
    const from = Math.max(0, max - 2000); // son ~2000 mesaj
    const rows = this.query(from, 2500);
    for (const r of rows) this.ingest(r, false);
    this.lastRowId = max;
    bus.log('info', `iMessage geçmişi: ${rows.length} mesaj yüklendi`);
  }

  private poll(): void {
    if (!this.db) return;
    try {
      const rows = this.query(this.lastRowId, 200);
      for (const r of rows) {
        this.ingest(r, true);
        this.lastRowId = Math.max(this.lastRowId, r.rowid);
      }
    } catch (e) {
      bus.log('warn', `iMessage yoklama: ${(e as Error).message}`);
    }
  }

  private ingest(r: Row, live: boolean): void {
    if (r.item_type !== 0) return; // grup olayları, isim değişiklikleri vb.
    const text = (r.text ?? '').trim() || decodeAttributedBody(r.attributedBody);
    const attachments: Attachment[] | undefined = r.cache_has_attachments ? [{ kind: 'other', name: 'ek' }] : undefined;
    if (!text && !attachments) return;
    const isGroup = r.chat_identifier.startsWith('chat');
    const chatName = this.nameOf(isGroup ? null : r.handle ?? r.chat_identifier, r.display_name, r.chat_identifier);
    this.ensureChat(r.chat_guid, chatName, isGroup ? 'group' : 'direct');
    const ms = r.date > 1e12 ? Math.floor(r.date / 1e6) + APPLE_EPOCH_MS : r.date * 1000 + APPLE_EPOCH_MS;
    this.upsertMessage(
      {
        remoteChatId: r.chat_guid,
        remoteId: r.guid,
        senderId: r.is_from_me ? 'me' : (r.handle ?? 'unknown'),
        senderName: r.is_from_me ? 'Ben' : this.nameOf(r.handle, null, r.chat_identifier),
        fromMe: r.is_from_me === 1,
        text,
        ts: ms,
        status: r.is_from_me ? 'sent' : 'delivered',
        attachments,
      },
      { live },
    );
  }
}

function normalizePhone(p: string): string {
  return p.replace(/[^\d+]/g, '').replace(/^00/, '+');
}

/**
 * macOS Ventura+ metni `attributedBody` (NSAttributedString typedstream) içinde tutar.
 * Tam bir typedstream çözücü yerine NSString yükünü bulan pratik bir okuyucu.
 */
export function decodeAttributedBody(buf: Buffer | null): string {
  if (!buf || buf.length === 0) return '';
  const marker = buf.indexOf('NSString');
  if (marker < 0) return '';
  // "NSString" + \x01\x94\x84\x01 + '+' (0x2b) + uzunluk + utf8
  let i = buf.indexOf(0x2b, marker);
  if (i < 0) return '';
  i += 1;
  let len = buf[i];
  i += 1;
  if (len === 0x81) {
    len = buf.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    len = buf.readUInt32LE(i);
    i += 4;
  }
  const s = buf.subarray(i, i + len).toString('utf8');
  return s.replace(/￼/g, '').trim();
}
