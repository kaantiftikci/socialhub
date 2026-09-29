import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Zamanlanmış gönderim (çekirdekte): arayüz kapalıyken de gider (masaüstü uygulaması tepside çalışırken çekirdek açık kalır).
 * ~/.mivelo/scheduled.json'da kalıcı. Çekirdek kapalıyken zamanı 15 dk'dan fazla geçenler gönderilmez ("kaçırıldı"):
 * gece yarısı sürpriz mesaj gitmesin; arayüz bildirir, kullanıcı isterse yeniden zamanlar.
 */
export interface ScheduledSend {
  id: string;
  chatId: string;
  text: string;
  at: number;
  threadId?: string;
  createdAt: number;
  /** başarısız deneme sayısı (geçici hata: 1 dk sonra yeniden; 3. hatada kaçırıldı sayılır) */
  tries?: number;
  /** kaçırıldı / gönderilemedi: listede kalır, arayüz gösterir */
  missed?: { reason: string; at: number };
}

export const LATE_MS = 15 * 60_000;
const MAX_TRIES = 3;

export class ScheduledQueue {
  private items: ScheduledSend[] = [];
  constructor(private file?: string) {
    if (file) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
        if (Array.isArray(raw)) this.items = raw.filter((x): x is ScheduledSend => !!x && typeof x.id === 'string' && typeof x.chatId === 'string' && typeof x.text === 'string' && typeof x.at === 'number');
      } catch {
        /* dosya yok */
      }
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.items), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      /* disk hatası: bellekte kalır */
    }
  }

  list(chatId?: string): ScheduledSend[] {
    return this.items.filter((s) => !chatId || s.chatId === chatId).sort((a, b) => a.at - b.at);
  }

  add(chatId: string, text: string, at: number, threadId?: string): ScheduledSend {
    const item: ScheduledSend = { id: randomUUID(), chatId, text, at, threadId, createdAt: Date.now() };
    this.items.push(item);
    this.save();
    return item;
  }

  remove(id: string): boolean {
    const n = this.items.length;
    this.items = this.items.filter((s) => s.id !== id);
    if (this.items.length !== n) this.save();
    return this.items.length !== n;
  }

  /** Tüm verileri sil */
  clear(): void {
    this.items = [];
    this.save();
  }

  /** Sohbet silinince bekleyenleri de at */
  removeChat(chatId: string): void {
    const n = this.items.length;
    this.items = this.items.filter((s) => s.chatId !== chatId);
    if (this.items.length !== n) this.save();
  }

  /**
   * Zamanı gelenleri gönder. send hata fırlatırsa: kalıcı hata (sınır/429, sohbet yok) → kaçırıldı; geçici → 1 dk sonra yeniden.
   * Dönüş: gönderilenler ve bu turda kaçırıldı sayılanlar (arayüze olay olarak gider).
   */
  async flush(send: (s: ScheduledSend) => Promise<void>, now = Date.now()): Promise<{ sent: ScheduledSend[]; missed: ScheduledSend[] }> {
    const sent: ScheduledSend[] = [];
    const missed: ScheduledSend[] = [];
    // gönderilemeyenler 7 gün listede kalır (kullanıcı görür / düzenler), sonra silinir
    const n0 = this.items.length;
    this.items = this.items.filter((x) => !x.missed || now - x.missed.at < 7 * 86_400_000);
    if (this.items.length !== n0) this.save();
    for (const s of this.items.filter((x) => !x.missed && x.at <= now).sort((a, b) => a.at - b.at)) {
      if (now - s.at > LATE_MS && !s.tries) {
        s.missed = { reason: 'Mivelo kapalıyken zamanı geçti', at: now };
        missed.push(s);
        continue;
      }
      try {
        await send(s);
        this.items = this.items.filter((x) => x.id !== s.id);
        sent.push(s);
      } catch (e) {
        const msg = (e as Error).message || 'gönderilemedi';
        const permanent = (e as { status?: number }).status !== undefined && [400, 404, 429].includes((e as { status: number }).status);
        s.tries = (s.tries ?? 0) + 1;
        if (permanent || s.tries >= MAX_TRIES) {
          s.missed = { reason: msg.slice(0, 200), at: now };
          missed.push(s);
        } else s.at = now + 60_000;
      }
    }
    if (sent.length || missed.length || this.items.some((x) => x.tries)) this.save();
    return { sent, missed };
  }
}
