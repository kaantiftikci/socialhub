import { bus } from '../bus.js';
import type { Chat, Message } from '../model.js';
import type { Store } from '../store.js';
import { MODEL_SPECS, mlSettings } from './config.js';
import { isModelUsable, mlQueue, runMl } from './engine.js';
import { dropEmbeddings, embeddingCount, embeddingPage, saveEmbeddings, transcriptTexts } from './ml-store.js';
import { emitMlStatus } from './models.js';
import { keywords, parseQuery, stripSuffix, type QueryHints } from './query.js';
import { VectorIndex, packVector, quantize, rrf, unpackVector } from './vector.js';

/**
 * Anlamsal (doğal dil) arama: mesaj metinleri arka planda gömülür (multilingual-e5-small, 384 boyut), int8 vektör SQLite'ta
 * (`embeddings`), aramada bellek içi dizinde kaba kuvvet benzerlik + FTS5 sonuçlarıyla karşılıklı sıra füzyonu (hibrit).
 * Tarih ("geçen ay") ve kişi ("Ahmet'in") ipuçları süzgece çevrilir. Model yoksa tam metin + ipuçlarıyla çalışır.
 * Dizinleme: önce son 12 ay (yeniden eskiye), sonra daha eskiler; yeni mesajlar olay akışından kuyruğa. Dilim 24 mesaj,
 * arada nefes (arayüz/aramalar araya girer: kuyrukta 'interactive' öncelik).
 */
const MODEL = MODEL_SPECS.embed.id;
const DIM = MODEL_SPECS.embed.dim ?? 384;
const BATCH = 24;
const MIN_LEN = 12;
const SYSTEM_LEAD = /^(🔒|🚫|⏳|🗑|⚠|📞|📵)/u;
const NOT_PEOPLE = /^(gmail|outlook|yahoo|yandex|icloud|imap|shopier|trendyol|hepsiburada|etsy|shopify|n11|amazon|pttavm)$/;
const REACTION = /(bir mesajı beğendi|mesajına tepki verdi|reacted .* to|Liked “|Laughed at)/;

export interface SemanticHit {
  message: Message;
  chat: Chat;
  score: number;
  via: 'semantic' | 'text' | 'both';
  transcript?: string;
}

export interface IndexStatus {
  enabled: boolean;
  ready: boolean;
  indexed: number;
  total: number;
  pct: number;
  running: boolean;
}

/** Gömülecek metin mi? (en az birkaç kelime, sistem/tepki/silinmiş mesaj değil) */
export function indexable(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_LEN || SYSTEM_LEAD.test(t) || REACTION.test(t)) return false;
  return t.split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w)).length >= 2;
}

/** e5 biçimi: belge "passage: …", sorgu "query: …" (uzun e-postalar kırpılır; model 512 belirteçle sınırlı) */
export const passage = (text: string) => `passage: ${text.replace(/\s+/g, ' ').trim().slice(0, 1200)}`;
export const queryText = (text: string) => `query: ${text.trim()}`;

export class SemanticIndex {
  private index: VectorIndex | null = null;
  private loading: Promise<VectorIndex> | null = null;
  /** yeni mesajlar (olay akışından) */
  private fresh = new Map<string, { chatId: string; ts: number; text: string }>();
  private cursor: number | null = null;
  private running = false;
  private stopped = true;
  private totalCache: { at: number; n: number } | null = null;
  private stopBus?: () => void;
  private timer: NodeJS.Timeout | undefined;

  constructor(private store: Store) {}

  start(): void {
    if (this.stopBus) return;
    this.stopBus = bus.on((ev) => {
      if (ev.type === 'message.upsert') {
        const m = ev.message;
        if (!this.enabled() || !indexable(m.text) || m.deleted) return;
        if (this.fresh.size < 5000) this.fresh.set(m.id, { chatId: m.chatId, ts: m.ts, text: m.text });
        this.kick(ev.live ? 3000 : 15000);
      } else if (ev.type === 'account.removed') {
        this.index?.removeWhere((c) => c.startsWith(`${ev.accountId}/`));
      } else if (ev.type === 'chat.delete') {
        this.index?.removeWhere((c) => c === ev.chatId);
      }
    });
    this.stopped = false;
    this.kick(20_000); // açılıştan sonra
  }

  stop(): void {
    this.stopped = true;
    this.stopBus?.();
    this.stopBus = undefined;
    if (this.timer) clearTimeout(this.timer);
  }

  private enabled(): boolean {
    return mlSettings().semanticIndex && isModelUsable('embed');
  }

  /** Ayar/model değişince dizinlemeyi yeniden dürt */
  kick(delay = 500): void {
    if (this.stopped || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), delay);
    this.timer.unref?.();
  }

  /** Bellek içi dizin: ilk aramada ya da dizinlemede diskten dilimlerle yüklenir */
  private async loadIndex(): Promise<VectorIndex> {
    if (this.index) return this.index;
    this.loading ??= (async () => {
      dropEmbeddings(this.store, MODEL); // başka modelle üretilmiş eski vektörler (model değişti)
      const idx = new VectorIndex(DIM, 4096);
      let after = 0;
      for (;;) {
        const rows = embeddingPage(this.store, MODEL, after, 5000);
        for (const r of rows) idx.add(r.message_id, r.chat_id, r.ts, unpackVector(r.vec));
        if (rows.length < 5000) break;
        after = rows[rows.length - 1].rowid;
        await new Promise((r) => setImmediate(r));
      }
      this.index = idx;
      return idx;
    })().finally(() => (this.loading = null));
    return this.loading;
  }

  status(): IndexStatus {
    const enabled = mlSettings().semanticIndex;
    const ready = isModelUsable('embed');
    const indexed = this.index?.size ?? (ready ? embeddingCount(this.store, MODEL) : 0);
    const total = Math.max(indexed, this.eligibleTotal());
    return { enabled, ready, indexed, total, pct: total ? Math.min(100, Math.floor((indexed / total) * 100)) : 100, running: this.running };
  }

  /**
   * Dizinlenebilir mesaj sayısı: tam tablo taraması (şifreli büyük DB'de saniyeler) ana döngüyü kilitlemesin diye rowid
   * aralıklarıyla dilimli, arka planda sayılır; 30 dk önbellek. Sayım bitene dek bilinen son değer (ya da dizinlenen) döner.
   */
  private counting = false;
  private eligibleTotal(): number {
    const stale = !this.totalCache || Date.now() - this.totalCache.at > 30 * 60_000;
    if (stale && !this.counting) void this.countEligible();
    return this.totalCache?.n ?? 0;
  }

  private async countEligible(): Promise<void> {
    this.counting = true;
    try {
      const max = (this.store.mlStmt('SELECT MAX(rowid) AS m FROM messages').get() as { m: number | null }).m ?? 0;
      const st = this.store.mlStmt(`SELECT COUNT(*) AS n FROM messages WHERE rowid > ? AND rowid <= ? AND length(text) >= ${MIN_LEN}`);
      let n = 0;
      for (let from = 0; from < max; from += 20_000) {
        n += (st.get(from, from + 20_000) as { n: number }).n;
        await new Promise((r) => setImmediate(r));
      }
      this.totalCache = { at: Date.now(), n };
      emitMlStatus();
    } catch {
      /* sayılamadı: sonraki durum isteğinde yeniden */
    } finally {
      this.counting = false;
    }
  }

  /** Sıradaki dilim: önce olay akışından gelenler, sonra imleçten geriye (ts azalan) gömülmemiş mesajlar */
  private nextBatch(): Array<{ id: string; chatId: string; ts: number; text: string }> {
    const out: Array<{ id: string; chatId: string; ts: number; text: string }> = [];
    for (const [id, v] of this.fresh) {
      this.fresh.delete(id);
      if (this.index?.has(id)) continue;
      out.push({ id, ...v });
      if (out.length >= BATCH) return out;
    }
    const cursor = this.cursor ?? Date.now() + 86400e3;
    const rows = this.store
      .mlStmt(
        `SELECT m.id, m.chat_id AS chatId, m.ts, m.text FROM messages m INDEXED BY messages_ts
          WHERE m.ts < ? AND length(m.text) >= ${MIN_LEN} AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.message_id = m.id)
          ORDER BY m.ts DESC LIMIT ?`,
      )
      .all(cursor, BATCH * 3) as Array<{ id: string; chatId: string; ts: number; text: string }>;
    if (!rows.length) {
      this.cursor = -1; // tarama bitti
      return out;
    }
    this.cursor = rows[rows.length - 1].ts; // aynı ms'deki kalanlar bir sonraki taramada (günlük yeniden tarama)
    for (const r of rows) if (indexable(r.text) && out.length < BATCH) out.push(r);
    // hepsi elendiyse (kısa/sistem mesajı) boş dilim; döngü devam eder
    return out;
  }

  private async loop(): Promise<void> {
    if (this.running || this.stopped || !this.enabled()) return;
    this.running = true;
    emitMlStatus();
    let n = 0;
    try {
      const idx = await this.loadIndex();
      for (;;) {
        if (this.stopped || !this.enabled()) break;
        // kullanıcı işleri (yazıya dökme, arama) beklerken sıraya yığılmasın
        if (mlQueue.pending > 2) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        if (this.cursor === -1 && !this.fresh.size) break;
        const batch = this.nextBatch();
        if (!batch.length) {
          if (this.cursor === -1 && !this.fresh.size) break;
          await new Promise((r) => setImmediate(r));
          continue;
        }
        const vecs = await runMl((b) => b.embed(batch.map((x) => passage(x.text))), 'background');
        const rows = batch.map((x, i) => ({ messageId: x.id, chatId: x.chatId, ts: x.ts, q: quantize(vecs[i]) }));
        saveEmbeddings(this.store, rows.map((r) => ({ messageId: r.messageId, chatId: r.chatId, ts: r.ts, vec: packVector(r.q) })), MODEL);
        for (const r of rows) idx.add(r.messageId, r.chatId, r.ts, r.q);
        n += rows.length;
        if (n % (BATCH * 10) === 0) emitMlStatus();
        // bilgisayarı sürekli meşgul etmesin: dilimler arası kısa ara
        await new Promise((r) => setTimeout(r, 150));
      }
    } catch (e) {
      bus.log('warn', `Anlamsal dizinleme durdu: ${(e as Error).message.split('\n')[0].slice(0, 160)}`);
    } finally {
      this.running = false;
      if (n) bus.log('info', `Anlamsal arama: ${n} mesaj dizinlendi (toplam ${this.index?.size ?? 0})`);
      emitMlStatus();
      // tarama bitti: günde bir kez yeniden (geçmiş eşitlemesiyle sonradan gelen eski mesajlar için)
      if (!this.stopped && this.cursor === -1) {
        this.cursor = null;
        this.kick(24 * 3600e3);
      } else if (!this.stopped && this.enabled()) this.kick(60_000);
    }
  }

  /** Sorgudaki kişi ipuçlarını sohbet kimliklerine çevir (ad/tanıtıcı/katılımcı adı eşleşmesi) */
  private peopleChats(hints: QueryHints, chats: Array<Pick<Chat, 'id' | 'name' | 'kind' | 'platform'> & { handle: string | null }>): { chats: Set<string> | null; names: string[]; rest: string } {
    const norm = (s: string) => s.toLocaleLowerCase('tr-TR');
    const names = [...hints.people];
    let rest = hints.rest;
    // eksiz tek kelime de kişi olabilir ("ahmet fatura"): birebir sohbetin ilk adıyla tam eşleşiyorsa
    // (e-posta dizileri ve pazaryeri soruları da 'direct'; adları konu başlığıdır — "Fatura 6621" kişi sayılmaz)
    const firstNames = new Set(chats.filter((c) => c.kind === 'direct' && !NOT_PEOPLE.test(c.platform)).map((c) => norm(c.name).split(/\s+/)[0]).filter((w) => w.length >= 3));
    for (const w of keywords(rest)) {
      if (firstNames.has(w) && !names.includes(w)) {
        names.push(w);
        rest = rest.replace(new RegExp(`(^|\\s)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`), ' ').trim();
      }
    }
    if (!names.length) return { chats: null, names, rest };
    const set = new Set<string>();
    for (const c of chats) {
      const hay = [c.name, c.handle ?? ''].map(norm).join(' ');
      if (names.some((n) => hay.split(/[\s@._-]+/).some((t) => t.startsWith(n)))) set.add(c.id);
    }
    return { chats: set.size ? set : null, names, rest };
  }

  /** Tam metin (FTS5, kelimeler VEYA'lı önek, bm25 sırası) — hibrit aramanın ikinci kolu */
  private textHits(words: string[], limit: number): string[] {
    if (!words.length) return [];
    const q = words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(' OR ');
    try {
      const ids = (this.store.mlStmt('SELECT m.id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT ?').all(q, limit) as Array<{ id: string }>).map((r) => r.id);
      const spoken = (this.store.mlStmt("SELECT t.message_id AS id FROM transcripts_fts f JOIN transcripts t ON t.rowid = f.rowid WHERE transcripts_fts MATCH ? AND t.status = 'done' ORDER BY bm25(transcripts_fts) LIMIT ?").all(q, Math.ceil(limit / 4)) as Array<{ id: string }>).map((r) => r.id);
      return [...ids, ...spoken.filter((id) => !ids.includes(id))];
    } catch {
      return [];
    }
  }

  async search(q: string, limit = 50, now = new Date()): Promise<{ hits: SemanticHit[]; mode: 'semantic' | 'text'; hints: { dateLabel?: string; people: string[] }; index: IndexStatus }> {
    const hints = parseQuery(q, now);
    // hafif sohbet listesi (ad/tanıtıcı; katılımcı sütunu okunmaz — listChats aramada fazla ağır)
    const chats = this.store.mlStmt('SELECT id, name, handle, kind, platform FROM chats').all() as Array<Pick<Chat, 'id' | 'name' | 'kind' | 'platform'> & { handle: string | null }>;
    const people = this.peopleChats(hints, chats);
    const words = keywords(people.rest).map(stripSuffix);
    const inRange = (m: { ts: number; chatId: string }) =>
      (hints.from === undefined || m.ts >= hints.from) && (hints.to === undefined || m.ts <= hints.to) && (!people.chats || people.chats.has(m.chatId));

    // tam metin kolu (süzgeçler sonradan)
    const textIds: string[] = [];
    for (const id of this.textHits(words, 400)) {
      if (textIds.length >= limit * 3) break;
      const m = this.store.getMessage(id);
      if (m && inRange(m)) textIds.push(id);
    }

    let semIds: string[] = [];
    const semScore = new Map<string, number>();
    const useModel = isModelUsable('embed') && (people.rest.trim() || !people.names.length);
    if (useModel) {
      const idx = await this.loadIndex();
      if (idx.size) {
        const text = people.rest.trim() || q;
        const [v] = await runMl((b) => b.embed([queryText(text)]), 'interactive');
        const all = await idx.search(v, limit * 3, { from: hints.from, to: hints.to, chats: people.chats, });
        // e5 benzerlikleri dar bir bantta (0,7-0,9): en iyiye göre göreli eşik, alakasız kuyruk atılır
        const found = all.filter((f) => f.score >= (all[0]?.score ?? 0) - 0.08);
        semIds = found.map((f) => f.id);
        for (const f of found) semScore.set(f.id, f.score);
      }
    } else if (!words.length && (people.chats || hints.from !== undefined)) {
      // yalnız kişi/tarih: o aralıktaki en yeni mesajlar
      const rows = this.store
        .mlStmt('SELECT id, chat_id AS chatId, ts FROM messages INDEXED BY messages_ts WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT 2000')
        .all(hints.from ?? 0, hints.to ?? Date.now() + 86400e3) as Array<{ id: string; chatId: string; ts: number }>;
      for (const r of rows) if (inRange(r) && textIds.length < limit) textIds.push(r.id);
    }

    const fused = rrf([semIds, textIds]).slice(0, limit);
    const textSet = new Set(textIds);
    const semSet = new Set(semIds);
    const transcripts = transcriptTexts(this.store, fused.map((f) => f.id));
    const hits: SemanticHit[] = [];
    for (const f of fused) {
      const message = this.store.getMessage(f.id);
      const chat = message ? this.store.getChat(message.chatId) : undefined;
      if (!message || !chat || this.store.isRemoving(chat.accountId)) {
        this.index?.remove(f.id); // silinmiş mesajın vektörü (bellekte kalmış)
        continue;
      }
      const via = semSet.has(f.id) && textSet.has(f.id) ? 'both' : semSet.has(f.id) ? 'semantic' : 'text';
      const transcript = transcripts.get(f.id);
      hits.push({ message, chat, score: semScore.get(f.id) ?? f.score, via, ...(transcript ? { transcript } : {}) });
    }
    return { hits, mode: semIds.length ? 'semantic' : 'text', hints: { dateLabel: hints.dateLabel, people: people.names }, index: this.status() };
  }
}
