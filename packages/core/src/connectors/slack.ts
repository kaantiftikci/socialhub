import { WebClient } from '@slack/web-api';
import { BaseConnector } from './base.js';
import { bus } from '../bus.js';
import type { Account } from '../model.js';
import type { Store } from '../store.js';

/**
 * Slack: resmi Web API, kullanıcı token'ı (xoxp-…) ile. Socket Mode yerine ~60 sn'lik (±%30) yoklama kullanır.
 * Hız sınırları: conversations.list 10 dk önbellekli; conversations.history (Tier 3, ~50/dk) tur başına en çok
 * HISTORY_PER_POLL kanal — DM'ler ve yakın zamanda etkin olanlar önce, kalanlar sırayla dönüşümlü. 429'da WebClient
 * Retry-After kadar bekler.
 * Gerekli scope'lar: channels:history, groups:history, im:history, mpim:history,
 * channels:read, groups:read, im:read, mpim:read, users:read, chat:write.
 */
export class SlackConnector extends BaseConnector {
  private web: WebClient;
  private timer?: NodeJS.Timeout;
  private users = new Map<string, string>();
  private meId = '';
  private lastTs = new Map<string, string>();
  private polling = false;
  private stopped = false;
  private convs: Array<{ id: string; name: string; kind: 'direct' | 'group' | 'channel' }> = [];
  private convsAt = 0;
  private cursor = 0;

  constructor(account: Account, store: Store, private token: string) {
    super(account, store);
    this.web = new WebClient(token);
  }

  async start(): Promise<void> {
    this.setStatus('connecting');
    try {
      const auth = await this.web.auth.test();
      this.meId = String(auth.user_id ?? '');
      this.account.label = `${auth.user ?? 'slack'} @ ${auth.team ?? ''}`.trim();
      this.setStatus('connected');
    } catch (e) {
      this.setStatus('error', `Slack token doğrulanamadı: ${(e as Error).message}`);
      return;
    }
    this.stopped = false;
    await this.poll(true);
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      await this.poll(false);
      this.schedule();
    }, Math.round(60_000 * (0.7 + Math.random() * 0.6)));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.setStatus('disconnected');
  }

  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    const res = await this.web.chat.postMessage({ channel: remoteChatId, text });
    const id = String(res.ts ?? Date.now());
    this.lastTs.set(remoteChatId, id);
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'sent' });
    return { remoteId: id };
  }

  private async userName(id: string): Promise<string> {
    if (!id) return '';
    const cached = this.users.get(id);
    if (cached) return cached;
    try {
      const r = await this.web.users.info({ user: id });
      const name = r.user?.real_name || r.user?.name || id;
      this.users.set(id, name);
      return name;
    } catch {
      return id;
    }
  }

  /** Bu turda geçmişi çekilecek sohbetler: yarısı en son etkin olanlar (DM öncelikli), yarısı dönüşümlü sıradakiler */
  private pickForPoll(first: boolean): typeof this.convs {
    const HISTORY_PER_POLL = first ? 40 : 20;
    if (this.convs.length <= HISTORY_PER_POLL) return this.convs;
    const recent = [...this.convs]
      .sort((a, b) => Number(this.lastTs.get(b.id) ?? 0) + (b.kind === 'direct' ? 1e9 : 0) - (Number(this.lastTs.get(a.id) ?? 0) + (a.kind === 'direct' ? 1e9 : 0)))
      .slice(0, HISTORY_PER_POLL / 2);
    const picked = new Set(recent.map((c) => c.id));
    const out = [...recent];
    for (let i = 0; i < this.convs.length && out.length < HISTORY_PER_POLL; i++) {
      const c = this.convs[(this.cursor + i) % this.convs.length];
      if (picked.has(c.id)) continue;
      out.push(c);
      picked.add(c.id);
    }
    this.cursor = (this.cursor + HISTORY_PER_POLL / 2) % this.convs.length;
    return out;
  }

  private async poll(first: boolean): Promise<void> {
    if (this.polling) return; // önceki yoklama sürüyorsa üst üste binme (rate limit)
    this.polling = true;
    try {
      if (first || Date.now() - this.convsAt > 10 * 60_000) {
        const list = await this.web.conversations.list({ types: 'im,mpim,private_channel,public_channel', limit: 200, exclude_archived: true });
        const next: typeof this.convs = [];
        for (const c of list.channels ?? []) {
          if (!c.id) continue;
          if (c.is_channel && !c.is_member) continue;
          const kind = c.is_im ? 'direct' : c.is_mpim ? 'group' : 'channel';
          const name = c.is_im ? await this.userName(String(c.user ?? '')) : `#${c.name ?? c.id}`;
          this.ensureChat(c.id, name, kind);
          next.push({ id: c.id, name, kind });
        }
        this.convs = next;
        this.convsAt = Date.now();
      }
      for (const c of this.pickForPoll(first)) {
        const hist = await this.web.conversations.history({
          channel: c.id,
          limit: first ? 30 : 20,
          oldest: first ? undefined : this.lastTs.get(c.id),
          inclusive: false,
        });
        const msgs = (hist.messages ?? []).filter((m) => m.ts && (m.text || m.files?.length));
        for (const m of msgs.reverse()) {
          const uid = String(m.user ?? m.bot_id ?? '');
          const fromMe = uid === this.meId;
          this.upsertMessage(
            {
              remoteChatId: c.id,
              remoteId: String(m.ts),
              senderId: fromMe ? 'me' : uid,
              senderName: fromMe ? 'Ben' : await this.userName(uid),
              fromMe,
              text: m.text ?? '',
              ts: Math.floor(Number(m.ts) * 1000),
              status: fromMe ? 'sent' : 'delivered',
              attachments: m.files?.length ? m.files.map((f) => ({ kind: 'file' as const, name: f.name, mime: f.mimetype, size: f.size })) : undefined,
            },
            { live: !first },
          );
          const prev = this.lastTs.get(c.id);
          if (!prev || Number(m.ts) > Number(prev)) this.lastTs.set(c.id, String(m.ts));
        }
      }
    } catch (e) {
      bus.log('warn', `Slack yoklama hatası: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }
}
