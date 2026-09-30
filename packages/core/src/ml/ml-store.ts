import type { Store } from '../store.js';

/**
 * Yerel ML tabloları. Hepsi messages(id)'ye yabancı anahtarla bağlı (ON DELETE/UPDATE CASCADE): mesaj silinince, hesap
 * kaldırılınca (purgeAccount/deleteAccount), "Tüm verileri sil"de (wipeAll) ve sohbet birleştirmede (mergeChats kimliği günceller)
 * kendiliğinden temizlenir/taşınır. Sesli mesaj metni ayrı FTS5 tablosunda: messages_fts'e (ve onun "yalnız metin değişince"
 * tetikleyicisine) dokunulmaz; store.search iki tabloyu birlikte arar.
 */
export const ML_SCHEMA = `
  CREATE TABLE IF NOT EXISTS transcripts (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE ON UPDATE CASCADE,
    status TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    lang TEXT,
    error TEXT,
    seconds REAL,
    updated_at INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(text, content='transcripts', content_rowid='rowid');
  CREATE TRIGGER IF NOT EXISTS transcripts_ai AFTER INSERT ON transcripts BEGIN
    INSERT INTO transcripts_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS transcripts_ad AFTER DELETE ON transcripts BEGIN
    INSERT INTO transcripts_fts(transcripts_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;
  CREATE TRIGGER IF NOT EXISTS transcripts_au AFTER UPDATE OF text ON transcripts WHEN old.text IS NOT new.text BEGIN
    INSERT INTO transcripts_fts(transcripts_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO transcripts_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TABLE IF NOT EXISTS embeddings (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE ON UPDATE CASCADE,
    chat_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    model TEXT NOT NULL,
    vec BLOB NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS embeddings_chat AFTER UPDATE OF chat_id ON messages WHEN old.chat_id IS NOT new.chat_id BEGIN
    UPDATE embeddings SET chat_id = new.chat_id WHERE message_id = new.id;
  END;
  CREATE TRIGGER IF NOT EXISTS ml_text_changed AFTER UPDATE OF text ON messages WHEN old.text IS NOT new.text BEGIN
    DELETE FROM translations WHERE message_id = new.id;
    DELETE FROM embeddings WHERE message_id = new.id;
  END;
  CREATE TABLE IF NOT EXISTS translations (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE ON UPDATE CASCADE,
    lang TEXT NOT NULL,
    src TEXT,
    text TEXT NOT NULL,
    engine TEXT,
    PRIMARY KEY (message_id, lang)
  );
`;

export type TranscriptStatus = 'pending' | 'done' | 'error';
export interface Transcript {
  messageId: string;
  status: TranscriptStatus;
  text: string;
  lang?: string;
  error?: string;
  seconds?: number;
  updatedAt: number;
}

type Row = { message_id: string; status: TranscriptStatus; text: string; lang: string | null; error: string | null; seconds: number | null; updated_at: number };
const toTranscript = (r: Row): Transcript => ({
  messageId: r.message_id,
  status: r.status,
  text: r.text,
  ...(r.lang ? { lang: r.lang } : {}),
  ...(r.error ? { error: r.error } : {}),
  ...(r.seconds != null ? { seconds: r.seconds } : {}),
  updatedAt: r.updated_at,
});

export function getTranscript(store: Store, messageId: string): Transcript | undefined {
  const r = store.mlStmt('SELECT * FROM transcripts WHERE message_id = ?').get(messageId) as Row | undefined;
  return r ? toTranscript(r) : undefined;
}

/** Sohbetin tüm sesli mesaj metinleri (mesaj kimliği "<sohbet>#<uzak kimlik>": birincil anahtarda aralık taraması) */
export function chatTranscripts(store: Store, chatId: string): Transcript[] {
  return (store.mlStmt('SELECT * FROM transcripts WHERE message_id > ? AND message_id < ?').all(`${chatId}#`, `${chatId}$`) as Row[]).map(toTranscript);
}

export function saveTranscript(store: Store, t: Omit<Transcript, 'updatedAt'>): Transcript | undefined {
  // mesaj silinmişse (FK) yazılmaz
  if (!store.hasMessage(t.messageId)) return undefined;
  store
    .mlStmt(
      `INSERT INTO transcripts (message_id, status, text, lang, error, seconds, updated_at) VALUES (@messageId, @status, @text, @lang, @error, @seconds, @at)
       ON CONFLICT(message_id) DO UPDATE SET status = excluded.status, text = excluded.text, lang = excluded.lang, error = excluded.error,
         seconds = COALESCE(excluded.seconds, transcripts.seconds), updated_at = excluded.updated_at`,
    )
    .run({ messageId: t.messageId, status: t.status, text: t.text, lang: t.lang ?? null, error: t.error ?? null, seconds: t.seconds ?? null, at: Date.now() });
  return getTranscript(store, t.messageId);
}

/** Tam metin: sesli mesaj metinlerinde ara (en yeni önce) */
export function searchTranscripts(store: Store, ftsQuery: string, limit: number): Array<{ messageId: string; text: string }> {
  try {
    return (
      store
        .mlStmt(
          `SELECT t.message_id AS messageId, t.text AS text FROM transcripts t JOIN messages m ON m.id = t.message_id
            WHERE t.rowid IN (SELECT rowid FROM transcripts_fts WHERE transcripts_fts MATCH ?) AND t.status = 'done' ORDER BY m.ts DESC LIMIT ?`,
        )
        .all(ftsQuery, limit) as Array<{ messageId: string; text: string }>
    );
  } catch {
    return []; // geçersiz FTS sözdizimi
  }
}

export function transcriptTexts(store: Store, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const st = store.mlStmt("SELECT text FROM transcripts WHERE message_id = ? AND status = 'done'");
  for (const id of ids) {
    const r = st.get(id) as { text: string } | undefined;
    if (r?.text) out.set(id, r.text);
  }
  return out;
}

// ---- gömmeler ----
export function saveEmbeddings(store: Store, rows: Array<{ messageId: string; chatId: string; ts: number; vec: Buffer }>, model: string): number {
  const st = store.mlStmt('INSERT OR REPLACE INTO embeddings (message_id, chat_id, ts, model, vec) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?)');
  let n = 0;
  store.transaction(() => {
    for (const r of rows) n += st.run(r.messageId, r.chatId, r.ts, model, r.vec, r.messageId).changes;
  });
  return n;
}

export function embeddingCount(store: Store, model: string): number {
  return (store.mlStmt('SELECT COUNT(*) AS n FROM embeddings WHERE model = ?').get(model) as { n: number }).n;
}

/** Bellek içi dizini doldurmak için dilimli okuma (rowid sırasıyla) */
export function embeddingPage(store: Store, model: string, afterRowid: number, limit: number): Array<{ rowid: number; message_id: string; chat_id: string; ts: number; vec: Buffer }> {
  return store
    .mlStmt('SELECT rowid, message_id, chat_id, ts, vec FROM embeddings WHERE rowid > ? AND model = ? ORDER BY rowid LIMIT ?')
    .all(afterRowid, model, limit) as Array<{ rowid: number; message_id: string; chat_id: string; ts: number; vec: Buffer }>;
}

export function dropEmbeddings(store: Store, exceptModel?: string): number {
  return exceptModel ? store.mlStmt('DELETE FROM embeddings WHERE model <> ?').run(exceptModel).changes : store.mlStmt('DELETE FROM embeddings').run().changes;
}

// ---- çeviriler ----
export function getTranslation(store: Store, messageId: string, lang: string): { text: string; src: string | null; engine: string | null } | undefined {
  return store.mlStmt('SELECT text, src, engine FROM translations WHERE message_id = ? AND lang = ?').get(messageId, lang) as { text: string; src: string | null; engine: string | null } | undefined;
}

export function saveTranslation(store: Store, messageId: string, lang: string, src: string | null, text: string, engine: string): void {
  store
    .mlStmt('INSERT OR REPLACE INTO translations (message_id, lang, src, text, engine) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?)')
    .run(messageId, lang, src, text, engine, messageId);
}
