import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { BaseConnector } from './base.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import { openExternal } from '../platform.js';
import { chatId as chatIdOf, type Attachment } from '../model.js';
import { normalizePhone as normalizeContactPhone } from '../contacts-mac.js';

const execFileP = promisify(execFile);

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
  /** 0 bilinen, 1 bilinmeyen gönderen, 2 istenmeyen ("(filtered)"), 4 filtrelenen SMS ("(smsft)") */
  is_filtered: number | null;
  /** Mesajlar'da "Son Silinenler"e taşınmışsa geri çekilme zamanı */
  date_retracted: number | null;
  /** 0 normal mesaj; 2000-2007 tapback (beğendi/güldü…), 3000+ tapback geri alma, 1000 çıkartma/uygulama eki */
  associated_message_type: number | null;
}

interface AttRow {
  rowid: number;
  /** "~/Library/Messages/Attachments/…" (iCloud'a taşınmışsa dosya yerelde olmayabilir) */
  filename: string | null;
  mime_type: string | null;
  total_bytes: number | null;
  transfer_name: string | null;
  uti: string | null;
  hide_attachment: number | null;
}

/** SELECT + JOIN gövdesi: mesaj + sohbet + gönderen (WHERE/ORDER dışarıdan eklenir) */
const SELECT_ROWS = (retractedCol: string, filteredCol: string, assocCol: string) =>
  `SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.date, m.is_from_me, m.cache_has_attachments, m.item_type,
          ${retractedCol} AS date_retracted, ${assocCol} AS associated_message_type,
          h.id AS handle, c.chat_identifier, c.guid AS chat_guid, c.display_name, ${filteredCol} AS is_filtered
     FROM message m
     JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
     JOIN chat c ON c.ROWID = cmj.chat_id
     LEFT JOIN handle h ON h.ROWID = m.handle_id`;

/** Mesajlar uygulamasındaki klasör: chat.is_filtered değerinden */
export function imessageFolder(isFiltered: number | null | undefined): 'unknown' | 'junk' | 'sms' | undefined {
  // chat.db: 1 bilinmeyen gönderen, 2 istenmeyen ("(filtered)"), 4 işlem/promosyon SMS ("(smsft)") → bilinmeyen
  if (isFiltered === 1 || isFiltered === 4) return 'unknown';
  if (isFiltered === 2) return 'junk';
  return undefined;
}

/** Tapback (❤️ 👍 😂 …), tapback geri alma ve benzeri "bir mesaja bağlı" satırlar sohbette ayrı mesaj olarak görünmez */
export function isAssociatedReaction(t: number | null | undefined): boolean {
  return !!t && t >= 2000 && t < 4000;
}

/** Rehber eşlemesi için anahtarlar: +90… biçimi ve son 10 hane (rehberde "0532…", "532…", "+90 532…" farklı yazılabiliyor) */
export function phoneKeys(p: string): string[] {
  if (p.includes('@')) return [p.trim().toLowerCase()];
  const digits = p.replace(/\D/g, '');
  if (digits.length < 5) return [];
  const keys = [normalizeContactPhone(p)];
  if (digits.length >= 10) keys.push('#' + digits.slice(-10));
  return keys;
}

export class IMessageConnector extends BaseConnector {
  private db?: Database.Database;
  private timer?: NodeJS.Timeout;
  private lastRowId = 0;
  private names = new Map<string, string>();
  private retractedCol = 'NULL';
  private filteredCol = 'NULL';
  private assocCol = 'NULL';
  private retractAt = Date.now();
  private unreadAt = 0;
  /** message.date nanosaniye mi (macOS 10.13+; eski sürümlerde saniye) */
  private dateNs = true;
  /** Tarih sıralama/filtre sütunu: chat_message_join.message_date (indeksli); eski macOS'ta sütun yoksa m.date */
  private dateCol = 'cmj.message_date';
  private attStmt?: Database.Statement;

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
      // eski macOS sürümlerinde date_retracted / is_filtered sütunları olmayabilir
      const mcols = new Set((this.db.prepare('PRAGMA table_info(message)').all() as Array<{ name: string }>).map((c) => c.name));
      const ccols = new Set((this.db.prepare('PRAGMA table_info(chat)').all() as Array<{ name: string }>).map((c) => c.name));
      this.retractedCol = mcols.has('date_retracted') ? 'm.date_retracted' : 'NULL';
      this.filteredCol = ccols.has('is_filtered') ? 'c.is_filtered' : 'NULL';
      this.assocCol = mcols.has('associated_message_type') ? 'm.associated_message_type' : 'NULL';
      const jcols = new Set((this.db.prepare('PRAGMA table_info(chat_message_join)').all() as Array<{ name: string }>).map((c) => c.name));
      this.dateCol = jcols.has('message_date') ? 'cmj.message_date' : 'm.date';
      this.attStmt = this.db.prepare(
        `SELECT a.ROWID AS rowid, a.filename, a.mime_type, a.total_bytes, a.transfer_name, a.uti, a.hide_attachment
           FROM message_attachment_join j JOIN attachment a ON a.ROWID = j.attachment_id WHERE j.message_id = ? ORDER BY a.ROWID`,
      );
      // Tanı: chat.db'deki en yeni mesaj. Mac'in Mesajlar uygulamasına yeni mesaj düşmüyorsa Mivelo da gösteremez;
      // bu durum kodda değil, iPhone ↔ Mac eşitlemesinde (Metin Mesajı Yönlendirme / iCloud'da Mesajlar) çözülür.
      const newest = (this.db.prepare('SELECT MAX(date) AS d FROM message').get() as { d: number | null }).d ?? 0;
      this.dateNs = newest > 1e12;
      if (newest > 0) {
        const newestMs = this.appleToMs(newest);
        const days = Math.floor((Date.now() - newestMs) / 86_400_000);
        bus.log('info', `iMessage: chat.db'deki en yeni mesaj ${new Date(newestMs).toLocaleString('tr-TR')}`);
        if (days >= 3)
          bus.log(
            'warn',
            `iMessage: Bu Mac’in Mesajlar uygulamasına ${days} gündür yeni mesaj gelmemiş; Mivelo yalnızca chat.db’de olanı gösterebilir. iPhone’da Ayarlar → Mesajlar → Metin Mesajı Yönlendirme’de bu Mac’i aç ve Mac’te Mesajlar → Ayarlar → iMessage → “iCloud’da Mesajlar”ı etkinleştirip “Şimdi Eşzamanla” de.`,
          );
      }
    } catch (e) {
      // Sistem Ayarları → Gizlilik ve Güvenlik → Tam Disk Erişimi bölmesini doğrudan aç
      openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
      bus.log('error', `iMessage: chat.db açılamadı (${(e as Error).message}); Mivelo’da görünen iMessage verisi son başarılı okumadan kalma, yeni mesajlar gelmez`);
      this.setStatus(
        'error',
        'Tam Disk Erişimi gerekli — açılan Sistem Ayarları penceresinde listeye Mivelo’yu (geliştirme modunda Terminal’i) ekleyip anahtarı aç, sonra “Yeniden dene” de',
      );
      return;
    }
    this.account.label = os.userInfo().username;
    this.setStatus('connected');
    this.loadContacts();
    this.backfill();
    this.syncUnread();
    this.scanRecoverable();
    this.watchDb();
    // yedek yoklama: FSEvents olay kaçırabilir (uyku, kopya disk) — izleyici varken 15 sn, yoksa eskisi gibi 3 sn
    this.timer = setInterval(() => this.poll(), this.watcher ? 15_000 : 3000);
  }

  private watcher?: fs.FSWatcher;
  private watchDebounce?: NodeJS.Timeout;
  /**
   * Anlık algılama (BlueBubbles, mautrix-imessage): Messages klasörü izlenir; chat.db / chat.db-wal değişince 150 ms sonra
   * yalnız yeni satırlar okunur. Dosya değil klasör izlenir: WAL denetim noktasında kısaltılıp yeniden oluşturulunca dosya
   * izleyicisi kopabiliyor. Mac boştayken hiç SQLite sorgusu yapılmaz.
   */
  private watchDb(): void {
    try {
      this.watcher?.close();
      this.watcher = fs.watch(path.dirname(DB), { persistent: false }, (_ev, name) => {
        if (name && !String(name).startsWith('chat.db')) return;
        if (this.watchDebounce) clearTimeout(this.watchDebounce);
        this.watchDebounce = setTimeout(() => this.poll(), 150);
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      this.watcher = undefined; // izlenemiyor: 3 sn'lik yoklama
    }
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    if (this.timer) clearInterval(this.timer);
    this.db?.close();
    this.db = undefined;
    this.setStatus('disconnected');
  }

  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    await this.deliver(remoteChatId, { text });
    const id = `local-${Date.now()}`;
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'sent' });
    return { remoteId: id };
  }

  /**
   * Dosya gönder: `send POSIX file "…" to chat id "…"`. Mesajlar dosyayı gönderim anında okur; çekirdeğin outbox dosyası
   * 10 dk sonra silindiğinden önce oturum klasörüne kopyalanır (im-out:<ad> vekili sohbette gösterir). Mesajlar metin+dosyayı
   * tek iletide gönderemez: altyazı ayrı metin olarak gider. Yoklama aynı iletiyi guid ile getirince yerel kayıtlar düşer
   * (ek satırının metni boş → yerel ek kaydının metni de boş tutulur ki dropLocalDuplicates eşleştirsin).
   */
  async sendMedia(remoteChatId: string, file: { path: string; name: string; mime: string; size: number }, caption?: string): Promise<{ remoteId: string }> {
    if (!fs.existsSync(file.path)) throw new Error('Gönderilecek dosya bulunamadı');
    const dir = path.join(sessionDir(this.account.id), 'media');
    fs.mkdirSync(dir, { recursive: true });
    const local = `out-${Date.now()}-${path.basename(file.name).replace(/[^\w.\-çğıöşüÇĞİÖŞÜ ]+/g, '_')}`;
    const copy = path.join(dir, local);
    fs.copyFileSync(file.path, copy);
    fs.writeFileSync(copy + '.type', file.mime || mimeFromName(file.name));
    await this.deliver(remoteChatId, { file: copy });
    // Altyazı hemen ardından sendText ile gider; aynı milisaniyede aynı "local-<ts>" kimliği üretilmesin
    const id = `local-${Date.now()}f`;
    const proxied = `${this.mediaBase()}${encodeURIComponent('im-out:' + local)}`;
    const kind = attachmentKind(file.mime, file.name);
    this.upsertMessage({
      remoteChatId,
      remoteId: id,
      senderId: 'me',
      senderName: 'Ben',
      fromMe: true,
      text: '',
      ts: Date.now(),
      status: 'sent',
      attachments: [{ kind, name: file.name, mime: file.mime, size: file.size, ...(kind === 'image' ? { url: proxied, link: proxied } : { link: proxied }) }],
    });
    if (caption) await this.sendText(remoteChatId, caption);
    return { remoteId: id };
  }

  /** remoteChatId = chat_guid (ör. "iMessage;-;+905xxxxxxxxx", "iMessage;+;chat1234…"; macOS 26: "any;-;+905…" — hizmet chat.service_name'de) */
  private async deliver(remoteChatId: string, payload: { text: string } | { file: string }): Promise<void> {
    const isGroup = remoteChatId.includes(';+;');
    let service: 'SMS' | 'iMessage' = remoteChatId.startsWith('SMS;') ? 'SMS' : 'iMessage';
    try {
      const r = this.db?.prepare('SELECT service_name AS s FROM chat WHERE guid = ?').get(remoteChatId) as { s: string | null } | undefined;
      if (r?.s === 'SMS' || r?.s === 'RCS') service = 'SMS';
    } catch {
      /* eski şema */
    }
    // Mesajlar korumalı alanda: macOS 12+ rastgele yoldaki dosyayı sessizce göndermeyebilir → ~/Library/Messages/Attachments/Mivelo
    // altına kopyalanır (BlueBubbles), 5 dk sonra silinir (Mesajlar kendi kopyasını almış olur)
    let staged: string | undefined;
    if ('file' in payload && process.platform === 'darwin') {
      try {
        const dir = path.join(os.homedir(), 'Library', 'Messages', 'Attachments', 'Mivelo');
        fs.mkdirSync(dir, { recursive: true });
        staged = path.join(dir, `${Date.now()}-${path.basename(payload.file)}`);
        fs.copyFileSync(payload.file, staged);
        payload = { file: staged };
      } catch {
        staged = undefined; // kopyalanamadı: özgün yol denenir
      }
    }
    const { byChat, byChatSvc, byBuddy } = imessageScripts(remoteChatId, payload, service);
    const run = (script: string) =>
      new Promise<void>((resolve, reject) => {
        execFile('osascript', ['-e', script], { timeout: 45_000 }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
      });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      // Sıra (mautrix-imessage + BlueBubbles): 1) sohbet kimliği (guid) — hizmeti Mesajlar seçer; 2) -1728'de 1 sn bekleyip
      // sohbet kimliği hizmet üzerinden; 3) birebirde kişi + hizmet. Zaman aşımı/-1002'de Mesajlar yeniden başlatılıp bir kez daha.
      try {
        await run(byChat);
      } catch (e) {
        const msg = (e as Error).message;
        if (/timed out|-1712|1002|ETIMEDOUT|killed/i.test(msg)) {
          bus.log('warn', 'iMessage: Mesajlar yanıt vermedi, yeniden başlatılıp tekrar deneniyor');
          await run('tell application "Messages" to quit').catch(() => undefined);
          await sleep(3000);
          await run('tell application "Messages" to launch').catch(() => undefined);
          await sleep(2000);
          await run(byChat);
          return;
        }
        await sleep(1000);
        try {
          await run(byChatSvc);
        } catch (e2) {
          if (isGroup) throw e2;
          await run(byBuddy);
        }
      }
    } finally {
      if (staged) setTimeout(() => fs.rm(staged!, { force: true }, () => undefined), 5 * 60_000).unref?.();
    }
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
        try {
          // Telefon ve e-posta ayrı sorgulanır (ikisi birden LEFT JOIN'lenince satırlar çarpılıyordu); ad yoksa kurum adı
          const phones = ab
            .prepare(`SELECT r.ZFIRSTNAME AS f, r.ZLASTNAME AS l, r.ZORGANIZATION AS o, p.ZFULLNUMBER AS v FROM ZABCDRECORD r JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK`)
            .all() as Array<{ f: string | null; l: string | null; o: string | null; v: string | null }>;
          const emails = ab
            .prepare(`SELECT r.ZFIRSTNAME AS f, r.ZLASTNAME AS l, r.ZORGANIZATION AS o, e.ZADDRESS AS v FROM ZABCDRECORD r JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK`)
            .all() as Array<{ f: string | null; l: string | null; o: string | null; v: string | null }>;
          for (const r of [...phones, ...emails]) {
            const name = [r.f, r.l].filter(Boolean).join(' ').trim() || (r.o ?? '').trim();
            if (!name || !r.v) continue;
            for (const k of phoneKeys(r.v)) if (!this.names.has(k)) this.names.set(k, name);
          }
        } finally {
          ab.close();
        }
      }
    } catch {
      /* rehber okunamadı; numaralar gösterilir */
    }
  }

  private nameOf(handle: string | null, display: string | null, chatId: string): string {
    if (display) return display;
    if (handle) {
      for (const k of phoneKeys(handle)) {
        const n = this.names.get(k);
        if (n) return n;
      }
      return handle;
    }
    return chatId;
  }

  private get selectSql(): string {
    return SELECT_ROWS(this.retractedCol, this.filteredCol, this.assocCol);
  }

  private appleToMs(d: number): number {
    return d > 1e12 ? Math.floor(d / 1e6) + APPLE_EPOCH_MS : d * 1000 + APPLE_EPOCH_MS;
  }

  /** ms → chat.db tarih değeri. ns değerleri 2^53'ü aştığından BigInt ile tam sayı olarak bağlanır (double'da ~100 ns sapma olurdu). */
  private msToApple(ms: number): number | bigint {
    const rel = Math.floor(ms - APPLE_EPOCH_MS);
    return this.dateNs ? BigInt(rel) * 1_000_000n : Math.floor(rel / 1000);
  }

  private query(afterRowId: number, limit: number, onlyRetracted = false): Row[] {
    return this.db!
      .prepare(`${this.selectSql} WHERE m.ROWID > ? ${onlyRetracted ? `AND ${this.retractedCol} > 0` : ''} ORDER BY m.ROWID ASC LIMIT ?`)
      .all(afterRowId, limit) as Row[];
  }

  /** Sohbetin `before`'dan (ms) eski mesajlarını chat.db'den getir; eşitleme mesajı olduğundan live=false. */
  async loadHistory(remoteChatId: string, limit = 50, before?: number): Promise<void> {
    if (!this.db) return;
    const cap = Math.min(500, Math.max(1, limit));
    const d = this.dateCol;
    let rows = (
      before
        ? this.db.prepare(`${this.selectSql} WHERE c.guid = ? AND ${d} < ? ORDER BY ${d} DESC LIMIT ?`).all(remoteChatId, this.msToApple(before), cap)
        : this.db.prepare(`${this.selectSql} WHERE c.guid = ? ORDER BY ${d} DESC LIMIT ?`).all(remoteChatId, cap)
    ) as Row[];
    // Eski sürümün ROWID'ye göre açılış geçmişi bazı sohbetlerde en eski mesajları yüklemişti; en yeni ile en eski yüklü
    // arasında boşluk kalmış olabilir. "before"dan eski mesaj kalmadıysa Mivelo'da henüz olmayan (aradaki) mesajları
    // yeniden eskiye doğru doldur.
    if (!rows.length && before) {
      const all = this.db.prepare(`${this.selectSql} WHERE c.guid = ? ORDER BY ${d} DESC`).iterate(remoteChatId) as IterableIterator<Row>;
      rows = [];
      for (const r of all) {
        if (this.hasMessage(remoteChatId, r.guid)) continue;
        rows.push(r);
        if (rows.length >= cap) break;
      }
    }
    this.store.transaction(() => rows.reverse().forEach((r) => this.ingest(r, false)));
    bus.log('info', `iMessage geçmişi (${remoteChatId}): ${rows.length} eski mesaj yüklendi`);
  }

  private mediaBase(): string {
    return `/api/media/${encodeURIComponent(this.account.id)}?u=`;
  }

  /** Mesajın ekleri: message_attachment_join → attachment. Dosya yerelde yoksa (iCloud'a taşınmış) bağlantı verilmez. */
  private attachmentsOf(r: Row): Attachment[] | undefined {
    if (!r.cache_has_attachments) return undefined;
    let rows: AttRow[] = [];
    try {
      rows = (this.attStmt?.all(r.rowid) ?? []) as AttRow[];
    } catch (e) {
      bus.log('warn', `iMessage ek sorgusu: ${(e as Error).message}`);
    }
    const out: Attachment[] = [];
    for (const a of rows) {
      if (a.hide_attachment) continue;
      const name = a.transfer_name || (a.filename ? path.basename(a.filename) : 'ek');
      if (/\.pluginPayloadAttachment$/i.test(name)) continue; // iMessage uygulama yükü (bağlantı önizlemesi vb.); bağlantı metinde
      const mime = a.mime_type || mimeFromName(name);
      const kind = attachmentKind(mime, name);
      const file = expandHome(a.filename);
      const present = !!file && fs.existsSync(file);
      const proxied = present ? `${this.mediaBase()}im:${a.rowid}` : undefined;
      out.push({
        kind,
        name: present ? name : `${name} (iCloud’dan indirilmemiş)`,
        mime,
        size: a.total_bytes || undefined,
        ...(proxied ? (kind === 'image' ? { url: proxied, link: proxied } : { link: proxied }) : {}),
      });
    }
    if (out.length) return out;
    return rows.length ? undefined : [{ kind: 'other', name: 'ek' }];
  }

  /**
   * u = "im:<attachment ROWID>": dosyayı ~/Library/Messages/Attachments'tan okur.
   * HEIC → JPEG (sips), caf/amr/aiff sesler → mp3 (ffmpeg varsa); dönüştürülenler oturum klasöründe önbelleklenir.
   */
  async fetchMedia(u: string): Promise<{ body: Buffer; type: string } | undefined> {
    // "im-out:<ad>": Mivelo'dan gönderilen dosyanın oturum klasöründeki kopyası (yoklama gerçek eki getirene dek)
    const out = u.match(/^im-out:(.+)$/);
    if (out) {
      const file = path.join(sessionDir(this.account.id), 'media', path.basename(out[1]));
      if (!fs.existsSync(file)) throw new Error('gönderilen dosya kopyası yok');
      const type = fs.existsSync(file + '.type') ? fs.readFileSync(file + '.type', 'utf8') : mimeFromName(file);
      return { body: fs.readFileSync(file), type };
    }
    const m = u.match(/^im:(\d+)$/);
    if (!m) throw new Error('geçersiz iMessage medya adresi');
    if (!this.db) throw new Error('chat.db açık değil');
    const a = this.db
      .prepare('SELECT ROWID AS rowid, filename, mime_type, total_bytes, transfer_name, uti, hide_attachment FROM attachment WHERE ROWID = ?')
      .get(Number(m[1])) as AttRow | undefined;
    const file = expandHome(a?.filename ?? null);
    if (!a || !file) throw new Error('ek kaydı yok');
    if (!fs.existsSync(file)) throw new Error('Ek dosyası bu Mac’te yok (Mesajlar’da sohbeti açınca iCloud’dan iner)');
    const name = a.transfer_name || path.basename(file);
    const mime = (a.mime_type || mimeFromName(name)).split(';')[0];
    const ext = path.extname(file).toLowerCase();
    const cacheDir = path.join(sessionDir(this.account.id), 'media');
    fs.mkdirSync(cacheDir, { recursive: true });
    if (/hei[cf]/i.test(mime) || ext === '.heic' || ext === '.heif') {
      const out = path.join(cacheDir, `im-${a.rowid}.jpg`);
      if (!fs.existsSync(out)) {
        try {
          await execFileP('sips', ['-s', 'format', 'jpeg', file, '--out', out]);
        } catch (e) {
          fs.rmSync(out, { force: true }); // yarım kalmış çıktı önbellekte kalmasın
          throw new Error(`HEIC dönüşümü başarısız: ${(e as Error).message.split('\n')[0]}`);
        }
      }
      return { body: fs.readFileSync(out), type: 'image/jpeg' };
    }
    if (attachmentKind(mime, name) === 'audio' && !/mpeg|mp3|mp4|m4a|aac|wav|x-wav/i.test(mime)) {
      const out = path.join(cacheDir, `im-${a.rowid}.mp3`);
      if (fs.existsSync(out)) return { body: fs.readFileSync(out), type: 'audio/mpeg' };
      if (await transcodeToMp3(file, out)) return { body: fs.readFileSync(out), type: 'audio/mpeg' };
    }
    return { body: fs.readFileSync(file), type: mime };
  }

  /** Okunmamış sayıları Mesajlar'ın kendi bayrağından (is_read) al */
  private syncUnread(): void {
    if (!this.db) return;
    try {
      const rows = this.db
        .prepare(
          `SELECT c.guid AS guid, COUNT(*) AS n FROM message m
             JOIN chat_message_join j ON j.message_id = m.ROWID JOIN chat c ON c.ROWID = j.chat_id
            WHERE m.is_from_me = 0 AND m.is_read = 0 AND m.item_type = 0 AND COALESCE(${this.assocCol}, 0) NOT BETWEEN 2000 AND 3999 GROUP BY c.guid`,
        )
        .all() as Array<{ guid: string; n: number }>;
      const counts = new Map(rows.map((r) => [r.guid, r.n]));
      for (const chat of this.store.listChatsOf(this.account.id)) {
        const n = counts.get(chat.remoteId) ?? 0;
        if (n !== chat.unread) this.upsertChat({ remoteId: chat.remoteId, name: chat.name, unread: n });
      }
    } catch (e) {
      bus.log('warn', `iMessage okunmamış sayımı: ${(e as Error).message}`);
    }
  }

  /** Sonradan "Son Silinenler"e taşınan mesajlar ROWID'siyle yeniden gelmez; ara sıra tarayıp işaretle. */
  /** Mesajlar → Son Silinenler: chat_recoverable_message_join (ileti chat_message_join'dan çıkarılır, orada durur) */
  private scanRecoverable(): void {
    if (!this.db) return;
    try {
      const rows = this.db
        .prepare(
          `SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.date, m.is_from_me, m.cache_has_attachments, m.item_type,
                  1 AS date_retracted, ${this.assocCol} AS associated_message_type, h.id AS handle, c.chat_identifier, c.guid AS chat_guid, c.display_name,
                  ${this.filteredCol} AS is_filtered
             FROM chat_recoverable_message_join j JOIN message m ON m.ROWID = j.message_id JOIN chat c ON c.ROWID = j.chat_id
             LEFT JOIN handle h ON h.ROWID = m.handle_id`,
        )
        .all() as Row[];
      for (const r of rows) this.ingest(r, false);
      // Son Silinenler'den geri alınan / kalıcı silinen mesajların sohbeti artık "silinmiş" klasöründe görünmesin
      const still = new Set(rows.map((r) => r.chat_guid));
      for (const chat of this.store.listChatsOf(this.account.id)) {
        if (!chat.meta?.deleted || still.has(chat.remoteId)) continue;
        const { deleted: _d, ...meta } = chat.meta;
        this.upsertChat({ remoteId: chat.remoteId, name: chat.name, meta });
      }
      if (rows.length) bus.log('info', `iMessage: son silinenlerde ${rows.length} mesaj`);
    } catch {
      /* tablo yok (eski macOS) */
    }
  }

  private rescanRetracted(): void {
    this.scanRecoverable();
    if (this.retractedCol === 'NULL' || !this.db) return;
    for (const r of this.query(Math.max(0, this.lastRowId - 5000), 500, true)) this.ingest(r, false);
  }

  private backfill(): void {
    if (!this.db) return;
    const t0 = Date.now();
    const max = (this.db.prepare('SELECT MAX(ROWID) AS m FROM message').get() as { m: number | null }).m ?? 0;
    // Tarihe göre en yeni 2000 mesaj. ROWID sırası tarih sırası DEĞİL: iCloud eşitlemesi eski sohbetleri yeni ROWID'lerle
    // (yeniden eskiye) yazar; ROWID'ye göre alınsaydı bazı sohbetlerin en eski mesajları "son mesaj" sanılırdı.
    // cmj.message_date = m.date (indeksli), sıralama bu sütunla ucuz.
    const rows = (this.db.prepare(`${this.selectSql} ORDER BY ${this.dateCol} DESC LIMIT 2000`).all() as Row[]).reverse();
    this.store.transaction(() => rows.forEach((r) => this.ingest(r, false)));
    this.lastRowId = max;
    const oldest = rows[0]?.date ?? 0;
    // Bu 2000'in dışında kalan sohbetler (eski, filtrelenmiş SMS'ler, bilinmeyen gönderenler…) de son 20 mesajıyla gelsin —
    // klasör bilgisi (is_filtered) ancak mesajla birlikte öğreniliyor
    let extra = 0;
    try {
      // Mesajı olan tüm sohbetler (eskiden ROWID'ye göre ilk 1500 → ~400 eski sohbet hiç görünmüyordu)
      const chatRows = this.db.prepare('SELECT DISTINCT chat_id AS id FROM chat_message_join').all() as Array<{ id: number }>;
      const perChat = this.db.prepare(`${this.selectSql} WHERE cmj.chat_id = ? AND ${this.dateCol} < ? ORDER BY ${this.dateCol} DESC LIMIT 20`);
      this.store.transaction(() => {
        for (const c of chatRows) for (const r of (perChat.all(c.id, oldest) as Row[]).reverse()) {
          this.ingest(r, false);
          extra++;
        }
      });
    } catch (e) {
      bus.log('warn', `iMessage sohbet geçmişi: ${(e as Error).message}`);
    }
    bus.log('info', `iMessage geçmişi: ${rows.length} mesaj + ${extra} eski sohbet mesajı yüklendi (${Date.now() - t0} ms)`);
    try {
      const newest = (this.db.prepare('SELECT MAX(date) AS d FROM message').get() as { d: number | null }).d ?? 0;
      const ms = newest > 1e12 ? Math.floor(newest / 1e6) + APPLE_EPOCH_MS : newest * 1000 + APPLE_EPOCH_MS;
      if (ms && Date.now() - ms > 7 * 86400e3) {
        const days = Math.round((Date.now() - ms) / 86400e3);
        this.setStatus('connected', `Mesajlar uygulamasına ${days} gündür yeni mesaj düşmüyor — iPhone: Ayarlar → Mesajlar → Metin Mesajı Yönlendirme'de bu Mac'i aç; Mac: Mesajlar → Ayarlar → iMessage → iCloud'da Mesajlar → Şimdi Eşzamanla`);
      }
    } catch {
      /* tarih okunamadı */
    }
  }

  private poll(): void {
    if (!this.db) return;
    try {
      const rows = this.query(this.lastRowId, 200);
      for (const r of rows) {
        // iCloud eşitlemesi eski mesajları da yeni ROWID'lerle düşürür: yalnızca gerçekten yeni (son 10 dk) olanlar canlı
        // sayılsın; eskiler bildirim çalmadan, okunmamış sayacını oynatmadan yazılsın (sayaç syncUnread ile is_read'den gelir).
        const live = Date.now() - this.appleToMs(r.date) < 10 * 60_000;
        this.ingest(r, live);
        this.lastRowId = Math.max(this.lastRowId, r.rowid);
      }
      // zamana bağlı işler (yoklama artık olayla da tetikleniyor, tur sayısı süre ölçmez)
      const now = Date.now();
      if (now - this.retractAt >= 60_000) {
        this.retractAt = now;
        this.rescanRetracted();
      }
      if (now - this.unreadAt >= 5_000) {
        this.unreadAt = now; // telefonda okununca burada da düşer
        this.syncUnread();
      }
    } catch (e) {
      bus.log('warn', `iMessage yoklama: ${(e as Error).message}`);
    }
  }

  private ingest(r: Row, live: boolean): void {
    if (r.item_type !== 0) return; // grup olayları, isim değişiklikleri vb.
    if (isAssociatedReaction(r.associated_message_type)) return; // tapback: ayrı mesaj değil
    // U+FFFC: ekin metindeki yer tutucusu
    let text = (r.text ?? '').replace(/\uFFFC/g, '').trim() || decodeAttributedBody(r.attributedBody);
    const attachments = this.attachmentsOf(r);
    if (!text && !attachments) return;
    const deleted = !!r.date_retracted;
    if (deleted) text = `🗑 ${text || '(ek)'}`; // Mesajlar → Son Silinenler
    const isGroup = r.chat_identifier.startsWith('chat');
    // chat_identifier filtrelenmiş sohbetlerde "+90…(smsft)" / "(filtered)" ekiyle gelir; ad/numara eşlemesinde ek atılır
    const ident = r.chat_identifier.replace(/\((filtered|smsft)\)$/, '');
    const chatName = this.nameOf(isGroup ? null : r.handle ?? ident, r.display_name, ident);
    const folder = imessageFolder(r.is_filtered);
    const existing = this.store.getChat(chatIdOf(this.account.id, r.chat_guid));
    // Klasör her seferinde chat.is_filtered'dan yeniden yazılır: bilinen kişiye taşınan sohbet (0) ve eski sürümün "sms" değeri silinir
    const { folder: _oldFolder, ...rest } = existing?.meta ?? {};
    const meta: Record<string, unknown> = { ...rest, ...(folder ? { folder } : {}), ...(deleted ? { deleted: true } : {}) };
    // Ad da karşılaştırılır: rehber eşlemesi iyileşince (0532… ↔ +90532…) eski sohbetler de isimlensin
    if (!existing || existing.name !== chatName || JSON.stringify(meta) !== JSON.stringify(existing.meta ?? {}))
      this.upsertChat({ remoteId: r.chat_guid, name: chatName, kind: isGroup ? 'group' : 'direct', meta });
    const ms = this.appleToMs(r.date);
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

/**
 * Mesajlar AppleScript'leri: byChat mevcut sohbete (chat id = guid), byBuddy kişi + hizmet yoluyla (eski macOS yedeği).
 * Metin ya da POSIX dosya yolu gönderilir; tırnak ve ters bölü kaçırılır.
 */
export function imessageScripts(remoteChatId: string, payload: { text: string } | { file: string }, service: 'SMS' | 'iMessage'): { byChat: string; byChatSvc: string; byBuddy: string } {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const what = 'file' in payload ? `POSIX file "${esc(payload.file)}"` : `"${esc(payload.text)}"`;
  // dosya: Mesajlar gönderimi eşzamansız başlatır; betik hemen biterse dosya kopyalanmadan temizlenebilir (BlueBubbles "delay 1")
  const after = 'file' in payload ? '\n delay 1' : '';
  const byChat = `tell application "Messages"\n send ${what} to chat id "${esc(remoteChatId)}"${after}\nend tell`;
  // mautrix-imessage: -1728 ("Can't get chat id") sonrası sohbet hizmet üzerinden de aranır
  const byChatSvc = `tell application "Messages"\n set svc to 1st account whose service type = ${service}\n send ${what} to chat id "${esc(remoteChatId)}" of svc${after}\nend tell`;
  const byBuddy = `tell application "Messages"\n set svc to 1st account whose service type = ${service}\n set tgt to participant "${esc(remoteChatId.split(';').pop() ?? '')}" of svc\n send ${what} to tgt${after}\nend tell`;
  return { byChat, byChatSvc, byBuddy };
}

function expandHome(p: string | null): string | undefined {
  if (!p) return undefined;
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', tiff: 'image/tiff', bmp: 'image/bmp',
  mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v', '3gp': 'video/3gpp',
  caf: 'audio/x-caf', amr: 'audio/amr', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', aiff: 'audio/aiff', aac: 'audio/aac', opus: 'audio/opus',
  pdf: 'application/pdf', vcf: 'text/vcard', txt: 'text/plain', zip: 'application/zip',
};

function mimeFromName(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export function attachmentKind(mime: string, name: string): Attachment['kind'] {
  const m = mime.toLowerCase().split(';')[0].trim();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  // MIME bilinmiyorsa uzantıdan dene (ör. mime_type NULL + "foto.jpg" → image)
  const byExt = m && m !== 'application/octet-stream' ? m : mimeFromName(name);
  if (/^(image|video|audio)\//.test(byExt)) return byExt.split('/')[0] as Attachment['kind'];
  // pdf/vcf/zip gibi bilinen belge türleri ve uzantılı dosyalar "file"; hiçbir ipucu yoksa "other"
  return byExt !== 'application/octet-stream' || path.extname(name) ? 'file' : 'other';
}

let ffmpegOk: boolean | undefined;
/** caf/amr/aiff sesli mesajı mp3'e çevirir (WebKit caf/amr oynatmaz); ffmpeg yoksa false. */
async function transcodeToMp3(input: string, output: string): Promise<boolean> {
  if (ffmpegOk === undefined) {
    ffmpegOk = await execFileP('ffmpeg', ['-version']).then(() => true).catch(() => false);
    if (!ffmpegOk) bus.log('info', 'ffmpeg yok: iMessage sesli mesajları ham biçimde (caf/amr) sunulur; brew install ffmpeg ile mp3 dönüşümü açılır');
  }
  if (!ffmpegOk) return false;
  try {
    await execFileP('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, '-codec:a', 'libmp3lame', '-q:a', '4', output]);
    return fs.existsSync(output);
  } catch (e) {
    bus.log('warn', `iMessage ses dönüşümü: ${(e as Error).message.split('\n')[0]}`);
    fs.rmSync(output, { force: true });
    return false;
  }
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
