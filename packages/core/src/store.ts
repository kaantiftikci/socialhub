import { bus } from './bus.js';
import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs';
import { DB_PATH } from './config.js';
import { ML_SCHEMA, searchTranscripts } from './ml/ml-store.js';
import { DELETED_TEXT, type Account, type CalEvent, type Chat, type ChatFlags, type FollowUp, type Message, type Platform, type Reaction } from './model.js';

/**
 * Yerel SQLite deposu. Şema küçük tutuldu; FTS5 ile tam metin arama var.
 * Üretimde SQLCipher ile şifrelenir (anahtar Keychain'de) — bu demo düz SQLite kullanır.
 */
export class Store {
  private db: Database.Database;
  /**
   * Hazır sorgu önbelleği: SQL her çağrıda yeniden derlenmesin. Geçmiş eşitlemesinde mesaj başına 5-8 sorgu çalışıyor
   * (on binlerce mesajda derleme maliyeti olay döngüsünü saniyelerce kilitliyordu). Tüm SQL'ler sabit metin → sınırlı sayıda.
   */
  private stmts = new Map<string, Database.Statement>();
  private stmt(sql: string): Database.Statement {
    let st = this.stmts.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.stmts.set(sql, st);
    }
    return st;
  }

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
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages WHEN old.text IS NOT new.text BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
    `);
    // hafif göç: sonradan eklenen sütunlar
    const cols = new Set((this.stmt('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has('sender_avatar')) this.db.exec('ALTER TABLE messages ADD COLUMN sender_avatar TEXT');
    if (!cols.has('reactions')) this.db.exec('ALTER TABLE messages ADD COLUMN reactions TEXT');
    if (!cols.has('thread_id')) this.db.exec('ALTER TABLE messages ADD COLUMN thread_id TEXT');
    if (!cols.has('reply_count')) this.db.exec('ALTER TABLE messages ADD COLUMN reply_count INTEGER');
    if (!cols.has('reply_to')) this.db.exec('ALTER TABLE messages ADD COLUMN reply_to TEXT'); // alıntılı yanıt (JSON ReplyRef)
    if (!cols.has('html')) this.db.exec('ALTER TABLE messages ADD COLUMN html TEXT'); // e-posta özgün HTML gövdesi
    if (!cols.has('edited')) this.db.exec('ALTER TABLE messages ADD COLUMN edited INTEGER'); // gönderildikten sonra düzenlendi
    if (!cols.has('deleted')) this.db.exec('ALTER TABLE messages ADD COLUMN deleted INTEGER'); // herkesten silindi
    const ccols = new Set((this.stmt('PRAGMA table_info(chats)').all() as Array<{ name: string }>).map((c) => c.name));
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
    // önizleme bir tepkiyi anlatıyor ("❤️ Ayşe mesajına tepki verdi"): mesaj değil → listede tik yok, okunmamış sayılmaz
    if (!ccols.has('last_reaction')) this.db.exec('ALTER TABLE chats ADD COLUMN last_reaction INTEGER NOT NULL DEFAULT 0');
    // gönderen bazlı güncellemeler (ad/fotoğraf/lid→numara) tam tablo taraması yapmasın
    this.db.exec('CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender_id)');
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    // Sonradan eklenen dizinler (ilk açılışta bir kez kurulur; 300 bin şifreli mesajda toplam ~3-4 sn, sonra anında):
    // - messages_remote: findMessageByRemote (WhatsApp alındı yedeği, Telegram silme) her çağrıda tüm tabloyu tarıyordu
    // - messages_ts / messages_att: genel arama tüm FTS eşleşmelerini sıralıyor, ek adları için tabloyu baştan sona tarıyordu
    // - messages_mine: AI taslağı/üslup (myTexts, styleSamples) kendi mesajlarımı tüm geçmişte arıyordu
    const idx = new Set((this.stmt("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name));
    const want: Array<[string, string]> = [
      ['messages_remote', 'CREATE INDEX IF NOT EXISTS messages_remote ON messages(remote_id)'],
      ['messages_ts', 'CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts)'],
      ['messages_att', 'CREATE INDEX IF NOT EXISTS messages_att ON messages(ts, attachments) WHERE attachments IS NOT NULL'],
      ['messages_mine', 'CREATE INDEX IF NOT EXISTS messages_mine ON messages(ts, chat_id) WHERE from_me = 1'],
    ];
    const missing = want.filter(([n]) => !idx.has(n));
    if (missing.length) {
      const t0 = Date.now();
      for (const [, sql] of missing) this.db.exec(sql);
      const ms = Date.now() - t0;
      if (ms > 200) bus.log('info', `Veritabanı dizinleri oluşturuldu (${missing.map(([n]) => n).join(', ')}; ${ms} ms, bir kez)`);
    }
    // FTS güncelleme tetikleyicisi metin DEĞİŞMEDİĞİNDE de çalışıyordu (her yeniden upsert'te FTS'ye sil+ekle, dizin şişmesi):
    // eski kurulumlarda tetikleyici WHEN koşuluyla yeniden kurulur (CREATE ... IF NOT EXISTS var olanı değiştirmez)
    if (!this.flag('fts_au_when_v1')) {
      this.db.exec(`DROP TRIGGER IF EXISTS messages_au;
        CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages WHEN old.text IS NOT new.text BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
          INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
        END;`);
      this.setFlag('fts_au_when_v1');
    }
    // Katılımcı listesi ayrı tabloda: büyük gruplarda (50-300 KB JSON) chats satırında durunca her mesajın özet UPDATE'i satırı ve
    // taşma sayfalarını baştan yazdırıyordu (SQLCipher her sayfayı yeniden şifreler). chats.participants sütunu kalır (boş).
    this.db.exec('CREATE TABLE IF NOT EXISTS chat_participants (chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE, json TEXT NOT NULL)');
    if (!this.flag('participants_table_v1')) {
      this.transaction(() => {
        this.db.exec("INSERT OR REPLACE INTO chat_participants (chat_id, json) SELECT id, participants FROM chats WHERE participants IS NOT NULL AND participants <> ''");
        this.db.exec('UPDATE chats SET participants = NULL WHERE participants IS NOT NULL');
        this.setFlag('participants_table_v1');
      });
    }
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
      const rows = this
        .stmt("SELECT id, chat_id FROM messages WHERE chat_id LIKE 'instagram:%' AND text LIKE '@%: %' AND attachments IS NOT NULL AND (attachments LIKE '%\"name\":\"Reels%' OR attachments LIKE '%\"name\":\"Gönderi%' OR attachments LIKE '%\"name\":\"Video%')")
        .all() as Array<{ id: string; chat_id: string }>;
      const touched = new Set<string>();
      this.db.transaction(() => {
        for (const r of rows) {
          this.stmt("UPDATE messages SET text = '' WHERE id = ?").run(r.id);
          touched.add(r.chat_id);
        }
        for (const cid of touched) {
          const chat = this.getChat(cid);
          const last = this.stmt('SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT 1').get(cid);
          if (!chat || !last) continue;
          const m = rowToMessage(last);
          const body = m.text || (m.attachments?.length ? `[${m.attachments[0].name ?? m.attachments[0].kind}]` : '');
          const preview = chat.kind !== 'direct' && body ? `${m.fromMe ? 'Sen' : (m.senderName || '').split(/\s+/)[0] || '?'}: ${body}` : body;
          this.stmt('UPDATE chats SET last_preview = ? WHERE id = ?').run(preview, cid);
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
      const rows = this.stmt("SELECT c.id, m.from_me, m.sender_name, m.text, m.attachments FROM chats c JOIN messages m ON m.id = (SELECT id FROM messages WHERE chat_id = c.id ORDER BY ts DESC, rowid DESC LIMIT 1) WHERE c.kind IN ('group','channel')").all() as Array<{ id: string; from_me: number; sender_name: string; text: string; attachments: string | null }>;
      const upd = this.stmt('UPDATE chats SET last_preview = ? WHERE id = ?');
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
      WHERE platform IN ('messenger','x','instagram','linkedin','slack','tiktok')
        AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = chats.id)
        AND last_message_at > (SELECT MAX(ts) FROM messages m WHERE m.chat_id = chats.id) + 600000`);
    // ---- Kişi birleştirme (people.ts) ----
    // kişi ↔ birebir sohbetler; sohbet silinince bağ da gider (CASCADE), iki sohbetten azı kalan kişi prunePeople ile silinir.
    // people_dismissed: reddedilen öneriler sohbet çifti olarak (a < b) kalıcı
    this.db.exec(`CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', avatar_chat TEXT, note TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS person_chats (chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE, person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE, linked_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS person_chats_person ON person_chats(person_id);
      CREATE TABLE IF NOT EXISTS people_dismissed (a TEXT NOT NULL, b TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (a, b));`);
    // ---- yerel ML (ml/ml-store.ts): sesli mesaj metni + FTS, gömmeler, çeviriler; messages(id)'ye CASCADE bağlı ----
    this.db.exec(ML_SCHEMA);
  }

  /** Yerel ML tabloları (ml/ml-store.ts) için hazır sorgu */
  mlStmt(text: string): Database.Statement {
    return this.stmt(text);
  }

  /** Kişi birleştirme (people.ts) için hazır sorgu: kişi tabloları bu modülün dışında yönetilir */
  sql(text: string): Database.Statement {
    return this.stmt(text);
  }

  /** İki sohbetten azı kalan kişileri sil (hesap kaldırma, sohbet birleştirme/silme sonrası; bir kişi = en az iki sohbet) */
  prunePeople(): number {
    return this.stmt('DELETE FROM people WHERE (SELECT COUNT(*) FROM person_chats pc WHERE pc.person_id = people.id) < 2').run().changes;
  }

  flag(key: string): boolean {
    return !!this.stmt('SELECT 1 FROM meta WHERE key = ?').get(key);
  }

  /** meta tablosundaki değer (yoksa undefined) */
  meta(key: string): string | undefined {
    return (this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined)?.value;
  }

  /** Hesap başına okunmamış toplamı ve son etkinlik (açılış sırası için) */
  accountActivity(): Map<string, { unread: number; lastAt: number }> {
    const rows = this.stmt('SELECT account_id AS id, SUM(unread) AS unread, MAX(last_message_at) AS lastAt FROM chats GROUP BY account_id').all() as Array<{ id: string; unread: number | null; lastAt: number | null }>;
    return new Map(rows.map((r) => [r.id, { unread: r.unread ?? 0, lastAt: r.lastAt ?? 0 }]));
  }

  setFlag(key: string, value = '1'): void {
    // kaldırılan hesabın arka planda durdurulan connector'ı (Slack imleci, boot_ms…) silinen '<önek>:<id>' anahtarını geri yazmasın
    // (registry.remove purge'ü logout/stop'tan ÖNCE başlatıyor). 'removing:' bayrağı purgeAccount'un kendisi yazar → serbest.
    if ((this.removing.size || this.purged.size) && !key.startsWith('removing:')) {
      for (const id of [...this.removing, ...this.purged]) if (key.length > id.length + 1 && key.endsWith(`:${id}`)) return;
    }
    this.stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Sohbetteki en eski mesajın zamanı (yoksa undefined) */
  /** Sohbetin (verilen zamandan önceki) en eski sunucu kimlikli mesajı — yerel ('local-') kayıtlar sayılmaz */
  oldestRealMessage(chatId: string, before?: number): Message | undefined {
    const r = before
      ? this.stmt("SELECT * FROM messages WHERE chat_id = ? AND ts < ? AND remote_id NOT LIKE 'local-%' ORDER BY ts ASC, rowid ASC LIMIT 1").get(chatId, before)
      : this.stmt("SELECT * FROM messages WHERE chat_id = ? AND remote_id NOT LIKE 'local-%' ORDER BY ts ASC, rowid ASC LIMIT 1").get(chatId);
    return r ? rowToMessage(r) : undefined;
  }

  oldestTs(chatId: string): number | undefined {
    const r = this.stmt('SELECT MIN(ts) AS t FROM messages WHERE chat_id = ?').get(chatId) as { t: number | null };
    return r?.t ?? undefined;
  }

  // ---------- accounts ----------
  upsertAccount(a: Account): void {
    // kaldırılan hesabın arka planda duran connector'ı durum yazınca hesap geri dirilmesin
    if (this.removing.has(a.id) || this.purged.has(a.id)) return;
    this
      .stmt(
        `INSERT INTO accounts (id, platform, label, status, detail, created_at) VALUES (@id, @platform, @label, @status, @detail, @createdAt)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, status = excluded.status, detail = excluded.detail`,
      )
      .run({ ...a, detail: a.detail ?? null });
  }

  listAccounts(): Account[] {
    const all = this.stmt('SELECT * FROM accounts ORDER BY created_at').all().map(rowToAccount);
    return this.removing.size ? all.filter((a) => !this.removing.has(a.id)) : all;
  }

  getAccount(id: string): Account | undefined {
    if (this.removing.has(id)) return undefined;
    const r = this.stmt('SELECT * FROM accounts WHERE id = ?').get(id);
    return r ? rowToAccount(r) : undefined;
  }

  /**
   * Kaldırılan hesaplar: listelerde/aramada hemen görünmez, verisi arka planda parça parça silinir (purgeAccount).
   * Eskiden tek işlemde 150 bin mesaj + FTS silinirken olay döngüsü saniyelerce kilitleniyor, "Kaldır" çalışmıyor sanılıyordu.
   */
  private removing = new Set<string>();
  private purged = new Set<string>();
  isRemoving(id: string): boolean {
    return this.removing.has(id);
  }
  /** Yarıda kalmış (çekirdek kapandı) kaldırmalar: açılışta devam edilecek hesaplar */
  pendingPurges(): string[] {
    return (this.stmt("SELECT key FROM meta WHERE key LIKE 'removing:%'").all() as Array<{ key: string }>).map((r) => r.key.slice('removing:'.length));
  }
  /** Hesabı hemen gizle, mesajlarını 2000'lik dilimlerle (arada olay döngüsüne dönerek) sil, sonra sohbetleri ve hesabı kaldır */
  async purgeAccount(id: string, step = 500): Promise<void> {
    this.removing.add(id);
    this.setFlag(`removing:${id}`);
    try {
      const del = this.stmt('DELETE FROM messages WHERE rowid IN (SELECT m.rowid FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.account_id = ? LIMIT ?)');
      // küçük dilimler + arada zamanlayıcı turu: silme sürerken HTTP istekleri (arayüz) bekletilmesin
      let total = 0;
      const t0 = Date.now();
      for (;;) {
        const n = del.run(id, step).changes;
        total += n;
        if (n < step) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      if (total) bus.log('info', `${id}: kaldırılan hesabın ${total} mesajı silindi (${Math.round((Date.now() - t0) / 1000)} sn)`);
      this.deleteAccount(id);
      this.purged.add(id);
      this.stmt('DELETE FROM meta WHERE key = ?').run(`removing:${id}`);
    } finally {
      this.removing.delete(id);
    }
  }

  /** "Tüm verileri sil" sürerken hesapları hemen gizle (listAccounts/listChats/arama/WS görmez) */
  hideAccounts(ids: string[]): void {
    for (const id of ids) this.removing.add(id);
  }

  /**
   * "Tüm verileri sil": her şey tek işlemde. Satır başına çalışan tetikleyiciler (FTS silme, medya kütüphanesi kuyruğu)
   * silme süresince kaldırılıp sonra aynen geri kurulur — 300 bin mesajda satır satır tetikleyici + dilimli hesap silme
   * dakikalar sürüyor, arayüz yarım kalmış durumu görüp hata veriyordu (Kaan, 01.10). Silinen içerik secure_delete ile
   * sıfırlanır; uzun süren (olay döngüsünü kilitleyen) VACUUM yapılmaz.
   */
  wipeAll(): void {
    const has = (t: string) => !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table') AND name = ?").get(t);
    const triggers = this.db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('messages', 'transcripts') AND sql IS NOT NULL")
      .all() as Array<{ name: string; sql: string }>;
    // bağlı tablolar önce boşaltılıyor; yabancı anahtar denetimi kapalıyken tam tablo silme satır satır CASCADE aramaz (3×)
    const fk = this.db.pragma('foreign_keys', { simple: true });
    this.db.pragma('foreign_keys = OFF');
    this.db.pragma('secure_delete = ON');
    try {
      this.db.transaction(() => {
        for (const t of triggers) this.db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);
        // önce mesajlara bağlı tablolar (CASCADE satır satır çalışmasın), sonra tam tablo silmeleri
        for (const t of ['transcripts', 'embeddings', 'translations', 'library_items', 'library_dirty'])
          if (has(t)) this.db.exec(`DELETE FROM ${t}`);
        for (const t of ['messages', 'person_chats', 'people', 'people_dismissed', 'chat_participants', 'chats', 'accounts', 'events', 'meta']) this.db.exec(`DELETE FROM ${t}`);
        this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('delete-all')");
        if (has('transcripts_fts')) this.db.exec("INSERT INTO transcripts_fts(transcripts_fts) VALUES ('delete-all')");
        for (const t of triggers) this.db.exec(t.sql);
      })();
    } finally {
      this.db.pragma('secure_delete = OFF');
      if (fk) this.db.pragma('foreign_keys = ON');
    }
    // kapanması zaman aşımına uğrayan bir connector'ın geç yazımı hesabı geri getirmesin
    for (const id of this.removing) this.purged.add(id);
    this.removing.clear();
  }

  deleteAccount(id: string): void {
    this.db.transaction(() => {
      this.stmt('DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE account_id = ?)').run(id);
      this.stmt('DELETE FROM chats WHERE account_id = ?').run(id);
      this.stmt('DELETE FROM accounts WHERE id = ?').run(id);
      // hesaba bağlı meta anahtarları ('<önek>:<id>': slack_last, boot_ms, wa_twins_v1, wa_viewonce_v1…) de gitsin;
      // aynı kimlikle yeniden eklenen hesap eski bayrakları devralmasın. Yalnız TAM olarak ':'+id ile bitenler
      // (LIKE yerine substr: kimlikteki %/_ joker sayılmasın). 'removing:' purgeAccount'ta ayrıca silinir → burada dokunulmaz.
      this.stmt(
        `DELETE FROM meta WHERE length(key) > length(@id) + 1 AND substr(key, -length(@id) - 1) = ':' || @id AND key <> 'removing:' || @id`,
      ).run({ id });
      // kişi birleştirme: sohbet bağları CASCADE ile gitti; tek sohbeti kalan kişi ve hesabın reddedilmiş önerileri de silinir
      this.prunePeople();
      this.stmt(`DELETE FROM people_dismissed WHERE substr(a, 1, length(@id) + 1) = @id || '/' OR substr(b, 1, length(@id) + 1) = @id || '/'`).run({ id });
    })();
  }

  // ---------- chats ----------
  upsertChat(c: Chat): Chat {
    this.transaction(() => this.writeChat(c));
    return this.getChat(c.id)!;
  }

  private writeChat(c: Chat): void {
    this
      .stmt(
        `INSERT INTO chats (id, account_id, platform, remote_id, name, kind, unread, last_message_at, last_preview, avatar_url, tags, handle, link, meta, last_from_me)
         VALUES (@id, @accountId, @platform, @remoteId, @name, @kind, @unread, @lastMessageAt, @lastPreview, @avatarUrl, @tags, @handle, @link, @meta, @lastFromMe)
         ON CONFLICT(id) DO UPDATE SET
           name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE chats.name END,
           kind = excluded.kind,
           unread = CASE WHEN MAX(chats.last_message_at, excluded.last_message_at) <= chats.read_upto THEN 0 ELSE excluded.unread END,
           last_message_at = MAX(chats.last_message_at, excluded.last_message_at),
           last_preview = CASE WHEN excluded.last_message_at >= chats.last_message_at THEN excluded.last_preview ELSE chats.last_preview END,
           last_reaction = CASE WHEN excluded.last_message_at >= chats.last_message_at AND excluded.last_preview <> chats.last_preview THEN 0 ELSE chats.last_reaction END,
           avatar_url = COALESCE(excluded.avatar_url, chats.avatar_url),
           handle = COALESCE(excluded.handle, chats.handle),
           link = COALESCE(excluded.link, chats.link),
           meta = COALESCE(excluded.meta, chats.meta)`,
      )
      .run({
        id: c.id,
        accountId: c.accountId,
        platform: c.platform,
        remoteId: c.remoteId,
        name: c.name,
        kind: c.kind,
        unread: c.unread,
        lastMessageAt: c.lastMessageAt,
        lastPreview: c.lastPreview,
        avatarUrl: c.avatarUrl ?? null,
        tags: JSON.stringify(c.tags ?? []),
        handle: c.handle ?? null,
        link: c.link ?? null,
        meta: c.meta ? JSON.stringify(c.meta) : null,
        lastFromMe: c.lastFromMe ? 1 : 0,
      });
    // katılımcılar yalnız verildiyse ve değiştiyse yazılır (verilmezse eskisi kalır; önceki COALESCE davranışı)
    if (c.participants) {
      this
        .stmt('INSERT INTO chat_participants (chat_id, json) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json WHERE chat_participants.json IS NOT excluded.json')
        .run(c.id, JSON.stringify(c.participants));
    }
  }

  /** Bir sohbetin mesajlarını başka bir sohbete taşı ve kaynağı sil (aynı kişinin lid/numara kopyaları). */
  mergeChats(fromId: string, toId: string): void {
    if (fromId === toId) return;
    this.db.transaction(() => {
      const rows = this.stmt('SELECT id, remote_id FROM messages WHERE chat_id = ?').all(fromId) as Array<{ id: string; remote_id: string }>;
      for (const r of rows) {
        const newId = `${toId}#${r.remote_id}`;
        if (this.hasMessage(newId)) this.stmt('DELETE FROM messages WHERE id = ?').run(r.id);
        else this.stmt('UPDATE messages SET id = ?, chat_id = ? WHERE id = ?').run(newId, toId, r.id);
      }
      const from = this.getChat(fromId);
      const to = this.getChat(toId);
      if (from && to) {
        this
          .stmt('UPDATE chats SET unread = unread + ?, last_message_at = MAX(last_message_at, ?), last_preview = CASE WHEN ? > last_message_at THEN ? ELSE last_preview END, avatar_url = COALESCE(avatar_url, ?) WHERE id = ?')
          .run(from.unread, from.lastMessageAt, from.lastMessageAt, from.lastPreview, from.avatarUrl ?? null, toId);
      }
      // kişi birleştirme: kaynağın kişi bağı hedefe taşınır (hedef zaten bir kişideyse kaynağınki düşer)
      this.stmt('UPDATE OR IGNORE person_chats SET chat_id = ? WHERE chat_id = ?').run(toId, fromId);
      this.stmt('DELETE FROM chats WHERE id = ?').run(fromId);
      this.prunePeople();
    })();
  }

  /** Bir gönderenin adını/fotoğrafını geçmiş mesajlarda güncelle (rehber adı sonradan öğrenilince). */
  renameSender(accountId: string, senderId: string, name: string, avatar?: string): void {
    this
      .stmt(`UPDATE messages SET sender_name = ?, sender_avatar = COALESCE(?, sender_avatar) WHERE sender_id = ? AND chat_id LIKE ? AND from_me = 0 AND sender_name <> ?`)
      .run(name, avatar ?? null, senderId, accountId + '/%', name);
  }

  /** Gönderdiğim mesajlar `before` zamanına kadar karşı tarafça görüldü; değişen satır sayısını döndürür */
  markOutgoingRead(chatId: string, before: number): number {
    return this.stmt("UPDATE messages SET status = 'read' WHERE chat_id = ? AND from_me = 1 AND ts <= ? AND status <> 'read'").run(chatId, before).changes;
  }

  /** Telegram gibi sayısal artan mesaj kimliği olan platformlarda: kimliği <= maxId olan giden mesajlar görüldü; en yeni etkilenen ts döner */
  markOutgoingReadUpToId(chatId: string, maxId: number): number | undefined {
    const r = this.stmt("SELECT MAX(ts) AS t FROM messages WHERE chat_id = ? AND from_me = 1 AND CAST(remote_id AS INTEGER) <= ? AND status <> 'read'").get(chatId, maxId) as { t: number | null };
    if (!r?.t) return undefined;
    this.stmt("UPDATE messages SET status = 'read' WHERE chat_id = ? AND from_me = 1 AND CAST(remote_id AS INTEGER) <= ? AND status <> 'read'").run(chatId, maxId);
    return r.t;
  }

  /** Bir gönderen kimliğini başka bir kimliğe taşı (lid → telefon numarası öğrenilince). */
  rewriteSender(accountId: string, fromId: string, toId: string): void {
    if (fromId === toId) return;
    this.stmt('UPDATE messages SET sender_id = ? WHERE sender_id = ? AND chat_id LIKE ?').run(toId, fromId, accountId + '/%');
  }

  getChat(id: string): Chat | undefined {
    const r = this.stmt(`SELECT *, ${PJSON}, ${LAST_STATUS} FROM chats WHERE id = ?`).get(id);
    return r ? rowToChat(r) : undefined;
  }

  /**
   * Katılımcı sütunu OLMADAN sohbet (büyük gruplarda o sütunu okumak tek başına ~45 µs; mesaj başına çağrılan yollar için).
   * Arayüze giden demette sohbetin tam hali yayın anında bir kez okunur (server.ts).
   */
  getChatLite(id: string): Chat | undefined {
    const r = this.stmt(
      `SELECT id, account_id, platform, remote_id, name, kind, unread, last_message_at, last_preview, last_from_me, last_reaction, read_upto, avatar_url, tags, handle, link, meta, flags, followup, ${LAST_STATUS} FROM chats WHERE id = ?`,
    ).get(id);
    return r ? rowToChat(r) : undefined;
  }

  /** Önizleme bir tepkiyi anlatır (mesaj değil): sıra, okunmamış ve "son mesaj benden" değişmez; sonraki gerçek mesaj ezer */
  setReactionPreview(id: string, text: string): boolean {
    return this.stmt('UPDATE chats SET last_preview = ?, last_reaction = 1 WHERE id = ? AND (last_preview <> ? OR last_reaction = 0)').run(text, id, text).changes > 0;
  }

  /** Sohbet var mı (JSON sütunları çözülmeden; sık çağrılan yollar için) */
  hasChat(id: string): boolean {
    return !!this.stmt('SELECT 1 FROM chats WHERE id = ?').get(id);
  }

  /**
   * Arayüze giden sohbetler: HESAP BAŞINA en yeni `perAccount` (eskiden tümünde toplam 600 → çok sohbetli WhatsApp, iMessage'ın
   * eski/klasördeki sohbetlerini listeden atıyordu). Okunmamış, işaretli (sabit/arşiv/sessiz), takipte ve iMessage klasörü/Son
   * Silinenler'deki sohbetler sınırdan bağımsız hep gelir.
   */
  listChats(perAccount = 3000): Chat[] {
    const rows = this
      .stmt(
        `SELECT *, ${PJSON}, ${LAST_STATUS} FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY last_message_at DESC) AS rn FROM chats) AS chats
          WHERE rn <= ? OR unread > 0 OR flags IS NOT NULL OR followup IS NOT NULL
             OR (platform = 'imessage' AND (meta LIKE '%"folder"%' OR meta LIKE '%"deleted"%'))
          ORDER BY last_message_at DESC`,
      )
      .all(perAccount)
      .map(rowToChat);
    return this.removing.size ? rows.filter((c) => !this.removing.has(c.accountId)) : rows;
  }

  /** Bir hesabın tüm sohbetleri (sınırsız; connector içi toplu işlemler için). */
  listChatsOf(accountId: string): Chat[] {
    return this.stmt(`SELECT *, ${PJSON} FROM chats WHERE account_id = ? ORDER BY last_message_at DESC`).all(accountId).map(rowToChat);
  }

  /** Sohbet Mivelo'da okundu: sayaç 0 ve okuma noktası = son mesaj zamanı (kalıcı; yeni mesaj gelene dek platform geri açamaz) */
  markRead(id: string): void {
    this.stmt('UPDATE chats SET unread = 0, read_upto = MAX(read_upto, last_message_at) WHERE id = ?').run(id);
  }

  setTags(id: string, tags: string[]): void {
    this.stmt('UPDATE chats SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id);
  }

  // ---------- messages ----------
  /** Mesajı kaydeder; sohbetin özetini (son mesaj, okunmamış) günceller. Yeni eklendiyse true döner. */
  upsertMessage(m: Message, opts: { bumpUnread?: boolean; html?: string } = {}): boolean {
    const existed = this.hasMessage(m.id);
    const row = this
      .stmt(
        `INSERT INTO messages (id, chat_id, remote_id, sender_id, sender_name, from_me, text, ts, status, attachments, sender_avatar, reactions, thread_id, reply_count, reply_to, html, edited, deleted)
         VALUES (@id, @chatId, @remoteId, @senderId, @senderName, @fromMe, @text, @ts, @status, @attachments, @senderAvatar, @reactions, @threadId, @replyCount, @replyTo, @html, @edited, @deleted)
         ON CONFLICT(id) DO UPDATE SET
           -- durum geri gitmez (tüm platformlar): yeniden eşitleme/yoklama "görüldü"yü "gönderildi"ye indirmesin; başarısız yalnız henüz
           -- iletilmemiş mesajın yerini alır, başarısızdan sonra gelen gerçek durum ise yazılır
           status = CASE
             WHEN excluded.status = 'failed' THEN CASE WHEN messages.status IN ('pending', 'sent', 'failed') THEN 'failed' ELSE messages.status END
             WHEN (CASE excluded.status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END)
                  >= (CASE messages.status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 WHEN 'failed' THEN -1 ELSE 0 END)
               THEN excluded.status
             ELSE messages.status END,
           -- herkesten silinen mesaj yeniden eşitlemede eski metnine/eklerine dönmez; düzenlenmiş metni düzenleme bilgisi taşımayan
           -- (özgün metinli) geçmiş kaydı ezmez
           text = CASE
             WHEN messages.deleted = 1 AND COALESCE(excluded.deleted, 0) = 0 THEN messages.text
             WHEN messages.edited = 1 AND COALESCE(excluded.edited, 0) = 0 AND COALESCE(excluded.deleted, 0) = 0 THEN messages.text
             WHEN excluded.text <> '' THEN excluded.text WHEN excluded.attachments IS NOT NULL THEN '' ELSE messages.text END,
           attachments = CASE WHEN messages.deleted = 1 THEN messages.attachments ELSE COALESCE(excluded.attachments, messages.attachments) END,
           edited = CASE WHEN excluded.edited = 1 OR messages.edited = 1 THEN 1 ELSE NULL END,
           deleted = CASE WHEN excluded.deleted = 1 OR messages.deleted = 1 THEN 1 ELSE NULL END,
           sender_avatar = COALESCE(excluded.sender_avatar, messages.sender_avatar),
           sender_name = CASE WHEN excluded.sender_name <> '' THEN excluded.sender_name ELSE messages.sender_name END,
           reactions = COALESCE(excluded.reactions, messages.reactions),
           thread_id = COALESCE(excluded.thread_id, messages.thread_id),
           reply_count = COALESCE(excluded.reply_count, messages.reply_count),
           reply_to = COALESCE(excluded.reply_to, messages.reply_to),
           html = COALESCE(excluded.html, messages.html)
         RETURNING text, attachments`,
      )
      .get({
        ...m,
        fromMe: m.fromMe ? 1 : 0,
        attachments: m.attachments ? JSON.stringify(m.attachments) : null,
        senderAvatar: m.senderAvatarUrl ?? null,
        reactions: m.reactions ? JSON.stringify(m.reactions) : null,
        threadId: m.threadId ?? null,
        replyCount: m.replyCount ?? null,
        replyTo: m.replyTo ? JSON.stringify(m.replyTo) : null,
        html: opts.html ? opts.html.slice(0, 1_500_000) : null,
        edited: m.edited ? 1 : null,
        deleted: m.deleted ? 1 : null,
      }) as { text: string; attachments: string | null } | undefined;
    const inserted = !existed;
    const saved = existed ? row : undefined;
    // yalnız özet sütunları (katılımcı/meta JSON'u çözülmez: mesaj başına çalışan en sık yol)
    const chat = this.stmt('SELECT kind, unread, last_message_at, last_preview, last_from_me, read_upto, last_reaction FROM chats WHERE id = ?').get(m.chatId) as
      | { kind: string; unread: number; last_message_at: number; last_preview: string; last_from_me: number; read_upto: number; last_reaction: number }
      | undefined;
    if (chat) {
      // önizleme DEPODAKİ halden: silinen/düzenlenen mesaj özgün metinle yeniden eşitlenince listede eski içerik görünmesin
      const text = saved ? saved.text : m.text;
      const atts: Message['attachments'] = saved ? (saved.attachments ? safeJson<Message['attachments']>(saved.attachments, undefined) : undefined) : m.attachments;
      const body = text || (atts?.length ? `[${atts[0].name ?? atts[0].kind}]` : '');
      // grup/kanalda önizlemede kim yazdı görünsün: "Ali: mesaj" / "Sen: mesaj"
      const preview = chat.kind !== 'direct' && body ? `${m.fromMe ? 'Sen' : (m.senderName || '').split(/\s+/)[0] || '?'}: ${body}` : body;
      const last = Number(chat.last_message_at);
      // var olan son mesajın yeniden yazımı tepki önizlemesini ("❤️ Ayşe mesajına tepki verdi") silmez; yalnız yeni mesaj ezer
      const isNewer = m.ts >= last && (inserted || Number(chat.last_reaction ?? 0) !== 1);
      const unread = opts.bumpUnread && inserted && !m.fromMe && m.ts > Number(chat.read_upto ?? 0) ? Number(chat.unread) + 1 : Number(chat.unread);
      // eski bir mesajın yeniden yazımı özeti değiştirmez: boşuna UPDATE yok (iMessage açılışta 60 bin mesajı yeniden yazıyor)
      if (!isNewer && m.ts <= last && unread === Number(chat.unread)) return inserted;
      this
        .stmt('UPDATE chats SET last_message_at = ?, last_preview = ?, unread = ?, last_from_me = ?, last_reaction = CASE WHEN ? THEN 0 ELSE last_reaction END WHERE id = ?')
        .run(
          Math.max(last, m.ts),
          isNewer ? preview : chat.last_preview,
          unread,
          isNewer ? (m.fromMe ? 1 : 0) : Number(chat.last_from_me ?? 0) === 1 ? 1 : 0,
          isNewer ? 1 : 0,
          m.chatId,
        );
    }
    return inserted;
  }

  /** Hesabın herhangi bir sohbetinde platform kimliğiyle mesaj (WhatsApp alındısı LID/numara farklı sohbet kimliğiyle gelebiliyor) */
  findMessageByRemote(accountId: string, remoteId: string): Message | undefined {
    const r = this.stmt("SELECT id FROM messages WHERE remote_id = ? AND chat_id LIKE ? ESCAPE '\\' LIMIT 1").get(remoteId, accountId.replace(/[\\%_]/g, (c) => '\\' + c) + '/%') as { id: string } | undefined;
    return r ? this.getMessage(r.id) : undefined;
  }

  /** E-postanın özgün HTML gövdesi (yoksa undefined) */
  getMessageHtml(id: string): string | undefined {
    const r = this.stmt('SELECT html FROM messages WHERE id = ?').get(id) as { html?: string | null } | undefined;
    return r?.html ?? undefined;
  }

  getMessage(id: string): Message | undefined {
    const r = this.stmt('SELECT * FROM messages WHERE id = ?').get(id);
    return r ? rowToMessage(r) : undefined;
  }

  /** Tepki ekle/kaldır: aynı gönderenin önceki tepkisi değiştirilir (platformlar kişi başına tek tepki tutar) */
  setReaction(id: string, r: Reaction, remove = false): Message | undefined {
    const m = this.getMessage(id);
    if (!m) return undefined;
    const rest = (m.reactions ?? []).filter((x) => x.senderId !== r.senderId);
    const next = remove ? rest : [...rest, r];
    this.stmt('UPDATE messages SET reactions = ? WHERE id = ?').run(next.length ? JSON.stringify(next) : null, id);
    return { ...m, reactions: next.length ? next : undefined };
  }

  /**
   * Mesajı düzenlendi (text) ya da herkesten silindi (text === null) olarak işaretle; sohbetin son mesajıysa önizleme de güncellenir.
   * Kendi düzenlemem/silmem ve platformdan gelen düzenleme/silme olayları bunu kullanır. Değişiklik yoksa undefined.
   */
  applyEdit(id: string, text: string | null): Message | undefined {
    const m = this.getMessage(id);
    if (!m) return undefined;
    const deleted = text === null;
    if (deleted ? m.deleted : m.text === text && m.edited) return undefined;
    if (m.deleted && !deleted) return undefined; // silinen mesaj düzenlenemez
    const next = deleted ? DELETED_TEXT : text;
    if (deleted) this.stmt('UPDATE messages SET text = ?, attachments = ?, deleted = 1 WHERE id = ?').run(next, '[]', id);
    else this.stmt('UPDATE messages SET text = ?, edited = 1 WHERE id = ?').run(next, id);
    const out: Message = deleted ? { ...m, text: next, attachments: [], deleted: true } : { ...m, text: next, edited: true };
    const chat = this.getChat(m.chatId);
    if (chat && m.ts >= chat.lastMessageAt) {
      const preview = chat.kind !== 'direct' && next ? `${m.fromMe ? 'Sen' : (m.senderName || '').split(/\s+/)[0] || '?'}: ${next}` : next;
      this.stmt('UPDATE chats SET last_preview = ? WHERE id = ?').run(preview, m.chatId);
    }
    return out;
  }

  /** Tepki listesini bütünüyle değiştir (Telegram güncellemeleri tam listeyi verir) */
  setReactions(id: string, list: Reaction[] | undefined): Message | undefined {
    const m = this.getMessage(id);
    if (!m) return undefined;
    this.stmt('UPDATE messages SET reactions = ? WHERE id = ?').run(list?.length ? JSON.stringify(list) : null, id);
    return { ...m, reactions: list?.length ? list : undefined };
  }

  /** Yerel bayraklar (sabitle/arşivle/sessize al/gizle); verilmeyen alanlar korunur */
  setFlags(id: string, flags: ChatFlags): Chat | undefined {
    const c = this.getChat(id);
    if (!c) return undefined;
    const next: ChatFlags = { pinned: c.pinned, archived: c.archived, muted: c.muted, hidden: c.hidden };
    for (const k of ['pinned', 'archived', 'muted', 'hidden'] as const) if (typeof flags[k] === 'boolean') next[k] = flags[k] || undefined;
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v));
    this.stmt('UPDATE chats SET flags = ? WHERE id = ?').run(Object.keys(clean).length ? JSON.stringify(clean) : null, id);
    return this.getChat(id);
  }

  /** Takip hatırlatıcısı kur (at ms) ya da kaldır (null) */
  setFollowUp(id: string, at: number | null): Chat | undefined {
    if (!this.getChat(id)) return undefined;
    const v = at ? JSON.stringify({ at, since: Date.now() } satisfies FollowUp) : null;
    this.stmt('UPDATE chats SET followup = ? WHERE id = ?').run(v, id);
    return this.getChat(id);
  }

  /**
   * Takip hatırlatıcılarını değerlendir: kurulduktan sonra karşı taraftan mesaj gelen kapanır (resolved),
   * süresi dolup yanıt gelmeyen `due` olur (yalnızca ilk kez döner; bildirim bir kez gider).
   */
  checkFollowUps(now = Date.now()): { resolved: Chat[]; due: Chat[] } {
    const rows = this.stmt('SELECT id, followup FROM chats WHERE followup IS NOT NULL').all() as Array<{ id: string; followup: string }>;
    const resolved: Chat[] = [];
    const due: Chat[] = [];
    const incoming = this.stmt('SELECT 1 FROM messages WHERE chat_id = ? AND from_me = 0 AND ts > ? LIMIT 1');
    for (const r of rows) {
      const f = safeJson<FollowUp | null>(r.followup, null);
      if (!f) continue;
      if (incoming.get(r.id, f.since)) {
        this.stmt('UPDATE chats SET followup = NULL WHERE id = ?').run(r.id);
        const c = this.getChat(r.id);
        if (c) resolved.push(c);
      } else if (!f.due && f.at <= now) {
        this.stmt('UPDATE chats SET followup = ? WHERE id = ?').run(JSON.stringify({ ...f, due: true }), r.id);
        const c = this.getChat(r.id);
        if (c) due.push(c);
      }
    }
    return { resolved, due };
  }

  /** Yalnızca teslim/okundu durumunu güncelle (metin, zaman ve sohbet özetine dokunmadan). */
  updateStatus(id: string, status: Message['status']): void {
    this.stmt('UPDATE messages SET status = ? WHERE id = ?').run(status, id);
  }

  /**
   * Gönderim sonrası yerel (local-…) kaydın gerçek kimlikli kopyası geldiyse yerel kaydı sil
   * (iMessage yoklaması / Messenger DOM okuması aynı mesajı başka kimlikle getirir).
   */
  dropLocalDuplicates(chatId: string): string[] {
    const rows = this
      .stmt(
        // Aralık koşulları dizinden aranır: remote_id 'local-'…'local.' ('.' = '-'den sonraki karakter; LIKE büyük/küçük harf
        // duyarsız olduğundan dizini kullanamıyor, her fromMe mesajında sohbetin tamamını tarıyordu → geçmiş eşitlemesi O(n²)),
        // zaman penceresi messages_chat_ts (chat_id, ts) üzerinden
        `SELECT l.id FROM messages l WHERE l.chat_id = ? AND l.remote_id >= 'local-' AND l.remote_id < 'local.' AND l.from_me = 1
           AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = l.chat_id AND m.from_me = 1 AND m.remote_id NOT LIKE 'local-%' AND m.text = l.text
                       AND m.ts > l.ts - 600000 AND m.ts < l.ts + 600000)`,
      )
      .all(chatId) as Array<{ id: string }>;
    for (const r of rows) this.stmt('DELETE FROM messages WHERE id = ?').run(r.id);
    return rows.map((r) => r.id);
  }

  /** Hesabın tüm sohbetlerini ve mesajlarını sil (yeniden eşitleme için; hesap kalır) */
  dropAccountChats(accountId: string): number {
    const n = (this.stmt('SELECT COUNT(*) AS n FROM chats WHERE account_id = ?').get(accountId) as { n: number }).n;
    this.transaction(() => {
      this.stmt('DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE account_id = ?)').run(accountId);
      this.stmt('DELETE FROM chats WHERE account_id = ?').run(accountId);
    });
    return n;
  }

  /** Tek sohbeti (ve mesajlarını) sil — platformda silinen/ayrılınan sohbet */
  deleteChat(id: string): void {
    this.transaction(() => {
      this.stmt('DELETE FROM messages WHERE chat_id = ?').run(id);
      this.stmt('DELETE FROM chats WHERE id = ?').run(id);
    });
  }

  /** Hesabın belirli adlı sohbetlerini (ve mesajlarını) sil — hatalı sürümün ürettiği boş kayıtları temizlemek için */
  dropChatsNamed(accountId: string, name: string): number {
    const ids = (this.stmt('SELECT id FROM chats WHERE account_id = ? AND name = ?').all(accountId, name) as Array<{ id: string }>).map((r) => r.id);
    this.transaction(() => {
      for (const id of ids) {
        this.stmt('DELETE FROM messages WHERE chat_id = ?').run(id);
        this.stmt('DELETE FROM chats WHERE id = ?').run(id);
      }
    });
    return ids.length;
  }

  /** Aynı sohbette, aynı gönderenden, ±10 sn içinde aynı yer tutucu metinli başka kimlikli mesaj (WhatsApp tek seferlik medya ikizi) */
  findTwin(chatId: string, remoteId: string, fromMe: boolean, senderId: string, text: string, ts: number): Message | undefined {
    const r = this
      .stmt('SELECT id FROM messages WHERE chat_id = ? AND remote_id <> ? AND from_me = ? AND sender_id = ? AND text = ? AND ts BETWEEN ? AND ? ORDER BY ts LIMIT 1')
      .get(chatId, remoteId, fromMe ? 1 : 0, senderId, text, ts - 10_000, ts + 10_000) as { id: string } | undefined;
    return r ? this.getMessage(r.id) : undefined;
  }

  /**
   * Var olan ikiz yer tutucuları temizle: her kümeden en iyi durumlu (sonra en eski) kalır. Silinen kimlikleri döndürür.
   * Zaman koşulu BETWEEN: eşi messages_chat_ts (chat_id, ts) aralığından bulunur (ABS(...) ile 'me' göndereni üzerinden tarıyordu).
   */
  dropTwins(text: string): string[] {
    const rows = this
      .stmt(
        `SELECT b.id FROM messages a JOIN messages b ON b.chat_id = a.chat_id AND b.id <> a.id AND b.from_me = a.from_me AND b.sender_id = a.sender_id
           AND b.text = a.text AND b.ts BETWEEN a.ts - 10000 AND a.ts + 10000
         WHERE a.text = ? AND (
           (CASE a.status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END) > (CASE b.status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END)
           OR ((CASE a.status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END) = (CASE b.status WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END) AND (a.ts < b.ts OR (a.ts = b.ts AND a.id < b.id))))`,
      )
      .all(text) as Array<{ id: string }>;
    const ids = [...new Set(rows.map((r) => r.id))];
    for (const id of ids) this.stmt('DELETE FROM messages WHERE id = ?').run(id);
    return ids;
  }

  /**
   * Kendi mesajımın yankısı mı: aynı sohbette ±3 dk içinde birebir aynı metinli (≥12 karakter) benim gönderdiğim bir mesaj var.
   * Bazı platformlar/istemciler gönderdiğim mesajı başka kimlikle (WhatsApp LID, DOM okuyan köprüler) karşı taraftan gelmiş gibi
   * tekrar verir; bu kayıt gelen mesaj sayılmaz (okunmamış sayacı artmaz, kopya balon çıkmaz).
   */
  isOwnEcho(chatId: string, text: string, ts: number): boolean {
    const t = text.trim();
    if (t.length < 12) return false;
    return !!this.stmt('SELECT 1 FROM messages WHERE chat_id = ? AND from_me = 1 AND text = ? AND ts BETWEEN ? AND ?').get(chatId, t, ts - 180_000, ts + 180_000);
  }

  hasMessage(id: string): boolean {
    return !!this.stmt('SELECT 1 FROM messages WHERE id = ?').get(id);
  }

  listMessages(chatId: string, limit = 100, before?: number): Message[] {
    const rows = before
      ? this.stmt('SELECT * FROM messages WHERE chat_id = ? AND ts < ? ORDER BY ts DESC, rowid DESC LIMIT ?').all(chatId, before, limit)
      : this.stmt('SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?').all(chatId, limit);
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
    const add = (rows: () => Array<{ text: string; prev_text: string }>, scope: 'chat' | 'platform' | 'all', n: number) => {
      if (out.length >= limit) return;
      for (const r of rows()) {
        if (out.length >= limit || seen.has(r.text)) continue;
        seen.add(r.text);
        out.push({ them: r.prev_text, me: r.text, scope });
        if (out.filter((o) => o.scope === scope).length >= n) break;
      }
    };
    // tek sohbet: messages_chat_ts üzerinden hızlı (pencere işlevi yalnız bu sohbetin satırlarında)
    const chatSql = `SELECT text, prev_text FROM (
         SELECT text, from_me, ts,
                LAG(text) OVER (PARTITION BY chat_id ORDER BY ts) AS prev_text,
                LAG(from_me) OVER (PARTITION BY chat_id ORDER BY ts) AS prev_me
         FROM messages WHERE chat_id = ? AND ts > ?
       ) WHERE from_me = 1 AND prev_me = 0 AND length(text) BETWEEN 2 AND 400 AND length(prev_text) BETWEEN 1 AND 400
       ORDER BY ts DESC LIMIT ?`;
    // platform / tümü: eskiden tüm bir yılın geçmişinde LAG penceresi (500 bin mesajda şifreli DB'de ~5 sn kilit). Şimdi kendi
    // mesajlarımın en yeni 1000'i messages_mine kapsayan diziniyle alınır, her birinin hemen önceki mesajı chat_ts dizininden bulunur.
    const wideSql = (withPlatform: boolean) => `SELECT m.text AS text, p.text AS prev_text FROM (
         SELECT m2.rowid AS rid FROM messages m2 INDEXED BY messages_mine CROSS JOIN chats c ON c.id = m2.chat_id
          WHERE m2.from_me = 1 AND m2.ts > ? AND c.kind = 'direct'${withPlatform ? ' AND c.platform = ?' : ''}
          ORDER BY m2.ts DESC LIMIT 1000
       ) k JOIN messages m ON m.rowid = k.rid
         JOIN messages p ON p.rowid = (SELECT x.rowid FROM messages x WHERE x.chat_id = m.chat_id AND x.ts < m.ts ORDER BY x.ts DESC LIMIT 1)
       WHERE length(m.text) BETWEEN 2 AND 400 AND p.from_me = 0 AND p.ts > ? AND length(p.text) BETWEEN 1 AND 400
       ORDER BY m.ts DESC LIMIT ?`;
    type Pair = { text: string; prev_text: string };
    add(() => this.stmt(chatSql).all(chatId, since, 6 * 3) as Pair[], 'chat', 6);
    add(() => this.stmt(wideSql(true)).all(since, platform, since, 4 * 3) as Pair[], 'platform', 4);
    add(() => this.stmt(wideSql(false)).all(since, since, limit * 3) as Pair[], 'all', limit);
    return out;
  }

  /** Son yazdığım mesajlar (üslup istatistiği için; platform verilirse önce o platform) */
  myTexts(platform?: string, limit = 400): string[] {
    // platformlu biçim iki adımda: aday satırlar messages_mine kapsayan dizininden (tablo satırı okunmadan), metin sonra
    const rows = (
      platform
        ? this
            .stmt(
              `SELECT text FROM messages WHERE rowid IN (
                 SELECT m.rowid FROM messages m INDEXED BY messages_mine CROSS JOIN chats c ON c.id = m.chat_id WHERE m.from_me = 1 AND c.platform = ? ORDER BY m.ts DESC LIMIT ?
               ) AND length(text) > 1 ORDER BY ts DESC LIMIT ?`,
            )
            .all(platform, limit * 2, limit)
        : this.stmt('SELECT text FROM messages INDEXED BY messages_mine WHERE from_me = 1 AND length(text) > 1 ORDER BY ts DESC LIMIT ?').all(limit)
    ) as Array<{ text: string }>;
    return rows.map((r) => r.text);
  }

  search(q: string, limit = 50): Array<{ message: Message; chat: Chat; transcript?: string }> {
    const rows = this
      .stmt(
        // ts dizininde yeniden eskiye yürünür, her satır FTS eşleşme kümesinde aranır; limit dolunca durur (eskiden tüm eşleşmeler
        // okunup geçici ağaçta sıralanıyordu: yaygın kelimede 300 bin mesajda ~0,6-0,9 sn olay döngüsü kilidi). INDEXED BY şart:
        // planlayıcı yoksa rowid aramasına + geçici ağaca dönüyor.
        `SELECT m.* FROM messages m INDEXED BY messages_ts WHERE m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) ORDER BY m.ts DESC LIMIT ?`,
      )
      .all(ftsQuery(q), limit)
      .map(rowToMessage);
    // Ek (dosya) adlarında da ara: "fatura" → fatura-1042.pdf (FTS yalnız metni indeksler)
    const term = q.trim();
    if (term.length >= 3 && rows.length < limit) {
      const seen = new Set(rows.map((m) => m.id));
      const like = `%"name":"%${term.replace(/[\\%_"]/g, (c) => '\\' + c)}%`;
      const extra = this
        // kısmi dizin (ts, attachments): LIKE dizin kaydında değerlendirilir, satır yalnız eşleşince okunur (eskiden tam tablo taraması)
        .stmt(`SELECT * FROM messages INDEXED BY messages_att WHERE attachments IS NOT NULL AND attachments LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT ?`)
        .all(like, limit - rows.length)
        .map(rowToMessage)
        .filter((m) => !seen.has(m.id) && (m.attachments ?? []).some((a) => (a.name ?? '').toLocaleLowerCase('tr-TR').includes(term.toLocaleLowerCase('tr-TR'))));
      rows.push(...extra);
      rows.sort((a, b) => b.ts - a.ts);
    }
    // yerel ML: sesli mesaj metinlerinde de ara (ayrı FTS tablosu; sonuçta mesaj + metni)
    const spoken = new Map(searchTranscripts(this, ftsQuery(q), limit).map((t) => [t.messageId, t.text]));
    if (spoken.size) {
      const seen = new Set(rows.map((m) => m.id));
      for (const id of spoken.keys()) {
        const m = seen.has(id) ? undefined : this.getMessage(id);
        if (m) rows.push(m);
      }
      rows.sort((a, b) => b.ts - a.ts);
      rows.length = Math.min(rows.length, limit);
    }
    return rows.flatMap((message) => {
      const chat = this.getChat(message.chatId);
      const transcript = spoken.get(message.id);
      return chat && !this.removing.has(chat.accountId) ? [transcript ? { message, chat, transcript } : { message, chat }] : [];
    });
  }

  // ---------- takvim ----------
  listEvents(from?: string, to?: string): CalEvent[] {
    const rows = from && to ? this.stmt('SELECT * FROM events WHERE start >= ? AND start < ? ORDER BY start').all(from, to) : this.stmt('SELECT * FROM events ORDER BY start').all();
    return rows.map(rowToEvent);
  }

  getEvent(id: string): CalEvent | undefined {
    const r = this.stmt('SELECT * FROM events WHERE id = ?').get(id);
    return r ? rowToEvent(r) : undefined;
  }

  saveEvent(ev: CalEvent): CalEvent {
    this
      .stmt(
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
    return this.stmt('DELETE FROM events WHERE id = ?').run(id).changes > 0;
  }

  /** Hatırlatma zamanı gelmiş (başlangıç − remind_min ≤ şimdi) ve henüz bildirilmemiş etkinlikler; bir kez işaretlenir */
  dueEventReminders(now = new Date()): CalEvent[] {
    const out: CalEvent[] = [];
    const rows = this.stmt('SELECT * FROM events WHERE reminded = 0 AND remind_min IS NOT NULL AND all_day = 0').all().map(rowToEvent);
    for (const ev of rows) {
      const start = localDate(ev.start);
      if (!start) continue;
      const at = start.getTime() - (ev.remindMin ?? 0) * 60_000;
      // geçmişte kalmış (çekirdek kapalıydı) etkinlik için geç hatırlatma yapma: başlangıçtan 30 dk sonrasına kadar
      if (at <= now.getTime() && now.getTime() - start.getTime() < 30 * 60_000) out.push(ev);
      if (at <= now.getTime()) this.stmt('UPDATE events SET reminded = 1 WHERE id = ?').run(ev.id);
    }
    return out;
  }

  /**
   * Sağlık uçundaki sayılar. `COUNT(*) FROM messages` şifreli (SQLCipher) ve büyük veritabanında tüm tabloyu çözüp tarıyor
   * (yüz binlerce satırda saniyeler); arayüz açılışta ve sık sık çağırıyordu → 30 sn önbellek.
   */
  private statsCache?: { at: number; v: { accounts: number; chats: number; messages: number; unread: number } };
  stats(): { accounts: number; chats: number; messages: number; unread: number } {
    if (this.statsCache && Date.now() - this.statsCache.at < 30_000) return this.statsCache.v;
    const v = this.statsNow();
    this.statsCache = { at: Date.now(), v };
    return v;
  }
  private statsNow(): { accounts: number; chats: number; messages: number; unread: number } {
    const one = (sql: string) => Number((this.stmt(sql).get() as { n: number }).n);
    return {
      accounts: one('SELECT COUNT(*) AS n FROM accounts'),
      chats: one('SELECT COUNT(*) AS n FROM chats'),
      messages: one('SELECT COUNT(*) AS n FROM messages'),
      unread: one('SELECT COALESCE(SUM(unread),0) AS n FROM chats'),
    };
  }

  // ---- pazaryeri gün sonu özeti + soru yanıtı AI taslağı (market-summary.ts, question-draft.ts) ----
  /** Hesabın sipariş/soru taşıyan sohbetleri: yalnız kimlik + meta (hesap dizininden; katılımcı/son durum okunmaz) */
  marketMeta(accountId: string): Array<{ id: string; platform: Platform; meta: string; lastMessageAt: number }> {
    return (
      this.stmt("SELECT id, platform, meta, last_message_at AS lastMessageAt FROM chats WHERE account_id = ? AND meta IS NOT NULL AND (meta LIKE '%\"order\"%' OR meta LIKE '%\"question\"%')").all(accountId) as Array<{
        id: string;
        platform: Platform;
        meta: string;
        lastMessageAt: number;
      }>
    );
  }
  /**
   * Aynı ürüne (ad ya da ürün kimliği) daha önce verilmiş cevaplar: soru (ilk gelen mesaj) → benim ilk gerçek yanıtım.
   * Sistem satırları (📝 yerel not, 🚫 reddedilen, ⚠ raporlandı, ⏱ süresi doldu) yanıt sayılmaz.
   */
  productAnswers(accountId: string, key: { name?: string; id?: string }, excludeChatId: string, limit = 8): Array<{ question: string; answer: string }> {
    const name = key.name?.trim() || null;
    const id = key.id?.trim() || null;
    if (!name && !id) return [];
    const rows = this.stmt(
      `SELECT id FROM chats WHERE account_id = ? AND id <> ? AND meta IS NOT NULL AND json_valid(meta) AND (
        (? IS NOT NULL AND COALESCE(json_extract(meta, '$.question.productName'), json_extract(meta, '$.question.product.name')) = ?)
        OR (? IS NOT NULL AND CAST(COALESCE(json_extract(meta, '$.question.productMainId'), json_extract(meta, '$.question.productId'), json_extract(meta, '$.question.product.sku'), json_extract(meta, '$.question.product.stockCode')) AS TEXT) = ?)
      ) ORDER BY last_message_at DESC LIMIT 40`,
    ).all(accountId, excludeChatId, name, name, id, id) as Array<{ id: string }>;
    const msgs = this.stmt('SELECT from_me, text FROM messages WHERE chat_id = ? ORDER BY ts ASC, rowid ASC LIMIT 30');
    const out: Array<{ question: string; answer: string }> = [];
    for (const r of rows) {
      const list = msgs.all(r.id) as Array<{ from_me: number; text: string }>;
      const q = list.find((m) => !m.from_me && m.text.trim())?.text;
      const a = list.find((m) => m.from_me && m.text.trim() && !/^\s*(📝|🚫|⚠|⏱)/u.test(m.text))?.text;
      if (q && a) out.push({ question: q.slice(0, 400), answer: a.slice(0, 600) });
      if (out.length >= limit) break;
    }
    return out;
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

/** Sohbetin son mesajının durumu (listede tik: gönderildi/iletildi/görüldü); messages_chat_ts dizininden tek arama */
/** Katılımcı listesi ayrı tablodan (chat_participants); eski sütun göçte boşaltıldı, yedek olarak okunur */
const PJSON = '(SELECT p.json FROM chat_participants p WHERE p.chat_id = chats.id) AS pjson';
const LAST_STATUS = '(SELECT m.status FROM messages m WHERE m.chat_id = chats.id ORDER BY m.ts DESC, m.rowid DESC LIMIT 1) AS last_status';

function rowToChat(r: unknown): Chat {
  const x = r as Record<string, unknown>;
  const chat = rowToChatBase(x);
  // Katılımcı listesi (büyük gruplarda onlarca KB JSON) yalnız okununca çözülür: mesaj başına getChat'te boşuna ayrıştırılmasın.
  // JSON.stringify / {...chat} okur → yayında ve kopyada tam veri.
  const raw = x.pjson ?? x.participants;
  if (typeof raw === 'string' && raw) {
    let parsed: Chat['participants'] | null = null;
    Object.defineProperty(chat, 'participants', {
      enumerable: true,
      configurable: true,
      get: () => (parsed ??= safeJson<Chat['participants']>(raw, undefined)),
      set: (v: Chat['participants']) => {
        parsed = v;
      },
    });
  }
  return chat;
}

function rowToChatBase(x: Record<string, unknown>): Chat {
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
    lastReaction: Number(x.last_reaction ?? 0) === 1 ? true : undefined,
    readUpto: Number(x.read_upto ?? 0) || undefined,
    avatarUrl: (x.avatar_url as string | null) ?? undefined,
    tags: safeJson<string[]>(x.tags as string, []),
    handle: (x.handle as string | null) ?? undefined,
    link: (x.link as string | null) ?? undefined,
    participants: undefined,
    meta: x.meta ? safeJson<Chat['meta']>(x.meta as string, undefined) : undefined,
    ...(x.flags ? safeJson<ChatFlags>(x.flags as string, {}) : {}),
    followUp: x.followup ? (safeJson<FollowUp | null>(x.followup as string, null) ?? undefined) : undefined,
    lastStatus: typeof x.last_status === 'string' ? (x.last_status as Message['status']) : undefined,
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
    replyTo: x.reply_to ? safeJson<Message['replyTo']>(x.reply_to as string, undefined) : undefined,
    hasHtml: x.html ? true : undefined,
    edited: Number(x.edited) === 1 ? true : undefined,
    deleted: Number(x.deleted) === 1 ? true : undefined,
  };
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
