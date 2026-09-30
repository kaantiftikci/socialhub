/**
 * Tek iş kuyruğu (eşzamanlılık 1): model çıkarımları sırayla çalışır (bellek dostu; aynı anda iki büyük model yüklenmez).
 * Öncelik: kullanıcının beklediği işler (düğmeye bastı, arama, çeviri) arka plan işlerinin (otomatik yazıya dökme, dizinleme)
 * önüne geçer; aynı öncelikte sıra korunur.
 */
export type Priority = 'interactive' | 'background';

interface Job<T> {
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  prio: number;
  seq: number;
}

export class JobQueue {
  private jobs: Array<Job<unknown>> = [];
  private busy = false;
  private seq = 0;
  /** Kuyruk boşalınca (bekleyen + çalışan yok) */
  onIdle?: () => void;

  get pending(): number {
    return this.jobs.length + (this.busy ? 1 : 0);
  }

  /** Bekleyen arka plan işi sayısı (dizinleyici kuyruğu şişirmesin) */
  get backgroundPending(): number {
    return this.jobs.filter((j) => j.prio === 0).length;
  }

  add<T>(run: () => Promise<T>, priority: Priority = 'background'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({ run, resolve: resolve as (v: unknown) => void, reject, prio: priority === 'interactive' ? 1 : 0, seq: this.seq++ } as Job<unknown>);
      this.jobs.sort((a, b) => b.prio - a.prio || a.seq - b.seq);
      void this.pump();
    });
  }

  /** Bekleyen (başlamamış) arka plan işlerini iptal et */
  clearBackground(reason = new Error('iptal edildi')): void {
    const keep: Array<Job<unknown>> = [];
    for (const j of this.jobs) (j.prio === 0 ? j.reject(reason) : keep.push(j));
    this.jobs = keep;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    const job = this.jobs.shift();
    if (!job) {
      this.onIdle?.();
      return;
    }
    this.busy = true;
    try {
      job.resolve(await job.run());
    } catch (e) {
      job.reject(e);
    } finally {
      this.busy = false;
      void this.pump();
    }
  }
}
