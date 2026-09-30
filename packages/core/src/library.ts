import { bus } from './bus.js';
import type { Attachment } from './model.js';
import type { Store } from './store.js';

/**
 * Medya ve dosya kütüphanesi: tüm platformlardan gelen fotoğraf, video, ses, dosya ve mesaj metnindeki bağlantılar tek listede.
 *
 * Ekler `messages.attachments` JSON sütununda; her sorguda 300 bin mesajın JSON'unu çözmek yerine ön hesaplanmış
 * `library_items` tablosu (tür/platform/sohbet + zaman dizinli, imleçli sayfalama) tutulur:
 * - Yazımlar SAF SQL tetikleyicileriyle `library_dirty` kuyruğuna düşer (tetikleyicide JS işlevi yok: aynı veritabanını açan başka
 *   araçlar — duman testi seed betiği vb. — "no such function" almasın). Silinen mesajın öğeleri tetikleyicide hemen silinir.
 * - Kuyruk arka planda küçük dilimlerle işlenir (`startLibraryIndexer`); sorgudan hemen önce de kısa bir tur (yeni gelenler görünsün).
 * - Kurulumdan önceki mesajlar bir kez, rowid aralıklarıyla dilimli olarak kuyruğa alınır (ilerleme meta'da; yarıda kalırsa sürer).
 */

export type LibKind = 'image' | 'video' | 'audio' | 'file' | 'link';
export const LIB_KINDS: readonly LibKind[] = ['image', 'video', 'audio', 'file', 'link'];

export interface LibItem {
  /** `${messageId}|${idx}` */
  id: string;
  messageId: string;
  chatId: string;
  accountId: string;
  platform: string;
  kind: LibKind;
  ts: number;
  name: string;
  att: Attachment;
  senderName: string;
  fromMe: boolean;
  chatName: string;
  chatKind: string;
}

export interface LibQuery {
  kind?: LibKind;
  platform?: string;
  chat?: string;
  q?: string;
  /** imleç: "ts:rowid" (önceki sayfanın `next` değeri) */
  before?: string;
  limit?: number;
}

const MAIL = new Set(['gmail', 'outlook', 'yahoo', 'yandex', 'icloud', 'imap']);
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
/** E-postadaki izleme/abonelik bağlantıları kütüphaneyi doldurmasın */
const MAIL_NOISE = /unsubscribe|abonelik|opt-?out|list-manage|mailchi\.mp|\/wf\/click|\/track|click\.|trk\.|sendgrid|\/ls\/click|email\.[a-z0-9-]+\.[a-z]+\/c\/|\.(png|gif)(\?|$)/i;
const MAX_LINKS = 8;

let installed = new WeakSet<Store>();

/** Tabloları, dizinleri ve tetikleyicileri kur (idempotent). İlk kurulumda eski mesajların dolumu planlanır. */
export function installLibrary(store: Store): void {
  if (installed.has(store)) return;
  const run = (sql: string) => store.sql(sql).run();
  const fresh = !(store.sql("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'library_items'").get());
  run(`CREATE TABLE IF NOT EXISTS library_items (
    message_id TEXT NOT NULL, idx INTEGER NOT NULL, chat_id TEXT NOT NULL, account_id TEXT NOT NULL, platform TEXT NOT NULL,
    kind TEXT NOT NULL, ts INTEGER NOT NULL, name_lc TEXT NOT NULL DEFAULT '', att TEXT NOT NULL,
    PRIMARY KEY (message_id, idx))`);
  run('CREATE INDEX IF NOT EXISTS library_ts ON library_items(ts)');
  run('CREATE INDEX IF NOT EXISTS library_kind_ts ON library_items(kind, ts)');
  run('CREATE INDEX IF NOT EXISTS library_chat_ts ON library_items(chat_id, ts)');
  run('CREATE INDEX IF NOT EXISTS library_plat_ts ON library_items(platform, ts)');
  run('CREATE TABLE IF NOT EXISTS library_dirty (id TEXT PRIMARY KEY) WITHOUT ROWID');
  run(`CREATE TRIGGER IF NOT EXISTS library_mi AFTER INSERT ON messages
    WHEN new.attachments IS NOT NULL OR instr(new.text, 'http') > 0
    BEGIN INSERT OR IGNORE INTO library_dirty(id) VALUES (new.id); END`);
  run(`CREATE TRIGGER IF NOT EXISTS library_mu AFTER UPDATE OF text, attachments, chat_id, ts ON messages
    WHEN (old.text IS NOT new.text OR old.attachments IS NOT new.attachments OR old.chat_id IS NOT new.chat_id OR old.ts IS NOT new.ts)
      AND (new.attachments IS NOT NULL OR instr(new.text, 'http') > 0 OR old.attachments IS NOT NULL OR instr(old.text, 'http') > 0)
    BEGIN INSERT OR IGNORE INTO library_dirty(id) VALUES (new.id); END`);
  run(`CREATE TRIGGER IF NOT EXISTS library_md AFTER DELETE ON messages
    WHEN old.attachments IS NOT NULL OR instr(old.text, 'http') > 0
    BEGIN DELETE FROM library_items WHERE message_id = old.id; END`);
  if (fresh || !store.meta('library_fill')) {
    // kurulum anına kadarki mesajlar (sonrakileri tetikleyiciler yakalar)
    const max = (store.sql('SELECT MAX(rowid) AS m FROM messages').get() as { m: number | null }).m ?? 0;
    store.setFlag('library_fill', JSON.stringify({ at: 0, to: max }));
  }
  installed.add(store);
}

/** Testler: kurulum önbelleğini sıfırla */
export function resetLibraryInstall(): void {
  installed = new WeakSet<Store>();
}

function fillState(store: Store): { at: number; to: number } {
  try {
    const v = JSON.parse(store.meta('library_fill') ?? '') as { at: number; to: number };
    return { at: Number(v.at) || 0, to: Number(v.to) || 0 };
  } catch {
    return { at: 0, to: 0 };
  }
}

/** Eski mesajları kuyruğa alma: bir dilim (rowid aralığı). Bitti mi döner. */
export function backfillStep(store: Store, span = 5000): boolean {
  const s = fillState(store);
  if (s.at >= s.to) return true;
  const hi = Math.min(s.to, s.at + span);
  store.sql(`INSERT OR IGNORE INTO library_dirty(id) SELECT id FROM messages WHERE rowid > ? AND rowid <= ? AND (attachments IS NOT NULL OR instr(text, 'http') > 0)`).run(s.at, hi);
  store.setFlag('library_fill', JSON.stringify({ at: hi, to: s.to }));
  return hi >= s.to;
}

/** Ekin kütüphane türü (gösterilecek hiçbir adresi yoksa undefined) */
export function kindOfAttachment(a: Attachment): LibKind | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const has = !!(a.url || a.link || a.page);
  if (!has) return undefined;
  if (a.kind === 'image' || a.kind === 'video' || a.kind === 'audio') return a.kind;
  if (a.kind === 'file') return 'file';
  // 'other': paylaşılan gönderi / bağlantı kartı → bağlantı; adresi dosyaysa dosya
  const target = a.page ?? a.link ?? '';
  return /^https?:\/\//i.test(target) && !/\.(pdf|zip|docx?|xlsx?|pptx?|csv|txt)(\?|$)/i.test(target) ? 'link' : 'file';
}

/** Mesaj metnindeki bağlantılar (sondaki noktalama atılır, tekil, en çok 8; e-postada izleme/abonelik bağlantıları elenir) */
export function extractLinks(text: string, platform: string, exclude: Set<string> = new Set()): string[] {
  if (!text || !text.includes('http')) return [];
  const out: string[] = [];
  const mail = MAIL.has(platform);
  for (const m of text.matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;:!?]+$/, '');
    if (u.length < 12 || u.length > 2048 || exclude.has(u) || out.includes(u)) continue;
    if (mail && (u.length > 300 || MAIL_NOISE.test(u))) continue;
    out.push(u);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

const lc = (s: string) => s.toLocaleLowerCase('tr-TR');
const hostPath = (u: string) => u.replace(/^https?:\/\/(www\.)?/i, '');

type MsgRow = { id: string; chat_id: string; ts: number; text: string; attachments: string | null; deleted: number | null; platform: string | null; account_id: string | null };

/** Bir mesajın kütüphane öğeleri (saf; test edilir) */
export function itemsOfMessage(row: { text: string; attachments: Attachment[] | null | undefined; platform: string }): Array<{ idx: number; kind: LibKind; name: string; att: Attachment }> {
  const out: Array<{ idx: number; kind: LibKind; name: string; att: Attachment }> = [];
  const seen = new Set<string>();
  (row.attachments ?? []).forEach((a, i) => {
    const kind = kindOfAttachment(a);
    if (!kind) return;
    for (const u of [a.link, a.page]) if (u) seen.add(u);
    const target = a.page ?? a.link ?? '';
    const name = a.name || (kind === 'link' && target ? hostPath(target) : '');
    out.push({ idx: i, kind, name, att: a });
  });
  extractLinks(row.text, row.platform, seen).forEach((u, j) => out.push({ idx: 100 + j, kind: 'link', name: hostPath(u), att: { kind: 'other', page: u, name: u } }));
  return out;
}

/** Kuyruktan en çok `max` mesajı işle (tek işlemde). İşlenen sayı döner. */
export function indexDirty(store: Store, max = 400): number {
  const ids = store.sql('SELECT id FROM library_dirty LIMIT ?').all(max) as Array<{ id: string }>;
  if (!ids.length) return 0;
  const del = store.sql('DELETE FROM library_items WHERE message_id = ?');
  const get = store.sql('SELECT m.id, m.chat_id, m.ts, m.text, m.attachments, m.deleted, c.platform, c.account_id FROM messages m LEFT JOIN chats c ON c.id = m.chat_id WHERE m.id = ?');
  const ins = store.sql('INSERT OR REPLACE INTO library_items (message_id, idx, chat_id, account_id, platform, kind, ts, name_lc, att) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const done = store.sql('DELETE FROM library_dirty WHERE id = ?');
  store.transaction(() => {
    for (const { id } of ids) {
      del.run(id);
      const r = get.get(id) as MsgRow | undefined;
      if (r && r.platform && Number(r.deleted) !== 1) {
        let atts: Attachment[] | null = null;
        try {
          atts = r.attachments ? (JSON.parse(r.attachments) as Attachment[]) : null;
        } catch {
          atts = null;
        }
        for (const it of itemsOfMessage({ text: r.text, attachments: Array.isArray(atts) ? atts : null, platform: r.platform }))
          ins.run(r.id, it.idx, r.chat_id, r.account_id ?? '', r.platform, it.kind, r.ts, lc(it.name).slice(0, 400), JSON.stringify(it.att));
      }
      done.run(id);
    }
  });
  return ids.length;
}

/** Kuyruk ve dolum durumu (arayüz "Kütüphane hazırlanıyor %N") */
export function libraryProgress(store: Store): { ready: boolean; pct: number; pending: number } {
  const s = fillState(store);
  const pending = (store.sql('SELECT COUNT(*) AS n FROM (SELECT 1 FROM library_dirty LIMIT 5001)').get() as { n: number }).n;
  const fillPct = s.to > 0 ? Math.min(1, s.at / s.to) : 1;
  const ready = fillPct >= 1 && pending === 0;
  return { ready, pct: Math.round(fillPct * (pending > 0 ? 95 : 100)), pending };
}

let timer: NodeJS.Timeout | undefined;
let running = false;

/**
 * Arka plan dizinleyici: 3 sn'de bir, tur başına ≈40 ms'lik bütçeyle (aralarda setImmediate) dolum dilimi + kuyruk işleme.
 * Olay döngüsünü uzun bloklamaz; büyük geçmiş birkaç dakikada tamamlanır.
 */
export function startLibraryIndexer(store: Store): void {
  installLibrary(store);
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    const t0 = Date.now();
    let total = 0;
    try {
      for (let round = 0; round < 200; round++) {
        const s0 = performance.now();
        const filled = backfillStep(store);
        const n = indexDirty(store, 300);
        total += n;
        if (filled && n === 0) break;
        // dilim uzun sürdüyse bu tur yeter (bir sonraki zamanlayıcıya bırak)
        if (performance.now() - s0 > 60) break;
        await new Promise((r) => setImmediate(r));
      }
    } catch (e) {
      bus.log('warn', `Medya kütüphanesi dizinlenemedi: ${(e as Error).message.split('\n')[0].slice(0, 160)}`);
    } finally {
      running = false;
    }
    if (total > 2000) bus.log('info', `Medya kütüphanesi: ${total} mesaj dizinlendi (${Math.round((Date.now() - t0) / 100) / 10} sn)`);
  };
  timer = setInterval(() => void tick(), 3000);
  timer.unref?.();
  setTimeout(() => void tick(), 1500).unref?.();
}

export function stopLibraryIndexer(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

type ItemRow = { rid: number; message_id: string; idx: number; chat_id: string; account_id: string; platform: string; kind: string; ts: number; att: string; sender_name: string | null; from_me: number | null; chat_name: string | null; chat_kind: string | null };

/** Sayfalı sorgu: en yeniden eskiye, imleç "ts:rowid" */
export function queryLibrary(store: Store, q: LibQuery = {}): { items: LibItem[]; next: string | null } {
  installLibrary(store);
  // yeni gelenler hemen görünsün: kısa bir işleme turu (bütçeli)
  indexDirty(store, 300);
  const limit = Math.max(1, Math.min(200, Number(q.limit) || 60));
  const where: string[] = [];
  const args: Record<string, unknown> = { limit: limit + 1 };
  if (q.kind && (LIB_KINDS as readonly string[]).includes(q.kind)) (where.push('li.kind = @kind'), (args.kind = q.kind));
  if (q.platform) (where.push('li.platform = @platform'), (args.platform = q.platform));
  if (q.chat) (where.push('li.chat_id = @chat'), (args.chat = q.chat));
  const term = (q.q ?? '').trim();
  if (term) {
    where.push("(li.name_lc LIKE @q ESCAPE '\\' OR c.name LIKE @q ESCAPE '\\')");
    args.q = `%${lc(term).replace(/[\\%_]/g, (ch) => '\\' + ch)}%`;
  }
  const cur = /^(\d+):(\d+)$/.exec(q.before ?? '');
  if (cur) {
    where.push('(li.ts < @bts OR (li.ts = @bts AND li.rowid < @brid))');
    args.bts = Number(cur[1]);
    args.brid = Number(cur[2]);
  }
  const sql = `SELECT li.rowid AS rid, li.message_id, li.idx, li.chat_id, li.account_id, li.platform, li.kind, li.ts, li.att,
      m.sender_name, m.from_me, c.name AS chat_name, c.kind AS chat_kind
    FROM library_items li LEFT JOIN messages m ON m.id = li.message_id LEFT JOIN chats c ON c.id = li.chat_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY li.ts DESC, li.rowid DESC LIMIT @limit`;
  const rows = store.sql(sql).all(args) as ItemRow[];
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const items: LibItem[] = [];
  for (const r of page) {
    if (!r.chat_name || store.isRemoving(r.account_id)) continue;
    let att: Attachment;
    try {
      att = JSON.parse(r.att) as Attachment;
    } catch {
      continue;
    }
    items.push({
      id: `${r.message_id}|${r.idx}`,
      messageId: r.message_id,
      chatId: r.chat_id,
      accountId: r.account_id,
      platform: r.platform,
      kind: r.kind as LibKind,
      ts: r.ts,
      name: att.name && !(r.kind === 'link' && att.name === att.page) ? att.name : r.kind === 'link' ? hostPath(att.page ?? att.link ?? '') : '',
      att,
      senderName: r.sender_name ?? '',
      fromMe: Number(r.from_me) === 1,
      chatName: r.chat_name,
      chatKind: r.chat_kind ?? 'direct',
    });
  }
  const last = page[page.length - 1];
  return { items, next: more && last ? `${last.ts}:${last.rid}` : null };
}

/** Süzgeç sayıları: tür ve platform başına, medyası olan sohbetler (en yeni önce, ≤300) + dizin durumu */
export function libraryFacets(store: Store): {
  kinds: Record<string, number>;
  platforms: Array<{ platform: string; count: number }>;
  chats: Array<{ chatId: string; name: string; platform: string; kind: string; count: number; lastTs: number }>;
  progress: { ready: boolean; pct: number; pending: number };
} {
  installLibrary(store);
  indexDirty(store, 300);
  const kinds: Record<string, number> = {};
  for (const r of store.sql('SELECT kind, COUNT(*) AS n FROM library_items GROUP BY kind').all() as Array<{ kind: string; n: number }>) kinds[r.kind] = r.n;
  const platforms = (store.sql('SELECT platform, COUNT(*) AS n FROM library_items GROUP BY platform ORDER BY n DESC').all() as Array<{ platform: string; n: number }>).map((r) => ({ platform: r.platform, count: r.n }));
  const chats = (
    store
      .sql(
        `SELECT x.chat_id, x.n, x.last, c.name, c.platform, c.kind, c.account_id FROM (
           SELECT chat_id, COUNT(*) AS n, MAX(ts) AS last FROM library_items GROUP BY chat_id ORDER BY last DESC LIMIT 300
         ) x JOIN chats c ON c.id = x.chat_id ORDER BY x.last DESC`,
      )
      .all() as Array<{ chat_id: string; n: number; last: number; name: string; platform: string; kind: string; account_id: string }>
  )
    .filter((r) => !store.isRemoving(r.account_id))
    .map((r) => ({ chatId: r.chat_id, name: r.name, platform: r.platform, kind: r.kind, count: r.n, lastTs: r.last }));
  return { kinds, platforms, chats, progress: libraryProgress(store) };
}
