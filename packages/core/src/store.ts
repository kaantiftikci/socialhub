import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs';
import { DB_PATH } from './config.js';
import type { Account, CalEvent, Chat, ChatFlags, FollowUp, Message, Platform, Reaction } from './model.js';

/**
 * Yerel SQLite deposu. Şema küçük tutuldu; FTS5 ile tam metin arama var.
 * Üretimde SQLCipher ile şifrelenir (anahtar Keychain'de) — bu demo düz SQLite kullanır.
 */
export class Store {
  private db: Database.Database;

  constructor(path = DB_PATH, key?: string) {
    if (key) Store.migratePlain(path, key);
    this.db = new Database(path);
    if (key) {
      // SQLCipher uyumlu şifreleme; anahtar ham hex (tırnak/kaçış sorunu yok)
      this.db.pragma("cipher = 'sqlcipher'");
      this.db.pragma(`key = "x'${key}'"`);
    }
    this.db.pragma('journal_mode = WAL');
    // WAL + NORMAL: her yazımda fsync beklenmez (geçmiş eşitlemesinde on binlerce satır); çökme güvenliği korunur
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  /** Diskteki veritabanı düz (şifresiz) SQLite ise yerinde şifrele (SQLite3MultipleCiphers: PRAGMA rekey). */
  private static migratePlain(file: string, key: string): void {
    if (!fs.existsSync(file)) return;
    const head = Buffer.alloc(16);
    try {
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, head, 0, 16, 0);
      fs.closeSync(fd);
    } catch {
      return;
    }
    if (head.toString('utf8', 0, 15) !== 'SQLite format 3') return; // zaten şifreli (ya da boş)
    const db = new Database(file);
    try {
      // rekey WAL ile çalışmaz: önce geri al, sonra şifrele; journal_mode WAL'a constructor'da döner
      db.pragma('journal_mode = DELETE');
      db.pragma("cipher = 'sqlcipher'");
      db.pragma(`rekey = "x'${key}'"`);
    } finally {
      db.close();
    }
    fs.chmodSync(file, 0o600);
  }

  /** Toplu yazımları tek işlemde çalıştır (geçmiş paketleri, ad yenileme) — çok daha hızlı. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'disconnected',
        detail TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'direct',
        unread INTEGER NOT NULL DEFAULT 0,
        last_message_at INTEGER NOT NULL DEFAULT 0,
        last_preview TEXT NOT NULL DEFAULT '',
        avatar_url TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        UNIQUE(account_id, remote_id)
      );
      CREATE INDEX IF NOT EXISTS chats_last ON chats(last_message_at DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        remote_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        from_me INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL DEFAULT '',
        ts INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent',
        attachments TEXT,
        UNIQUE(chat_id, remote_id)
      );
      CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat_id, ts);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
    `);
    // hafif göç: sonradan eklenen sütunlar
    const cols = new Set((this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has('sender_avatar')) this.db.exec('ALTER TABLE messages ADD COLUMN sender_avatar TEXT');
    if (!cols.has('reactions')) this.db.exec('ALTER TABLE messages ADD COLUMN reactions TEXT');
    if (!cols.has('thread_id')) this.db.exec('ALTER TABLE messages ADD COLUMN thread_id TEXT');
    if (!cols.has('reply_count')) this.db.exec('ALTER TABLE messages ADD COLUMN reply_count INTEGER');
    const ccols = new Set((this.db.prepare('PRAGMA table_info(chats)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!ccols.has('handle')) this.db.exec('ALTER TABLE chats ADD COLUMN handle TEXT');
    if (!ccols.has('link')) this.db.exec('ALTER TABLE chats ADD COLUMN link TEXT');
    if (!ccols.has('participants')) this.db.exec('ALTER TABLE chats ADD COLUMN participants TEXT');
    if (!ccols.has('meta')) this.db.exec('ALTER TABLE chats ADD COLUMN meta TEXT');
    if (!ccols.has('last_from_me')) this.db.exec('ALTER TABLE chats ADD COLUMN last_from_me INTEGER NOT NULL DEFAULT 0');
    if (!ccols.has('flags')) this.db.exec('ALTER TABLE chats ADD COLUMN flags TEXT'); // {pinned,archived,muted,hidden}
    // Mivelo'da okunan nokta (ms): bu zamana kadar olan mesajlar kalıcı olarak okundu; platform yoklaması geri açamaz
    // takip hatırlatıcısı {at, since, due}
    if (!ccols.has('followup')) this.db.exec('ALTER TABLE chats ADD COLUMN followup TEXT');
    if (!ccols.has('read_upto')) this.db.exec('ALTER TABLE chats ADD COLUMN read_upto INTEGER NOT NULL DEFAULT 0');
    // gönderen bazlı güncellemeler (ad/fotoğraf/lid→numara) tam tablo taraması yapmasın
    this.db.exec('CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender_id)');
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    // Mivelo takvimi: "Takvime ekle" ve Takvim görünümünden eklenen etkinlikler (yerel; isteğe bağlı cihaz takvimine de yazılır)
    this.db.exec(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      start TEXT NOT NULL,
      duration_min INTEGER NOT NULL DEFAULT 60,
      all_day INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      location TEXT,
      chat_id TEXT,
      message_id TEXT,
      remind_min INTEGER,
      reminded INTEGER NOT NULL DEFAULT 0,
      device_calendar TEXT,
      created_at INTEGER NOT NULL
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS events_start ON events(start)');
    // Onarım: Instagram Reels/gönderi paylaşımlarında gönderi açıklaması mesaj metni olarak yazılmıştı ("@kullanıcı: açıklama");
    // metin boşaltılır, etkilenen sohbetlerin önizlemesi son mesajdan yeniden türetilir
    if (!this.flag('fix_ig_caption_v1')) {
      const rows = this.db
        .prepare("SELECT id, chat_id FROM messages WHERE chat_id LIKE 'instagram:%' AND text LIKE '@%: %' AND attachments IS NOT NULL AND (attachments LIKE '%\"name\":\"Reels%' OR attachments LIKE '%\"name\":\"Gönderi%' OR attachments LIKE '%\"name\":\"Video%')")
        .all() as Array<{ id: string; chat_id: string }>;
      const touched = new Set<string>();
      this.db.transaction(() => {
        for (const r of rows) {
          this.db.prepare("UPDATE messages SET text = '' WHERE id = ?").run(r.id);
          touched.add(r.chat_id);
        }
        for (const cid of touched) {
          const chat = this.getChat(cid);
          const last = this.db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT 1').get(cid);
          if (!chat || !last) continue;
          const m = rowToMessage(last);
          const body = m.text || (m.attachments?.length ? `[${m.attachments[0].name ?? m.attachments[0].kind}]` : '');
          const preview = chat.kind !== 'direct' && body ? `${m.fromMe ? 'Sen' : (m.senderName || '').split(/\s+/)[0] || '?'}: ${body}` : body;
          this.db.prepare('UPDATE chats SET last_preview = ? WHERE id = ?').run(preview, cid);
        }
      })();
      this.setFlag('fix_ig_caption_v1');
    }
    // Tek seferlik onarım: Messenger mesajları ilk sürümde eşitleme saatiyle yazılmıştı (kimlik aynı kaldığı için üstüne
    // yazılmıyor); sil → yoklama gerçek zamanlarıyla yeniden getirir
    if (!this.flag('fix_messenger_ts_v1')) {
      this.db.exec("DELETE FROM messages WHERE chat_id LIKE 'messenger:%'");
      this.setFlag('fix_messenger_ts_v1');
    }
    // X: eski sürüm /i/chat DOM'undan okuduğu mesajları 'xc-<uuid>' kimliği ve yanlış zamanla kaydetmişti; bir kez temizle
    if (!this.flag('fix_x_xc_v1')) {
      this.db.exec("DELETE FROM messages WHERE remote_id LIKE 'xc-%' AND chat_id IN (SELECT id FROM chats WHERE platform = 'x')");
      this.setFlag('fix_x_xc_v1');
    }
    // Onarım: Outlook okuma bölmesi satıra geçmeden okunup aynı ileti onlarca sohbete yazılmıştı (aynı metin+zaman+gönderen
    // ≥3 sohbette): sil, son önizlemeyi kalan mesajdan türet (yoklama gerçek önizlemeyi yeniden yazar)
    if (!this.flag('fix_outlook_dup_v1')) {
      this.db.exec("DELETE FROM messages WHERE chat_id LIKE 'outlook:%' AND (text, ts, sender_id) IN (SELECT text, ts, sender_id FROM messages WHERE chat_id LIKE 'outlook:%' GROUP BY text, ts, sender_id HAVING COUNT(DISTINCT chat_id) >= 3)");
      this.db.exec("UPDATE chats SET last_preview = COALESCE((SELECT text FROM messages m WHERE m.chat_id = chats.id ORDER BY m.ts DESC LIMIT 1), '') WHERE id LIKE 'outlook:%'");
      this.setFlag('fix_outlook_dup_v1');
    }
    // Onarım: kopya öğeden okunan gövdeye <style>/yorum metni sızmıştı; bu mesajlar silinir, yoklama temiz metinle yeniden yazar
    if (!this.flag('fix_outlook_css_v1')) {
      this.db.exec("DELETE FROM messages WHERE chat_id LIKE 'outlook:%' AND (text LIKE '<!--%' OR text LIKE '%@media only screen%' OR text LIKE '%!important%')");
      this.setFlag('fix_outlook_css_v1');
    }
    // Onarım: ileti zamanı okunamayınca yoklama saati yazılmış, sohbet zamanları/önizlemeleri kilitlenmişti: Outlook mesajları
    // silinir, sohbet zamanı sıfırlanır (yoklama liste zamanı ve temiz iletilerle yeniden yazar)
    if (!this.flag('fix_outlook_ts_v1')) {
      this.db.exec("DELETE FROM messages WHERE chat_id LIKE 'outlook:%'");
      this.db.exec("UPDATE chats SET last_message_at = 0, last_preview = '' WHERE id LIKE 'outlook:%'");
      this.setFlag('fix_outlook_ts_v1');
    }
    if (!this.flag('fix_outlook_ts_v2')) {
      this.db.exec("DELETE FROM messages WHERE chat_id LIKE 'outlook:%'");
      this.db.exec("UPDATE chats SET last_message_at = 0, last_preview = '' WHERE id LIKE 'outlook:%'");
      this.setFlag('fix_outlook_ts_v2');
    }
    // Onarım: grup/kanal önizlemelerine gönderen adı (son mesajdan)
    if (!this.flag('fix_group_preview_v1')) {
      const rows = this.db.prepare("SELECT c.id, m.from_me, m.sender_name, m.text, m.attachments FROM chats c JOIN messages m ON m.id = (SELECT id FROM messages WHERE chat_id = c.id ORDER BY ts DESC, rowid DESC LIMIT 1) WHERE c.kind IN ('group','channel')").all() as Array<{ id: string; from_me: number; sender_name: string; text: string; attachments: string | null }>;
      const upd = this.db.prepare('UPDATE chats SET last_preview = ? WHERE id = ?');
      this.transaction(() => {
        for (const r of rows) {
          const body = r.text || (r.attachments ? '[ek]' : '');
          if (!body) continue;
          upd.run(`${r.from_me ? 'Sen' : (r.sender_name || '').split(/\s+/)[0] || '?'}: ${body}`, r.id);
        }
      });
      this.setFlag('fix_group_preview_v1');
    }
    // Onarım: tarayıcı kanallarında sohbet zamanı olarak yoklama saati yazılmıştı; mesajı olan sohbetleri son mesaj zamanına çek
    this.db.exec(`UPDATE chats SET last_message_at = (SELECT MAX(ts) FROM messages m WHERE m.chat_id = chats.id)
      WHERE platform IN ('messenger','x','instagram','linkedin','slack')
        AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = chats.id)
        AND last_message_at > (SELECT MAX(ts) FROM messages m WHERE m.chat_id = chats.id) + 600000`);
  }

  flag(key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM meta WHERE key = ?').get(key);
  }

  setFlag(key: string, value = '1'): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Sohbetteki en eski mesajın zamanı (yoksa undefined) */
  oldestTs(chatId: string): number | undefined {
    const r = this.db.prepare('SELECT MIN(ts) AS t FROM messages WHERE chat_id = ?').get(chatId) as { t: number | null };
    return r?.t ?? undefined;
  }

  // ---------- accounts ----------
  upsertAccount(a: Account): void {
    this.db
      .prepare(
        `INSERT INTO accounts (id, platform, label, status, detail, created_at) VALUES (@id, @platform, @label, @status, @detail, @createdAt)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, status = excluded.status, detail = excluded.detail`,
      )
      .run({ ...a, detail: a.detail ?? null });
  }

  listAccounts(): Account[] {
    return this.db.prepare('SELECT * FROM accounts ORDER BY created_at').all().map(rowToAccount);
  }

  getAccount(id: string): Account | undefined {
    const r = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    return r ? rowToAccount(r) : undefined;
  }

  deleteAccount(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE account_id = ?)').run(id);
      this.db.prepare('DELETE FROM chats WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    })();
  }

  // ---------- chats ----------
  upsertChat(c: Chat): Chat {
    this.db
      .prepare(
        `INSERT INTO chats (id, account_id, platform, remote_id, name, kind, unread, last_message_at, last_preview, avatar_url, tags, handle, link, participants, meta, last_from_me)
         VALUES (@id, @accountId, @platform, @remoteId, @name, @kind, @unread, @lastMessageAt, @lastPreview, @avatarUrl, @tags, @handle, @link, @participants, @meta, @lastFromMe)
         ON CONFLICT(id) DO UPDATE SET
           name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE chats.name END,
           kind = excluded.kind,
           unread = CASE WHEN MAX(chats.last_message_at, excluded.last_message_at) <= chats.read_upto THEN 0 ELSE excluded.unread END,
           last_message_at = MAX(chats.last_message_at, excluded.last_message_at),
           last_preview = CASE WHEN excluded.last_message_at >= chats.last_message_at THEN excluded.last_preview ELSE chats.last_preview END,
           avatar_url = COALESCE(excluded.avatar_url, chats.avatar_url),
           handle = COALESCE(excluded.handle, chats.handle),
           link = COALESCE(excluded.link, chats.link),
           participants = COALESCE(excluded.participants, chats.participants),
           meta = COALESCE(excluded.meta, chats.meta)`,
      )
      .run({
        ...c,
        avatarUrl: c.avatarUrl ?? null,
        tags: JSON.stringify(c.tags ?? []),
        handle: c.handle ?? null,
        link: c.link ?? null,
        participants: c.participants ? JSON.stringify(c.participants) : null,
        meta: c.meta ? JSON.stringify(c.meta) : null,
        lastFromMe: c.lastFromMe ? 1 : 0,
      });
    return this.getChat(c.id)!;
  }

  /** Bir sohbetin mesajlarını başka bir sohbete taşı ve kaynağı sil (aynı kişinin lid/numara kopyaları). */
  mergeChats(fromId: string, toId: string): void {
    if (fromId === toId) return;
    this.db.transaction(() => {
      const rows = this.db.prepare('SELECT id, remote_id FROM messages WHERE chat_id = ?').all(fromId) as Array<{ id: string; remote_id: string }>;
      for (const r of rows) {
        const newId = `${toId}#${r.remote_id}`;
        if (this.hasMessage(newId)) this.db.prepare('DELETE FROM messages WHERE id = ?').run(r.id);
        else this.db.prepare('UPDATE messages SET id = ?, chat_id = ? WHERE id = ?').run(newId, toId, r.id);
      }
      const from = this.getChat(fromId);
      const to = this.getChat(toId);
      if (from && to) {
        this.db
          .prepare('UPDATE chats SET unread = unread + ?, last_message_at = MAX(last_message_at, ?), last_preview = CASE WHEN ? > last_message_at THEN ? ELSE last_preview END, avatar_url = COALESCE(avatar_url, ?) WHERE id = ?')
          .run(from.unread, from.lastMessageAt, from.lastMessageAt, from.lastPreview, from.avatarUrl ?? null, toId);
      }
      this.db.prepare('DELETE FROM chats WHERE id = ?').run(fromId);
    })();
  }

  /** Bir gönderenin adını/fotoğrafını geçmiş mesajlarda güncelle (rehber adı sonradan öğrenilince). */
  renameSender(accountId: string, senderId: string, name: string, avatar?: string): void {
    this.db
      .prepare(`UPDATE messages SET sender_name = ?, sender_avatar = COALESCE(?, sender_avatar) WHERE sender_id = ? AND chat_id LIKE ? AND from_me = 0 AND sender_name <> ?`)
      .run(name, avatar ?? null, senderId, accountId + '/%', name);
  }

  /** Gönderdiğim mesajlar `before` zamanına kadar karşı tarafça görüldü; değişen satır sayısını döndürür */
  markOutgoingRead(chatId: string, before: number): number {
    return this.db.prepare("UPDATE messages SET status = 'read' WHERE chat_id = ? AND from_me = 1 AND ts <= ? AND status <> 'read'").run(chatId, before).changes;
  }

  /** Telegram gibi sayısal artan mesaj kimliği olan platformlarda: kimliği <= maxId olan giden mesajlar görüldü; en yeni etkilenen ts döner */
  markOutgoingReadUpToId(chatId: string, maxId: number): number | undefined {
    const r = this.db.prepare("SELECT MAX(ts) AS t FROM messages WHERE chat_id = ? AND from_me = 1 AND CAST(remote_id AS INTEGER) <= ? AND status <> 'read'").get(chatId, maxId) as { t: number | null };
    if (!r?.t) return undefined;
    this.db.prepare("UPDATE messages SET status = 'read' WHERE chat_id = ? AND from_me = 1 AND CAST(remote_id AS INTEGER) <= ? AND status <> 'read'").run(chatId, maxId);
    return r.t;
  }

  /** Bir gönderen kimliğini başka bir kimliğe taşı (lid → telefon numarası öğrenilince). */
  rewriteSender(accountId: string, fromId: string, toId: string): void {
    if (fromId === toId) return;
    this.db.prepare('UPDATE messages SET sender_id = ? WHERE sender_id = ? AND chat_id LIKE ?').run(toId, fromId, accountId + '/%');
  }

  getChat(id: string): Chat | undefined {
    const r = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
    return r ? rowToChat(r) : undefined;
  }

  /**
   * Arayüze giden sohbetler: HESAP BAŞINA en yeni `perAccount` (eskiden tümünde toplam 600 → çok sohbetli WhatsApp, iMessage'ın
   * eski/klasördeki sohbetlerini listeden atıyordu). Okunmamış, işaretli (sabit/arşiv/sessiz), takipte ve iMessage klasörü/Son
   * Silinenler'deki sohbetler sınırdan bağımsız hep gelir.
   */
  listChats(perAccount = 3000): Chat[] {
    return this.db
      .prepare(
        `SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY last_message_at DESC) AS rn FROM chats)
          WHERE rn <= ? OR unread > 0 OR flags IS NOT NULL OR followup IS NOT NULL
             OR (platform = 'imessage' AND (meta LIKE '%"folder"%' OR meta LIKE '%"deleted"%'))
          ORDER BY last_message_at DESC`,
      )
      .all(perAccount)
      .map(rowToChat);
  }

  /** Bir hesabın tüm sohbetleri (sınırsız; connector içi toplu işlemler için). */
  listChatsOf(accountId: string): Chat[] {
    return this.db.prepare('SELECT * FROM chats WHERE account_id = ? ORDER BY last_message_at DESC').all(accountId).map(rowToChat);
  }

  /** Sohbet Mivelo'da okundu: sayaç 0 ve okuma noktası = son mesaj zamanı (kalıcı; yeni mesaj gelene dek platform geri açamaz) */
  markRead(id: string): void {
    this.db.prepare('UPDATE chats SET unread = 0, read_upto = MAX(read_upto, last_message_at) WHERE id = ?').run(id);
  }

  setTags(id: string, tags: string[]): void {
    this.db.prepare('UPDATE chats SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id);
  }

  // ---------- messages ----------
  /** Mesajı kaydeder; sohbetin özetini (son mesaj, okunmamış) günceller. Yeni eklendiyse true döner. */
  upsertMessage(m: Message, opts: { bumpUnread?: boolean } = {}): boolean {
    const existed = this.hasMessage(m.id);
    this.db
      .prepare(
        `INSERT INTO messages (id, chat_id, remote_id, sender_id, sender_name, from_me, text, ts, status, attachments, sender_avatar, reactions, thread_id, reply_count)
         VALUES (@id, @chatId, @remoteId, @senderId, @senderName, @fromMe, @text, @ts, @status, @attachments, @senderAvatar, @reactions, @threadId, @replyCount)
         ON CONFLICT(id) DO UPDATE SET
           -- durum geri gitmez (tüm platformlar): yeniden eşitleme/yoklama "görüldü"yü "gönderildi"ye indirmesin; başarısız yalnız henüz
           -- iletilmemiş mesajın yerini alır, başarısızdan sonra gelen gerçek durum ise yazılır
           status = CASE
             WHEN excluded.status = 'failed' THEN CASE WHEN messages.status IN ('pending', 'sent', 'failed') THEN 'failed' ELSE messages.status END
             WHEN (CASE excluded.status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END)
                  >= (CASE messages.status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 WHEN 'failed' THEN -1 ELSE 0 END)
               THEN excluded.status
             ELSE messages.status END,
           text = CASE WHEN excluded.text <> '' THEN excluded.text WHEN excluded.attachments IS NOT NULL THEN '' ELSE messages.text END,
           attachments = COALESCE(excluded.attachments, messages.attachments),
           sender_avatar = COALESCE(excluded.sender_avatar, messages.sender_avatar),
           sender_name = CASE WHEN excluded.sender_name <> '' THEN excluded.sender_name ELSE messages.sender_name END,
           reactions = COALESCE(excluded.reactions, messages.reactions),
           thread_id = COALESCE(excluded.thread_id, messages.thread_id),
           reply_count = COALESCE(excluded.reply_count, messages.reply_count)`,
      )
      .run({
        ...m,
        fromMe: m.fromMe ? 1 : 0,
        attachments: m.attachments ? JSON.stringify(m.attachments) : null,
        senderAvatar: m.senderAvatarUrl ?? null,
        reactions: m.reactions ? JSON.stringify(m.reactions) : null,
        threadId: m.threadId ?? null,
        replyCount: m.replyCount ?? null,
      });
    const inserted = !existed;
    const chat = this.getChat(m.chatId);
    if (chat) {
      const body = m.text || (m.attachments?.length ? `[${m.attachments[0].name ?? m.attachments[0].kind}]` : '');
      // grup/kanalda önizlemede kim yazdı görünsün: "Ali: mesaj" / "Sen: mesaj"
      const preview = chat.kind !== 'direct' && body ? `${m.fromMe ? 'Sen' : (m.senderName || '').split(/\s+/)[0] || '?'}: ${body}` : body;
      const isNewer = m.ts >= chat.lastMessageAt;
      this.db
        .prepare('UPDATE chats SET last_message_at = ?, last_preview = ?, unread = ?, last_from_me = ? WHERE id = ?')
        .run(
          Math.max(chat.lastMessageAt, m.ts),
          isNewer ? preview : chat.lastPreview,
          opts.bumpUnread && inserted && !m.fromMe && m.ts > (chat.readUpto ?? 0) ? chat.unread + 1 : chat.unread,
          isNewer ? (m.fromMe ? 1 : 0) : (chat.lastFromMe ? 1 : 0),
          m.chatId,
        );
    }
    return inserted;
  }

  getMessage(id: string): Message | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return r ? rowToMessage(r) : undefined;
  }

  /** Tepki ekle/kaldır: aynı gönderenin önceki tepkisi değiştirilir (platformlar kişi başına tek tepki tutar) */
  setReaction(id: string, r: Reaction, remove = false): Message | undefined {
    const m = this.getMessage(id);
    if (!m) return undefined;
    const rest = (m.reactions ?? []).filter((x) => x.senderId !== r.senderId);
    const next = remove ? rest : [...rest, r];
    this.db.prepare('UPDATE messages SET reactions = ? WHERE id = ?').run(next.length ? JSON.stringify(next) : null, id);
    return { ...m, reactions: next.length ? next : undefined };
  }

  /** Tepki listesini bütünüyle değiştir (Telegram güncellemeleri tam listeyi verir) */
  setReactions(id: string, list: Reaction[] | undefined): Message | undefined {
    const m = this.getMessage(id);
    if (!m) return undefined;
    this.db.prepare('UPDATE messages SET reactions = ? WHERE id = ?').run(list?.length ? JSON.stringify(list) : null, id);
    return { ...m, reactions: list?.length ? list : undefined };
  }

  /** Yerel bayraklar (sabitle/arşivle/sessize al/gizle); verilmeyen alanlar korunur */
  setFlags(id: string, flags: ChatFlags): Chat | undefined {
    const c = this.getChat(id);
    if (!c) return undefined;
    const next: ChatFlags = { pinned: c.pinned, archived: c.archived, muted: c.muted, hidden: c.hidden };
    for (const k of ['pinned', 'archived', 'muted', 'hidden'] as const) if (typeof flags[k] === 'boolean') next[k] = flags[k] || undefined;
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v));
    this.db.prepare('UPDATE chats SET flags = ? WHERE id = ?').run(Object.keys(clean).length ? JSON.stringify(clean) : null, id);
    return this.getChat(id);
  }

  /** Takip hatırlatıcısı kur (at ms) ya da kaldır (null) */
  setFollowUp(id: string, at: number | null): Chat | undefined {
    if (!this.getChat(id)) return undefined;
    const v = at ? JSON.stringify({ at, since: Date.now() } satisfies FollowUp) : null;
    this.db.prepare('UPDATE chats SET followup = ? WHERE id = ?').run(v, id);
    return this.getChat(id);
  }

  /**
   * Takip hatırlatıcılarını değerlendir: kurulduktan sonra karşı taraftan mesaj gelen kapanır (resolved),
   * süresi dolup yanıt gelmeyen `due` olur (yalnızca ilk kez döner; bildirim bir kez gider).
   */
  checkFollowUps(now = Date.now()): { resolved: Chat[]; due: Chat[] } {
    const rows = this.db.prepare('SELECT id, followup FROM chats WHERE followup IS NOT NULL').all() as Array<{ id: string; followup: string }>;
    const resolved: Chat[] = [];
    const due: Chat[] = [];
    const incoming = this.db.prepare('SELECT 1 FROM messages WHERE chat_id = ? AND from_me = 0 AND ts > ? LIMIT 1');
    for (const r of rows) {
      const f = safeJson<FollowUp | null>(r.followup, null);
      if (!f) continue;
      if (incoming.get(r.id, f.since)) {
        this.db.prepare('UPDATE chats SET followup = NULL WHERE id = ?').run(r.id);
        const c = this.getChat(r.id);
        if (c) resolved.push(c);
      } else if (!f.due && f.at <= now) {
        this.db.prepare('UPDATE chats SET followup = ? WHERE id = ?').run(JSON.stringify({ ...f, due: true }), r.id);
        const c = this.getChat(r.id);
        if (c) due.push(c);
      }
    }
    return { resolved, due };
  }

  /** Yalnızca teslim/okundu durumunu güncelle (metin, zaman ve sohbet özetine dokunmadan). */
  updateStatus(id: string, status: Message['status']): void {
    this.db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, id);
  }

  /**
   * Gönderim sonrası yerel (local-…) kaydın gerçek kimlikli kopyası geldiyse yerel kaydı sil
   * (iMessage yoklaması / Messenger DOM okuması aynı mesajı başka kimlikle getirir).
   */
  dropLocalDuplicates(chatId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT l.id FROM messages l WHERE l.chat_id = ? AND l.remote_id LIKE 'local-%' AND l.from_me = 1
           AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = l.chat_id AND m.from_me = 1 AND m.remote_id NOT LIKE 'local-%' AND m.text = l.text AND ABS(m.ts - l.ts) < 600000)`,
      )
      .all(chatId) as Array<{ id: string }>;
    for (const r of rows) this.db.prepare('DELETE FROM messages WHERE id = ?').run(r.id);
    return rows.map((r) => r.id);
  }

  /**
   * Kendi mesajımın yankısı mı: aynı sohbette ±3 dk içinde birebir aynı metinli (≥12 karakter) benim gönderdiğim bir mesaj var.
   * Bazı platformlar/istemciler gönderdiğim mesajı başka kimlikle (WhatsApp LID, DOM okuyan köprüler) karşı taraftan gelmiş gibi
   * tekrar verir; bu kayıt gelen mesaj sayılmaz (okunmamış sayacı artmaz, kopya balon çıkmaz).
   */
  isOwnEcho(chatId: string, text: string, ts: number): boolean {
    const t = text.trim();
    if (t.length < 12) return false;
    return !!this.db.prepare('SELECT 1 FROM messages WHERE chat_id = ? AND from_me = 1 AND text = ? AND ts BETWEEN ? AND ?').get(chatId, t, ts - 180_000, ts + 180_000);
  }

  hasMessage(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id);
  }

  listMessages(chatId: string, limit = 100, before?: number): Message[] {
    const rows = before
      ? this.db.prepare('SELECT * FROM messages WHERE chat_id = ? AND ts < ? ORDER BY ts DESC, rowid DESC LIMIT ?').all(chatId, before, limit)
      : this.db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?').all(chatId, limit);
    return rows.map(rowToMessage).reverse();
  }

  /**
   * Üslup örnekleri: karşı tarafın mesajı → benim hemen ardından yazdığım yanıt çiftleri. Önce bu sohbetten,
   * sonra aynı platformdan, sonra tüm platformlardan (yeni sohbette de "senin tarzın" bilinsin).
   */
  styleSamples(chatId: string, platform: string, limit = 12): Array<{ them: string; me: string; scope: 'chat' | 'platform' | 'all' }> {
    const since = Date.now() - 365 * 86_400_000;
    const out: Array<{ them: string; me: string; scope: 'chat' | 'platform' | 'all' }> = [];
    const seen = new Set<string>();
    const add = (where: string, arg: string | null, scope: 'chat' | 'platform' | 'all', n: number) => {
      if (out.length >= limit) return;
      const sql = `SELECT text, prev_text FROM (
           SELECT text, from_me, ts,
                  LAG(text) OVER (PARTITION BY chat_id ORDER BY ts) AS prev_text,
                  LAG(from_me) OVER (PARTITION BY chat_id ORDER BY ts) AS prev_me
           FROM messages WHERE ${where} AND ts > ?
         ) WHERE from_me = 1 AND prev_me = 0 AND length(text) BETWEEN 2 AND 400 AND length(prev_text) BETWEEN 1 AND 400
         ORDER BY ts DESC LIMIT ?`;
      const rows = (arg === null ? this.db.prepare(sql).all(since, n * 3) : this.db.prepare(sql).all(arg, since, n * 3)) as Array<{ text: string; prev_text: string }>;
      for (const r of rows) {
        if (out.length >= limit || seen.has(r.text)) continue;
        seen.add(r.text);
        out.push({ them: r.prev_text, me: r.text, scope });
        if (out.filter((o) => o.scope === scope).length >= n) break;
      }
    };
    add('chat_id = ?', chatId, 'chat', 6);
    add("chat_id IN (SELECT id FROM chats WHERE platform = ? AND kind = 'direct')", platform, 'platform', 4);
    add("chat_id IN (SELECT id FROM chats WHERE kind = 'direct')", null, 'all', limit);
    return out;
  }

  /** Son yazdığım mesajlar (üslup istatistiği için; platform verilirse önce o platform) */
  myTexts(platform?: string, limit = 400): string[] {
    const sql = platform
      ? "SELECT m.text FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.from_me = 1 AND c.platform = ? AND length(m.text) > 1 ORDER BY m.ts DESC LIMIT ?"
      : 'SELECT text FROM messages WHERE from_me = 1 AND length(text) > 1 ORDER BY ts DESC LIMIT ?';
    const rows = (platform ? this.db.prepare(sql).all(platform, limit) : this.db.prepare(sql).all(limit)) as Array<{ text: string }>;
    return rows.map((r) => r.text);
  }

  search(q: string, limit = 50): Array<{ message: Message; chat: Chat }> {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ? ORDER BY m.ts DESC LIMIT ?`,
      )
      .all(ftsQuery(q), limit)
      .map(rowToMessage);
    // Ek (dosya) adlarında da ara: "fatura" → fatura-1042.pdf (FTS yalnız metni indeksler)
    const term = q.trim();
    if (term.length >= 3 && rows.length < limit) {
      const seen = new Set(rows.map((m) => m.id));
      const like = `%"name":"%${term.replace(/[\\%_"]/g, (c) => '\\' + c)}%`;
      const extra = this.db
        .prepare(`SELECT * FROM messages WHERE attachments IS NOT NULL AND attachments LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT ?`)
        .all(like, limit - rows.length)
        .map(rowToMessage)
        .filter((m) => !seen.has(m.id) && (m.attachments ?? []).some((a) => (a.name ?? '').toLocaleLowerCase('tr-TR').includes(term.toLocaleLowerCase('tr-TR'))));
      rows.push(...extra);
      rows.sort((a, b) => b.ts - a.ts);
    }
    return rows.flatMap((message) => {
      const chat = this.getChat(message.chatId);
      return chat ? [{ message, chat }] : [];
    });
  }

  // ---------- takvim ----------
  listEvents(from?: string, to?: string): CalEvent[] {
    const rows = from && to ? this.db.prepare('SELECT * FROM events WHERE start >= ? AND start < ? ORDER BY start').all(from, to) : this.db.prepare('SELECT * FROM events ORDER BY start').all();
    return rows.map(rowToEvent);
  }

  getEvent(id: string): CalEvent | undefined {
    const r = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    return r ? rowToEvent(r) : undefined;
  }

  saveEvent(ev: CalEvent): CalEvent {
    this.db
      .prepare(
        `INSERT INTO events (id, title, start, duration_min, all_day, notes, location, chat_id, message_id, remind_min, reminded, device_calendar, created_at)
         VALUES (@id, @title, @start, @durationMin, @allDay, @notes, @location, @chatId, @messageId, @remindMin, 0, @deviceCalendar, @createdAt)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, start = excluded.start, duration_min = excluded.duration_min, all_day = excluded.all_day,
           notes = excluded.notes, location = excluded.location, remind_min = excluded.remind_min,
           reminded = CASE WHEN events.start = excluded.start AND events.remind_min IS excluded.remind_min THEN events.reminded ELSE 0 END,
           device_calendar = COALESCE(excluded.device_calendar, events.device_calendar)`,
      )
      .run({
        id: ev.id,
        title: ev.title,
        start: ev.start,
        durationMin: ev.durationMin ?? 60,
        allDay: ev.allDay ? 1 : 0,
        notes: ev.notes ?? null,
        location: ev.location ?? null,
        chatId: ev.chatId ?? null,
        messageId: ev.messageId ?? null,
        remindMin: ev.remindMin ?? null,
        deviceCalendar: ev.deviceCalendar ?? null,
        createdAt: ev.createdAt,
      });
    return this.getEvent(ev.id)!;
  }

  deleteEvent(id: string): boolean {
    return this.db.prepare('DELETE FROM events WHERE id = ?').run(id).changes > 0;
  }

  /** Hatırlatma zamanı gelmiş (başlangıç − remind_min ≤ şimdi) ve henüz bildirilmemiş etkinlikler; bir kez işaretlenir */
  dueEventReminders(now = new Date()): CalEvent[] {
    const out: CalEvent[] = [];
    const rows = this.db.prepare('SELECT * FROM events WHERE reminded = 0 AND remind_min IS NOT NULL AND all_day = 0').all().map(rowToEvent);
    for (const ev of rows) {
      const start = localDate(ev.start);
      if (!start) continue;
      const at = start.getTime() - (ev.remindMin ?? 0) * 60_000;
      // geçmişte kalmış (çekirdek kapalıydı) etkinlik için geç hatırlatma yapma: başlangıçtan 30 dk sonrasına kadar
      if (at <= now.getTime() && now.getTime() - start.getTime() < 30 * 60_000) out.push(ev);
      if (at <= now.getTime()) this.db.prepare('UPDATE events SET reminded = 1 WHERE id = ?').run(ev.id);
    }
    return out;
  }

  stats(): { accounts: number; chats: number; messages: number; unread: number } {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    return {
      accounts: one('SELECT COUNT(*) AS n FROM accounts'),
      chats: one('SELECT COUNT(*) AS n FROM chats'),
      messages: one('SELECT COUNT(*) AS n FROM messages'),
      unread: one('SELECT COALESCE(SUM(unread),0) AS n FROM chats'),
    };
  }

  close(): void {
    this.db.close();
  }
}

function ftsQuery(q: string): string {
  // Her kelimeyi tırnaklayıp önek araması yap: "sözleş"* gibi
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w.replace(/"/g, '""')}"*`)
    .join(' ');
}

function localDate(start: string): Date | null {
  // eski kayıtlar "YYYY-MM-DD HH:mm" (boşluklu) olabilir: parseStart ile aynı biçimleri kabul et
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(start.trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
}

function rowToEvent(r: unknown): CalEvent {
  const x = r as Record<string, unknown>;
  return {
    id: String(x.id),
    title: String(x.title),
    start: String(x.start),
    durationMin: Number(x.duration_min),
    allDay: !!x.all_day,
    notes: (x.notes as string | null) ?? undefined,
    location: (x.location as string | null) ?? undefined,
    chatId: (x.chat_id as string | null) ?? undefined,
    messageId: (x.message_id as string | null) ?? undefined,
    remindMin: x.remind_min === null || x.remind_min === undefined ? undefined : Number(x.remind_min),
    deviceCalendar: (x.device_calendar as string | null) ?? undefined,
    createdAt: Number(x.created_at),
  };
}

function rowToAccount(r: unknown): Account {
  const x = r as Record<string, unknown>;
  return {
    id: String(x.id),
    platform: x.platform as Platform,
    label: String(x.label),
    status: x.status as Account['status'],
    detail: (x.detail as string | null) ?? undefined,
    createdAt: Number(x.created_at),
  };
}

function rowToChat(r: unknown): Chat {
  const x = r as Record<string, unknown>;
  return {
    id: String(x.id),
    accountId: String(x.account_id),
    platform: x.platform as Platform,
    remoteId: String(x.remote_id),
    name: String(x.name),
    kind: x.kind as Chat['kind'],
    unread: Number(x.unread),
    lastMessageAt: Number(x.last_message_at),
    lastPreview: String(x.last_preview),
    lastFromMe: Number(x.last_from_me ?? 0) === 1,
    readUpto: Number(x.read_upto ?? 0) || undefined,
    avatarUrl: (x.avatar_url as string | null) ?? undefined,
    tags: safeJson<string[]>(x.tags as string, []),
    handle: (x.handle as string | null) ?? undefined,
    link: (x.link as string | null) ?? undefined,
    participants: x.participants ? safeJson<Chat['participants']>(x.participants as string, undefined) : undefined,
    meta: x.meta ? safeJson<Chat['meta']>(x.meta as string, undefined) : undefined,
    ...(x.flags ? safeJson<ChatFlags>(x.flags as string, {}) : {}),
    followUp: x.followup ? (safeJson<FollowUp | null>(x.followup as string, null) ?? undefined) : undefined,
  };
}

function rowToMessage(r: unknown): Message {
  const x = r as Record<string, unknown>;
  return {
    id: String(x.id),
    chatId: String(x.chat_id),
    remoteId: String(x.remote_id),
    senderId: String(x.sender_id),
    senderName: String(x.sender_name),
    fromMe: Number(x.from_me) === 1,
    text: String(x.text),
    ts: Number(x.ts),
    status: x.status as Message['status'],
    attachments: x.attachments ? safeJson(x.attachments as string, undefined) : undefined,
    senderAvatarUrl: x.sender_avatar ? String(x.sender_avatar) : undefined,
    reactions: x.reactions ? safeJson<Reaction[] | undefined>(x.reactions as string, undefined) : undefined,
    threadId: x.thread_id ? String(x.thread_id) : undefined,
    replyCount: x.reply_count != null ? Number(x.reply_count) : undefined,
  };
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
