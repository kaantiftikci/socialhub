import { EventEmitter } from 'node:events';
import type { CoreEvent } from './model.js';

type Listener = (ev: CoreEvent) => void;

/** Tek bir olay yolu: connector'lar buraya yazar, sunucu ve depo buradan okur. */
class Bus {
  private em = new EventEmitter();
  /** Son günlük satırları (arayüzdeki "Günlük" paneli için) */
  readonly recent: Array<{ ts: number; level: 'info' | 'warn' | 'error'; text: string }> = [];

  constructor() {
    this.em.setMaxListeners(100);
  }

  emit(ev: CoreEvent): void {
    this.em.emit('event', ev);
  }

  on(fn: Listener): () => void {
    this.em.on('event', fn);
    return () => this.em.off('event', fn);
  }

  log(level: 'info' | 'warn' | 'error', text: string): void {
    const line = `[${new Date().toISOString()}] ${text}`;
    if (level === 'error') console.error(line);
    else console.log(line);
    this.recent.push({ ts: Date.now(), level, text });
    if (this.recent.length > 400) this.recent.splice(0, this.recent.length - 400);
    this.emit({ type: 'log', level, text });
  }
}

export const bus = new Bus();
