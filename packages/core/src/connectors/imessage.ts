import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { BaseConnector, type StartOptions } from './base.js';
import { bus } from '../bus.js';
import { sessionDir } from '../config.js';
import { openExternal } from '../platform.js';
import { chatId as chatIdOf, messageId as messageIdOf, type Attachment, type Message } from '../model.js';
import { trReactionText } from '../reaction-text.js';
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
  /** alındılar (yalnız benim mesajlarımda anlamlı): iletildi / okundu / okunma zamanı / gönderim hatası */
  is_delivered?: number | null;
  is_read?: number | null;
  date_read?: number | null;
  error?: number | null;
  handle: string | null;
  chat_identifier: string;
  chat_guid: string;
  display_name: string | null;
  cache_has_attachments: number;
  item_type: number;
  /** 0 bilinen, 1 bilinmeyen gönderen, 2 istenmeyen ("(filtered)"), 4 filtrelenen SMS ("(smsft)") */
  is_filtered: number | null;
  /** Gönderimi geri alma (Undo Send) zamanı; içerik boşaltılır, satır yerinde güncellenir (yeni ROWID yok) */
  date_retracted: number | null;
  /** Düzenleme zamanı (macOS 13+): metin yerinde değişir */
  date_edited?: number | null;
  /** Mesajlar → Son Silinenler (chat_recoverable_message_join) satırı */
  recoverable?: number | null;
  /** 0 normal mesaj; 2000-2007 tapback (beğendi/güldü…), 3000+ tapback geri alma, 1000 çıkartma/uygulama eki */
  associated_message_type: number | null;
  /** Tapback'in hedef mesajı: "p:0/<guid>" ya da "bp:<guid>" (eski şemada yok) */
  associated_message_guid?: string | null;
  /** macOS 14+: özel emoji tapback'i (tür 2006) */
  associated_message_emoji?: string | null;
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
const SELECT_ROWS = (retractedCol: string, filteredCol: string, assocCol: string, assocGuidCol = 'NULL', assocEmojiCol = 'NULL', editedCol = 'NULL') =>
  `SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.date, m.is_from_me, m.cache_has_attachments, m.item_type,
          m.is_delivered, m.is_read, m.date_read, m.error,
          ${retractedCol} AS date_retracted, ${editedCol} AS date_edited, ${assocCol} AS associated_message_type,
          ${assocGuidCol} AS associated_message_guid, ${assocEmojiCol} AS associated_message_emoji,
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

/** Kendi mesajımın durumu chat.db alındılarından: okundu (karşı tarafta okundu bilgisi açıksa) > iletildi > gönderildi; hata → başarısız */
export function imessageStatus(r: Pick<Row, 'is_delivered' | 'is_read' | 'date_read' | 'error'>): 'failed' | 'sent' | 'delivered' | 'read' {
  if (r.error) return 'failed';
  if ((r.date_read ?? 0) > 0 || r.is_read) return 'read';
  if (r.is_delivered) return 'delivered';
  return 'sent';
}

/** Tapback (❤️ 👍 😂 …), tapback geri alma ve benzeri "bir mesaja bağlı" satırlar sohbette ayrı mesaj olarak görünmez */
export function isAssociatedReaction(t: number | null | undefined): boolean {
  return !!t && t >= 2000 && t < 4000;
}

/** Tapback türü → emoji (2000 sevdi, 2001 beğendi, 2002 beğenmedi, 2003 güldü, 2004 vurguladı, 2005 soru, 2006 özel emoji, 2007 çıkartma) */
const TAPBACK_EMOJI = ['❤️', '👍', '👎', '😂', '‼️', '❓'];

/**
 * Tapback satırı → hedef mesaja tepki: {hedef guid, emoji, kaldırma mı}. 3000+ geri alma. Hedef "p:0/<guid>" (çok parçalı
 * mesajın parçası) ya da "bp:<guid>". Çözülemezse undefined (satır yine mesaj olarak gösterilmez).
 */
export function tapbackOf(r: Pick<Row, 'associated_message_type' | 'associated_message_guid' | 'associated_message_emoji'>): { target: string; emoji: string; remove: boolean } | undefined {
  const t = r.associated_message_type ?? 0;
  if (!isAssociatedReaction(t)) return undefined;
  const target = String(r.associated_message_guid ?? '').replace(/^(p:\d+\/|bp:)/, '');
  if (!target) return undefined;
  const kind = t % 1000;
  const emoji = kind === 6 ? String(r.associated_message_emoji ?? '').trim() : kind === 7 ? '🎨' : (TAPBACK_EMOJI[kind] ?? '');
  // geri almada emoji yoksa da kişinin tepkisi kaldırılır (kişi başına tek tapback)
  if (!emoji && t < 3000) return undefined;
  return { target, emoji: emoji || '❤️', remove: t >= 3000 };
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
  private editedCol = 'NULL';
  private filteredCol = 'NULL';
  private assocCol = 'NULL';
  private assocGuidCol = 'NULL';
  private assocEmojiCol = 'NULL';
  private retractAt = Date.now();
  private unreadAt = 0;
  private retractedLogged = -1;
  /** message.date nanosaniye mi (macOS 10.13+; eski sürümlerde saniye) */
  private dateNs = true;
  /** Tarih sıralama/filtre sütunu: chat_message_join.message_date (indeksli); eski macOS'ta sütun yoksa m.date */
  private dateCol = 'cmj.message_date';
  private attStmt?: Database.Statement;
  /** açılışta tamamı yüklenecek en çok mesaj (üstü: en yeniler + sohbet başına son 20) */
  private static readonly FULL_LIMIT = 60_000;

  /** stop() çağrıldı: dilimli açılış yüklemesi yarıda bırakılır */
  private stopped = false;

  async start(opts: StartOptions = {}): Promise<void> {
    this.stopped = false;
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
      this.editedCol = mcols.has('date_edited') ? 'm.date_edited' : 'NULL';
      this.filteredCol = ccols.has('is_filtered') ? 'c.is_filtered' : 'NULL';
      this.assocCol = mcols.has('associated_message_type') ? 'm.associated_message_type' : 'NULL';
      this.assocGuidCol = mcols.has('associated_message_guid') ? 'm.associated_message_guid' : 'NULL';
      this.assocEmojiCol = mcols.has('associated_message_emoji') ? 'm.associated_message_emoji' : 'NULL';
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
      // Sistem Ayarları → Gizlilik ve Güvenlik → Tam Disk Erişimi bölmesi yalnız kullanıcı istediğinde (Bağlan / Yeniden dene)
      // açılır; eskiden her açılışta kendiliğinden açılıyordu (izin artık ilk açılış kurulumunda baştan istenir)
      if (opts.interactive !== false) openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
      bus.log('error', `iMessage: chat.db açılamadı (${(e as Error).message}); Mivelo’da görünen iMessage verisi son başarılı okumadan kalma, yeni mesajlar gelmez`);
      // Arka plan servisi (launchd, `npm run autodeploy -- install`): izin Terminal'e değil doğrudan node ikilisine verilmeli
      let who = 'Mivelo’yu (geliştirme modunda Terminal’i)';
      if (process.env.XPC_SERVICE_NAME?.includes('mivelo') || !process.env.TERM_PROGRAM) {
        let node = process.execPath;
        try {
          node = fs.realpathSync(process.execPath);
        } catch {
          /* yol çözülemedi */
        }
        who = `şu dosyayı (+ düğmesi, ⌘⇧G ile yolu yapıştır): ${node}`;
      }
      this.setStatus('error', `Tam Disk Erişimi gerekli — açılan Sistem Ayarları penceresinde listeye ${who} ekleyip anahtarı aç, sonra “Yeniden dene” de`);
      return;
    }
    this.account.label = os.userInfo().username;
    this.setStatus('connected');
    this.loadContacts();
    await this.backfill();
    if (this.stopped) return;
    this.syncUnread();
    this.scanRecoverable();
    this.watchDb();
    // yedek yoklama: FSEvents olay kaçırabilir (uyku, kopya disk) — izleyici varken 15 sn, yoksa eskisi gibi 3 sn
    this.timer = setInterval(() => void this.poll(this.watcher ? 'yedek 15 sn' : 'yoklama 3 sn'), this.watcher ? 15_000 : 3000);
  }

  private watcher?: fs.FSWatcher;
  private watchDebounce?: NodeJS.Timeout;
  /** Bekleyen izleyici olaylarının ilki (ms): debounce'un üst sınırı için */
  private watchFirst = 0;
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
        // Üst sınırlı debounce: yazımlar 150 ms'den sık geldikçe (iCloud eşitlemesi) tur hiç çalışmıyor, canlı mesaj 15 sn'lik
        // yedeği bekliyordu → ilk olaydan en geç 1 sn sonra yoklanır
        if (!this.watchFirst) this.watchFirst = Date.now();
        const wait = Math.max(0, Math.min(150, 1000 - (Date.now() - this.watchFirst)));
        this.watchDebounce = setTimeout(() => {
          this.watchFirst = 0;
          void this.poll('izleyici');
        }, wait);
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
    this.stopped = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watchFirst = 0;
    if (this.timer) clearInterval(this.timer);
    this.pendingAtt.clear();
    this.db?.close();
    this.db = undefined;
    this.setStatus('disconnected');
  }

  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    const t0 = Date.now() - 200;
    await this.deliver(remoteChatId, { text });
    const id = `local-${Date.now()}`;
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'sent' });
    this.dropLocalIfIngested(remoteChatId, t0, { text });
    return { remoteId: id };
  }

  /**
   * Gerçek satır, osascript dönmeden (dosyada `delay 1`) yoklamayla gelip yazıldıysa o anda silinecek yerel kayıt yoktu;
   * sonradan yazılan "local-" kopya sohbette ikinci balon olarak kalıyordu. Gönderimden beri benden çıkan satır depoda varsa
   * yerel kopyalar şimdi düşürülür (yoksa her zamanki yol: gerçek satır gelince base.upsertMessage düşürür).
   */
  private dropLocalIfIngested(remoteChatId: string, sinceMs: number, payload: { text: string } | { file: string }): void {
    const cid = chatIdOf(this.account.id, remoteChatId);
    const guids = this.sentRowsSince(remoteChatId, sinceMs, payload);
    if (!guids.some((g) => this.store.hasMessage(messageIdOf(cid, g)))) return;
    for (const mid of this.store.dropLocalDuplicates(cid)) bus.emit({ type: 'message.delete', chatId: cid, messageId: mid });
  }

  /** chat.db'de bu sohbette `sinceMs`'ten beri benden çıkan satırlar (metinde aynı metin, dosyada ekli satır); guid listesi */
  private sentRowsSince(remoteChatId: string, sinceMs: number, payload: { text: string } | { file: string }): string[] {
    if (!this.db) return [];
    try {
      const isFile = 'file' in payload;
      const rows = this.db
        .prepare(
          `SELECT m.guid, m.text, m.attributedBody FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID JOIN chat c ON c.ROWID = cmj.chat_id
            WHERE c.guid = ? AND m.is_from_me = 1 AND m.date >= ? ${isFile ? 'AND m.cache_has_attachments = 1' : ''} ORDER BY m.ROWID`,
        )
        .all(remoteChatId, this.msToApple(sinceMs)) as Array<{ guid: string; text: string | null; attributedBody: Buffer | null }>;
      if (isFile) return rows.map((r) => r.guid);
      const want = payload.text.trim();
      return rows.filter((r) => ((r.text ?? '').replace(/\uFFFC/g, '').trim() || decodeAttributedBody(r.attributedBody)) === want).map((r) => r.guid);
    } catch {
      return []; // eski şema: denetlenemedi
    }
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
    const t0 = Date.now() - 200;
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
    this.dropLocalIfIngested(remoteChatId, t0, { file: copy });
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
    // AppleEvent zaman aşımı gönderimi İPTAL ETMEZ: Mesajlar kuyruktaki send'i yine yürütür. Yeniden denemeden önce chat.db'de
    // gitmiş mi bakılır (yoksa aynı mesaj/dosya iki kez gidiyordu). chat.db açık değilse (izin yok) eski davranış.
    const startMs = Date.now() - 200;
    const wentOut = () => this.sentRowsSince(remoteChatId, startMs, payload).length > 0;
    try {
      // Sıra (mautrix-imessage + BlueBubbles): 1) sohbet kimliği (guid) — hizmeti Mesajlar seçer; 2) -1728'de 1 sn bekleyip
      // sohbet kimliği hizmet üzerinden; 3) birebirde kişi + hizmet. Zaman aşımı/-1002'de Mesajlar yeniden başlatılıp bir kez daha.
      try {
        await run(byChat);
      } catch (e) {
        const msg = (e as Error).message;
        if (/timed out|-1712|1002|ETIMEDOUT|killed/i.test(msg)) {
          if (this.db) {
            for (let i = 0; i < 16; i++) {
              if (wentOut()) {
                bus.log('warn', 'iMessage: Mesajlar yanıtı gecikti ama mesaj gitmiş; yeniden gönderilmedi');
                return;
              }
              await sleep(500);
            }
          }
          bus.log('warn', 'iMessage: Mesajlar yanıt vermedi, yeniden başlatılıp tekrar deneniyor');
          await run('tell application "Messages" to quit').catch(() => undefined);
          await sleep(3000);
          await run('tell application "Messages" to launch').catch(() => undefined);
          await sleep(2000);
          try {
            await run(byChat);
          } catch (e3) {
            // ikinci deneme de zaman aşımına düştü ama gittiyse başarı say (zamanlanmış gönderimin yeniden denemesi çift göndermesin)
            if (this.db && wentOut()) return;
            throw e3;
          }
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
    return SELECT_ROWS(this.retractedCol, this.filteredCol, this.assocCol, this.assocGuidCol, this.assocEmojiCol, this.editedCol);
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
  private attachmentsOf(r: Row, onMissing?: () => void): Attachment[] | undefined {
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
      if (!present) onMissing?.();
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
  /** guid → son bilinen durum (değişmeyeni yeniden yazmamak için) */
  private receipts = new Map<string, string>();
  /** Son 3 günde gönderdiğim mesajların alındıları sonradan güncellenir (iletildi/okundu); yeni ROWID gelmediği için ayrıca bakılır */
  private syncReceipts(): void {
    if (!this.db) return;
    try {
      const since = this.msToApple(Date.now() - 3 * 86400e3);
      const rows = this.db
        .prepare(`SELECT m.guid, m.is_delivered, m.is_read, m.date_read, m.error, c.guid AS chat_guid FROM message m
                    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID JOIN chat c ON c.ROWID = cmj.chat_id
                   WHERE m.is_from_me = 1 AND ${this.dateCol} > ?`)
        .all(since) as Array<Pick<Row, 'guid' | 'is_delivered' | 'is_read' | 'date_read' | 'error' | 'chat_guid'>>;
      for (const r of rows) {
        const st = imessageStatus(r);
        if (this.receipts.get(r.guid) === st) continue;
        this.receipts.set(r.guid, st);
        const id = `${chatIdOf(this.account.id, r.chat_guid)}#${r.guid}`;
        const stored = this.store.getMessage(id);
        if (!stored || stored.status === st) continue;
        const RANK: Record<string, number> = { failed: -1, pending: 0, sent: 1, delivered: 2, read: 3 };
        if (st !== 'failed' && (RANK[st] ?? 0) < (RANK[stored.status] ?? 0)) continue;
        this.store.updateStatus(id, st);
        const chat = this.store.getChat(stored.chatId);
        if (chat) bus.emit({ type: 'message.upsert', message: { ...stored, status: st }, chat });
      }
      if (this.receipts.size > 5000) this.receipts.clear();
    } catch {
      /* eski şema: sütun yok */
    }
  }

  private syncUnread(): void {
    if (!this.db) return;
    try {
      // Satır satır (tarihli): Mivelo'da okunan sohbette (read_upto) Mesajlar'da is_read=0 kalan eski mesajlar sayılmaz. Eskiden
      // sohbet başına toplam sayılıyordu → yeni tek mesajda rozet eski okunmamışlarla şişiyor, yeni mesaj yokken de depo 0'a
      // zorladığı için her turda aynı sohbet yeniden yazılıp chat.upsert yayılıyordu.
      const rows = this.db
        .prepare(
          `SELECT c.guid AS guid, m.date AS date FROM message m
             JOIN chat_message_join j ON j.message_id = m.ROWID JOIN chat c ON c.ROWID = j.chat_id
            WHERE m.is_from_me = 0 AND m.is_read = 0 AND m.item_type = 0 AND COALESCE(${this.assocCol}, 0) NOT BETWEEN 2000 AND 3999`,
        )
        .all() as Array<{ guid: string; date: number }>;
      const byChat = new Map<string, number[]>();
      for (const r of rows) {
        let list = byChat.get(r.guid);
        if (!list) byChat.set(r.guid, (list = []));
        list.push(this.appleToMs(r.date));
      }
      for (const chat of this.store.listChatsOf(this.account.id)) {
        const upto = chat.readUpto ?? 0;
        let n = (byChat.get(chat.remoteId) ?? []).filter((ms) => ms > upto).length;
        if (upto && chat.lastMessageAt <= upto) n = 0; // depo da 0'a zorlar; saat kaymasında sonsuz yeniden yazım olmasın
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
                  m.is_delivered, m.is_read, m.date_read, m.error, ${this.retractedCol} AS date_retracted, ${this.editedCol} AS date_edited,
                  1 AS recoverable, ${this.assocCol} AS associated_message_type,
                  ${this.assocGuidCol} AS associated_message_guid, ${this.assocEmojiCol} AS associated_message_emoji, h.id AS handle, c.chat_identifier, c.guid AS chat_guid, c.display_name,
                  ${this.filteredCol} AS is_filtered
             FROM chat_recoverable_message_join j JOIN message m ON m.ROWID = j.message_id JOIN chat c ON c.ROWID = j.chat_id
             LEFT JOIN handle h ON h.ROWID = m.handle_id`,
        )
        .all() as Row[];
      // Yalnız henüz işlenmemişler yazılır: eskiden dakikada bir TÜM kurtarılabilir mesajlar işlemsiz yeniden yazılıyordu
      // (binlerce satırda ~0,5 sn kilit + satır başına chat.upsert). Tapback'ler yalnız ilk taramada uygulanır.
      const first = !this.recoverableScanned;
      this.recoverableScanned = true;
      const todo = rows.filter((r) => r.item_type === 0 && (isAssociatedReaction(r.associated_message_type) ? first : !this.retractedDone(r)));
      if (todo.length) this.store.transaction(() => todo.forEach((r) => this.ingest(r, false)));
      // Son Silinenler'den geri alınan / kalıcı silinen mesajların sohbeti artık "silinmiş" klasöründe görünmesin
      // (sohbet kümesi değişmediyse tüm sohbetlerin meta'sını dakikada bir yeniden çözmeye gerek yok)
      const still = new Set(rows.map((r) => r.chat_guid));
      const sig = [...still].sort().join('\n');
      if (sig !== this.recoverableSig || todo.length) for (const chat of this.store.listChatsOf(this.account.id)) {
        if (!chat.meta?.deleted || still.has(chat.remoteId)) continue;
        const { deleted: _d, ...meta } = chat.meta;
        this.upsertChat({ remoteId: chat.remoteId, name: chat.name, meta });
      }
      // yalnız sayı değişince yaz (dakikada bir aynı satır günlüğü dolduruyordu)
      this.recoverableSig = sig;
      if (rows.length && rows.length !== this.retractedLogged) bus.log('info', `iMessage: son silinenlerde ${rows.length} mesaj`);
      this.retractedLogged = rows.length;
    } catch {
      /* tablo yok (eski macOS) */
    }
  }

  private recoverableScanned = false;
  private recoverableSig?: string;

  /** Son Silinenler satırı daha önce işlendi mi (depoda 🗑 önekiyle ya da silinmiş olarak duruyor) */
  private retractedDone(r: Row): boolean {
    const m = this.store.getMessage(messageIdOf(chatIdOf(this.account.id, r.chat_guid), r.guid));
    return !!m && (m.deleted === true || m.text.startsWith('🗑'));
  }

  private rescanRetracted(): void {
    // Gönderimi geri alınan (date_retracted) mesajlar syncEdits ile işlenir; burada yalnız Son Silinenler
    this.scanRecoverable();
  }

  /** guid → son görülen "düzenleme|geri alma" zamanı (değişmeyeni yeniden işlememek için) */
  private editSeen = new Map<string, string>();
  /**
   * Düzenleme ve gönderimi geri alma (macOS 13+) satırı YERİNDE günceller, yeni ROWID gelmez; yoklama `ROWID > son` okuduğu için
   * yalnız yeniden başlatınca görünüyordu. Apple sınırları (düzenleme 15 dk, geri alma 2 dk) nedeniyle son 2 saatin mesajlarına
   * bakılır (message_date indeksli, ucuz).
   */
  private syncEdits(): void {
    if (!this.db || (this.editedCol === 'NULL' && this.retractedCol === 'NULL')) return;
    try {
      const since = this.msToApple(Date.now() - 2 * 3600e3);
      const rows = this.db
        .prepare(`${this.selectSql} WHERE ${this.dateCol} > ? AND (COALESCE(${this.editedCol}, 0) > 0 OR COALESCE(${this.retractedCol}, 0) > 0) ORDER BY m.ROWID LIMIT 500`)
        .all(since) as Row[];
      const todo: Row[] = [];
      for (const r of rows) {
        const sig = `${r.date_edited ?? 0}|${r.date_retracted ?? 0}`;
        if (this.editSeen.get(r.guid) === sig) continue;
        this.editSeen.set(r.guid, sig);
        todo.push(r);
      }
      if (todo.length) this.store.transaction(() => todo.forEach((r) => this.ingest(r, false)));
      if (this.editSeen.size > 5000) this.editSeen.clear();
    } catch (e) {
      bus.log('warn', `iMessage düzenleme taraması: ${(e as Error).message}`);
    }
  }

  /**
   * Satırları tek işlemli dilimlerle yaz (≤800 satır ya da ≈25 ms), aralarda olay döngüsünü bırak: 60 bin satırlık açılış
   * yüklemesi / iCloud birikmesi tek parça çalışınca çekirdek saniyelerce yanıt vermiyordu. stop() olursa false.
   */
  private async ingestChunked(rows: Row[], liveOf: (r: Row) => boolean = () => false): Promise<boolean> {
    let i = 0;
    while (i < rows.length) {
      if (this.stopped || !this.db) return false;
      const t0 = performance.now();
      const end = Math.min(rows.length, i + 800);
      this.store.transaction(() => {
        while (i < end) {
          const r = rows[i++];
          this.ingest(r, liveOf(r));
          if (performance.now() - t0 > 25) break;
        }
      });
      if (i < rows.length) await new Promise((r) => setImmediate(r));
    }
    return true;
  }

  private async backfill(): Promise<void> {
    if (!this.db) return;
    const t0 = Date.now();
    const max = (this.db.prepare('SELECT MAX(ROWID) AS m FROM message').get() as { m: number | null }).m ?? 0;
    // imleç baştan: dilimli yükleme sürerken gelen yeni satırlar yoklamada tekrar işlenmesin
    this.lastRowId = max;
    // Tarih sırası (ROWID değil): iCloud eşitlemesi eski sohbetleri yeni ROWID'lerle yazar. cmj.message_date indeksli, sıralama ucuz.
    // Sohbete bağlı mesajların HEPSİ (tipik chat.db 10–50 bin satır, birkaç saniye). Eskiden yalnız en yeni 2000 + sohbet başına 20
    // yükleniyordu → sohbetlerde eski mesajlar eksik görünüyordu. Çok büyük arşivde en yeni FULL_LIMIT, kalan sohbetler son 20'yle.
    // Yeniden eskiye yazılır: kullanıcının bakacağı son sohbetler ilk dilimlerde gelir.
    const rows = this.db.prepare(`${this.selectSql} ORDER BY ${this.dateCol} DESC LIMIT ?`).all(IMessageConnector.FULL_LIMIT) as Row[];
    // tapback'ler hedef mesajları yazıldıktan SONRA (eskiden yeniye: ekle → geri al sırası korunur)
    await this.ingestChunked(rows.filter((r) => !isAssociatedReaction(r.associated_message_type)));
    await this.ingestChunked(rows.filter((r) => isAssociatedReaction(r.associated_message_type)).reverse());
    const oldest = rows[rows.length - 1]?.date ?? 0;
    // FULL_LIMIT'in dışında kalan sohbetler (eski, filtrelenmiş SMS'ler, bilinmeyen gönderenler…) de son 20 mesajıyla gelsin —
    // klasör bilgisi (is_filtered) ancak mesajla birlikte öğreniliyor
    let extra = 0;
    if (rows.length < IMessageConnector.FULL_LIMIT) {
      bus.log('info', `iMessage geçmişi: ${rows.length} mesajın tamamı yüklendi (${Date.now() - t0} ms)`);
      this.warnIfStale();
      return;
    }
    try {
      // Mesajı olan tüm sohbetler (eskiden ROWID'ye göre ilk 1500 → ~400 eski sohbet hiç görünmüyordu)
      const chatRows = this.db.prepare('SELECT DISTINCT chat_id AS id FROM chat_message_join').all() as Array<{ id: number }>;
      const perChat = this.db.prepare(`${this.selectSql} WHERE cmj.chat_id = ? AND ${this.dateCol} < ? ORDER BY ${this.dateCol} DESC LIMIT 20`);
      const older: Row[] = [];
      for (const c of chatRows) for (const r of (perChat.all(c.id, oldest) as Row[]).reverse()) older.push(r);
      extra = older.length;
      await this.ingestChunked(older);
    } catch (e) {
      bus.log('warn', `iMessage sohbet geçmişi: ${(e as Error).message}`);
    }
    bus.log('info', `iMessage geçmişi: ${rows.length} mesaj + ${extra} eski sohbet mesajı yüklendi (${Date.now() - t0} ms)`);
    this.warnIfStale();
  }

  /** chat.db'ye günlerdir yeni mesaj düşmüyorsa (Apple eşitlemesi durmuş) durum satırında söyle */
  private warnIfStale(): void {
    if (!this.db) return;
    try {
      const newest = (this.db.prepare('SELECT MAX(date) AS d FROM message').get() as { d: number | null }).d ?? 0;
      const ms = newest > 1e12 ? Math.floor(newest / 1e6) + APPLE_EPOCH_MS : newest * 1000 + APPLE_EPOCH_MS;
      // 36 sa: sessiz bir gün yanlış alarm vermesin ama "dünden beri gelmiyor" fark edilsin (eskiden 7 gün → hiç görülmüyordu)
      if (ms && Date.now() - ms > 36 * 3600e3) {
        const h = Math.round((Date.now() - ms) / 3600e3);
        const since = h < 72 ? `${h} saattir` : `${Math.round(h / 24)} gündür`;
        this.setStatus('connected', `Bu Mac'in Mesajlar uygulamasına ${since} yeni mesaj düşmüyor (Mivelo yalnız Mac'teki mesajları görebilir) — Mac'te Mesajlar'ı aç; Mesajlar → Ayarlar → iMessage → "iCloud'da Mesajlar" açık olsun → Şimdi Eşzamanla. SMS için iPhone: Ayarlar → Mesajlar → Metin Mesajı Yönlendirme → bu Mac`);
      }
    } catch {
      /* tarih okunamadı */
    }
  }

  /** Yoklama sürüyor (dilimli yazım olay döngüsünü bırakırken yeni tur başlamasın); sürerken gelen tetik bir tur daha çalıştırır */
  private polling = false;
  private pollAgain?: string;

  private async poll(trigger = 'ilk'): Promise<void> {
    if (!this.db) return;
    if (this.polling) {
      this.pollAgain = trigger;
      return;
    }
    this.polling = true;
    try {
      await this.pollOnce(trigger);
    } finally {
      this.polling = false;
    }
    const again = this.pollAgain;
    this.pollAgain = undefined;
    if (again && this.db && !this.stopped) await this.poll(again);
  }

  private async pollOnce(trigger: string): Promise<void> {
    if (!this.db) return;
    try {
      // Birikmiş mesajların hepsi (iCloud eşitlemesi bir anda binlerce yazabilir): 500'lük parçalar, tur başına ≤10 parça
      const before = this.lastRowId;
      const rows: Row[] = [];
      for (let i = 0; i < 10; i++) {
        const part = this.query(rows.length ? rows[rows.length - 1].rowid : this.lastRowId, 500);
        rows.push(...part);
        if (part.length < 500) break;
      }
      // Mesajlar önce message satırını, sonra sohbet bağını (chat_message_join) yazar; arada okunursa JOIN'li sorgu mesajı
      // atlıyor ve lastRowId ilerlediği için bir daha hiç bakılmıyordu ("son gelenler görünmüyor"). Bağsız yeni satırlar beklemeye alınır.
      const top = Math.max(before, ...rows.map((r) => r.rowid));
      this.trackUnjoined(before, top, new Set(rows.map((r) => r.rowid)));
      rows.push(...this.recheckUnjoined());
      // tapback'ler hedef mesajlardan SONRA (bağsız kalıp bu turda gelen hedef listenin sonundaydı → tepki uygulanamıyordu)
      const ordered = [...rows.filter((r) => !isAssociatedReaction(r.associated_message_type)), ...rows.filter((r) => isAssociatedReaction(r.associated_message_type))];
      let fresh = 0;
      let oldest = Infinity;
      const now0 = Date.now();
      const liveSet = new Set<Row>();
      for (const r of ordered) {
        // iCloud eşitlemesi eski mesajları da yeni ROWID'lerle düşürür: yalnızca gerçekten yeni (son 10 dk) olanlar canlı
        // sayılsın; eskiler bildirim çalmadan, okunmamış sayacını oynatmadan yazılsın (sayaç syncUnread ile is_read'den gelir).
        const sentMs = this.appleToMs(r.date);
        if (now0 - sentMs >= 10 * 60_000) continue;
        liveSet.add(r);
        if (!r.is_from_me) (fresh++, (oldest = Math.min(oldest, sentMs)));
      }
      // Tek işlemli dilimler (satır başına ayrı commit 5000 satırda ~3 sn kilitliyordu); imleç ancak hepsi yazılınca ilerler
      if (!(await this.ingestChunked(ordered, (r) => liveSet.has(r)))) return;
      this.lastRowId = Math.max(this.lastRowId, top);
      // Tanı: gönderenin zamanından Mivelo'da görünene kadar. "yedek" tetik → klasör izleyicisi olayı kaçırdı;
      // "izleyici" tetikle yüksek gecikme → mesaj bu Mac'in chat.db'sine geç yazıldı (Apple teslimi / iCloud eşitlemesi)
      if (fresh) bus.log('info', `imessage: gecikme ${((Date.now() - oldest) / 1000).toFixed(1)} sn (${fresh} yeni mesaj) — tetik: ${trigger}`);
      // ek indirmesi chat.db'ye (attachment satırı) yazar → izleyici poll'u tetikler; yeni ROWID olmasa da bekleyenlere bakılır
      this.recheckPendingAttachments();
      // zamana bağlı işler (yoklama artık olayla da tetikleniyor, tur sayısı süre ölçmez)
      const now = Date.now();
      if (now - this.retractAt >= 60_000) {
        this.retractAt = now;
        this.rescanRetracted();
      }
      if (now - this.unreadAt >= 5_000) {
        this.unreadAt = now; // telefonda okununca burada da düşer
        this.syncUnread();
        this.syncReceipts();
        this.syncEdits();
      }
    } catch (e) {
      bus.log('warn', `iMessage yoklama: ${(e as Error).message}`);
    }
  }

  /** Sohbet bağı henüz yazılmamış yeni mesajlar: ROWID → ilk görülme (ms); 2 dk izlenir */
  private unjoined = new Map<number, number>();

  private trackUnjoined(from: number, to: number, got: Set<number>): void {
    if (!this.db || to <= from) return;
    try {
      const ids = this.db.prepare('SELECT ROWID AS id FROM message WHERE ROWID > ? AND ROWID <= ?').all(from, to) as Array<{ id: number }>;
      for (const { id } of ids) if (!got.has(id) && !this.unjoined.has(id) && this.unjoined.size < 500) this.unjoined.set(id, Date.now());
    } catch {
      /* yok say */
    }
  }

  private recheckUnjoined(): Row[] {
    if (!this.db || !this.unjoined.size) return [];
    const one = this.db.prepare(`${this.selectSql} WHERE m.ROWID = ?`);
    const out: Row[] = [];
    for (const [id, since] of [...this.unjoined]) {
      const r = one.get(id) as Row | undefined;
      if (r) (out.push(r), this.unjoined.delete(id));
      else if (Date.now() - since > 120_000) this.unjoined.delete(id); // sohbetsiz kaldı (sistem satırı vb.)
    }
    return out;
  }

  /** Eki henüz diske inmemiş canlı mesajlar: ROWID → ilk görülme (ms). En çok 200, her biri en çok 10 dk izlenir. */
  private pendingAtt = new Map<number, number>();
  private static readonly PENDING_ATT_MS = 10 * 60_000;

  private trackPendingAttachment(rowid: number): void {
    if (this.pendingAtt.has(rowid)) return;
    if (this.pendingAtt.size >= 200) this.pendingAtt.delete(this.pendingAtt.keys().next().value!);
    this.pendingAtt.set(rowid, Date.now());
  }

  /** Bekleyen eklere yeniden bak: dosyaların hepsi indiyse mesaj yeniden yazılır (bağlantı/önizleme gelir); 10 dk sonra vazgeçilir */
  private recheckPendingAttachments(): void {
    if (!this.db || !this.pendingAtt.size) return;
    const now = Date.now();
    const one = this.db.prepare(`${this.selectSql} WHERE m.ROWID = ?`);
    for (const [rowid, since] of [...this.pendingAtt]) {
      if (now - since > IMessageConnector.PENDING_ATT_MS) {
        this.pendingAtt.delete(rowid);
        continue;
      }
      const r = one.get(rowid) as Row | undefined;
      if (!r) {
        this.pendingAtt.delete(rowid);
        continue;
      }
      let missing = false;
      this.attachmentsOf(r, () => (missing = true));
      if (missing) continue;
      this.pendingAtt.delete(rowid);
      this.ingest(r, false);
    }
  }

  /** sohbet guid → bu sohbette benden mesaj var mı (Mesajlar: yanıtladığın kişi artık "bilinmeyen" sayılmaz) */
  private repliedCache = new Map<string, boolean>();
  /**
   * Mesajlar uygulamasının "Bilinmeyen Gönderenler" kuralı: kişi rehberde yok VE sen hiç yanıtlamamışsın. Bazı macOS
   * sürümleri chat.is_filtered'ı bu sohbetler için 0 bırakıyor → klasör boş görünüyordu. Rehber okunamadıysa (izin yok)
   * herkes "bilinmeyen" olmasın diye uygulanmaz.
   */
  private unknownSender(r: Row, ident: string): boolean {
    if (!this.names.size) return false;
    const h = r.handle ?? ident;
    if (!h || phoneKeys(h).some((k) => this.names.has(k))) return false;
    if (r.is_from_me) {
      this.repliedCache.set(r.chat_guid, true);
      return false;
    }
    let replied = this.repliedCache.get(r.chat_guid);
    if (replied === undefined && this.db) {
      try {
        replied = !!this.db
          .prepare('SELECT 1 FROM chat_message_join cmj JOIN chat c ON c.ROWID = cmj.chat_id JOIN message m ON m.ROWID = cmj.message_id WHERE c.guid = ? AND m.is_from_me = 1 LIMIT 1')
          .get(r.chat_guid);
      } catch {
        replied = true; // sorgu olmadı: sınıflandırma yapma
      }
      this.repliedCache.set(r.chat_guid, replied);
    }
    return !replied;
  }

  private ingest(r: Row, live: boolean): void {
    if (r.item_type !== 0) return; // grup olayları, isim değişiklikleri vb.
    if (isAssociatedReaction(r.associated_message_type)) {
      // tapback: ayrı mesaj değil — hedef mesaja tepki (❤️ 👍 😂 …); canlı gelen karşı taraf tepkisinde önizleme "… tepki verdi"
      const tb = tapbackOf(r);
      if (!tb) return;
      const fromMe = r.is_from_me === 1;
      const senderName = fromMe ? 'Ben' : this.nameOf(r.handle, null, r.chat_identifier);
      this.applyReaction(r.chat_guid, tb.target, { emoji: tb.emoji, senderId: fromMe ? 'me' : (r.handle ?? 'unknown'), senderName, fromMe }, tb.remove);
      if (live && !fromMe && !tb.remove) this.reactionPreview(r.chat_guid, `${tb.emoji} ${senderName.split(/\s+/)[0]} mesajına tepki verdi`);
      return;
    }
    // U+FFFC: ekin metindeki yer tutucusu
    let text = (r.text ?? '').replace(/\uFFFC/g, '').trim() || decodeAttributedBody(r.attributedBody);
    // Mesajlar satırı ek dosyası inmeden yazar: canlı mesajın eki henüz yoksa ROWID beklemeye alınır, poll yeniden bakar
    const attachments = this.attachmentsOf(r, live ? () => this.trackPendingAttachment(r.rowid) : undefined);
    if (!text && !attachments) {
      // Gönderimi geri alındı (Undo Send): içerik boşaltılır → depodaki özgün metin "silindi" olur (depoda yoksa kayıt açılmaz)
      if (r.date_retracted && !r.recoverable) this.applyEdited(r.chat_guid, r.guid, null);
      return;
    }
    const deleted = !!r.recoverable;
    if (deleted) text = `🗑 ${text || '(ek)'}`; // Mesajlar → Son Silinenler
    const isGroup = r.chat_identifier.startsWith('chat');
    // chat_identifier filtrelenmiş sohbetlerde "+90…(smsft)" / "(filtered)" ekiyle gelir; ad/numara eşlemesinde ek atılır
    const ident = r.chat_identifier.replace(/\((filtered|smsft)\)$/, '');
    const chatName = this.nameOf(isGroup ? null : r.handle ?? ident, r.display_name, ident);
    const folder = imessageFolder(r.is_filtered) ?? (!isGroup && this.unknownSender(r, ident) ? 'unknown' : undefined);
    const existing = this.store.getChat(chatIdOf(this.account.id, r.chat_guid));
    // Klasör her seferinde chat.is_filtered'dan yeniden yazılır: bilinen kişiye taşınan sohbet (0) ve eski sürümün "sms" değeri silinir
    const { folder: _oldFolder, ...rest } = existing?.meta ?? {};
    const meta: Record<string, unknown> = { ...rest, ...(folder ? { folder } : {}), ...(deleted ? { deleted: true } : {}) };
    // Ad da karşılaştırılır: rehber eşlemesi iyileşince (0532… ↔ +90532…) eski sohbetler de isimlensin
    if (!existing || existing.name !== chatName || JSON.stringify(meta) !== JSON.stringify(existing.meta ?? {}))
      this.upsertChat({ remoteId: r.chat_guid, name: chatName, kind: isGroup ? 'group' : 'direct', meta });
    const ms = this.appleToMs(r.date);
    const status = r.is_from_me ? imessageStatus(r) : 'delivered';
    const edited = !!r.date_edited && !r.date_retracted && !deleted;
    // Açılış yüklemesi / yeniden taramalar depoda aynı duran mesajı yeniden yazmasın (UPDATE + FTS + chat.upsert yayını;
    // her açılışta 13-60 bin satır). Alındı, sonradan inen ek, metin değişikliği yine yazılır.
    const senderName = r.is_from_me ? 'Ben' : this.nameOf(r.handle, null, r.chat_identifier);
    if (!live && this.unchanged(r, text, status, attachments, senderName)) {
      if (edited) this.applyEdited(r.chat_guid, r.guid, text);
      return;
    }
    this.upsertMessage(
      {
        remoteChatId: r.chat_guid,
        remoteId: r.guid,
        senderId: r.is_from_me ? 'me' : (r.handle ?? 'unknown'),
        senderName,
        fromMe: r.is_from_me === 1,
        text,
        ts: ms,
        status,
        attachments,
      },
      { live },
    );
    // karşı tarafın (ya da benim) düzenlemem: metin yerinde değişti → "düzenlendi" işareti + önizleme
    if (edited) this.applyEdited(r.chat_guid, r.guid, text);
  }

  /** Depodaki mesaj chat.db satırıyla aynı mı (metin, ekler; durum geri gitmez) — öyleyse yeniden yazmaya gerek yok */
  private unchanged(r: Row, text: string, status: Message['status'], attachments: Attachment[] | undefined, senderName: string): boolean {
    const m = this.store.getMessage(messageIdOf(chatIdOf(this.account.id, r.chat_guid), r.guid));
    if (!m) return false;
    if (m.deleted) return true; // silinen geri gelmez (depo da ezmez)
    if (m.text !== trReactionText(text)) return false;
    if (senderName && m.senderName !== senderName) return false; // rehber adı sonradan öğrenildi → eski mesajlar da adlansın
    const RANK: Record<string, number> = { failed: -1, pending: 0, sent: 1, delivered: 2, read: 3 };
    if (m.status !== status && (status === 'failed' || (RANK[status] ?? 0) > (RANK[m.status] ?? 0))) return false;
    const a = (x: Attachment[] | undefined) => (x?.length ? JSON.stringify(x) : '');
    return a(m.attachments) === a(attachments);
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
