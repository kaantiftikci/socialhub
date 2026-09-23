import { WebClient } from '@slack/web-api';
import { BaseConnector } from './base.js';
import { bus } from '../bus.js';
import type { Account } from '../model.js';
import type { Store } from '../store.js';

/**
 * Slack: resmi Web API, kullanıcı token'ı (xoxp-…) ile. Bu demo Socket Mode yerine
 * 15 saniyelik yoklama (polling) kullanır; Slack uygulaması kurmadan çalışır.
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
    await this.poll(true);
    this.timer = setInterval(() => void this.poll(false), 15_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
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

  private async poll(first: boolean): Promise<void> {
    if (this.polling) return; // önceki yoklama sürüyorsa üst üste binme (rate limit)
    this.polling = true;
    try {
      const list = await this.web.conversations.list({ types: 'im,mpim,private_channel,public_channel', limit: 200, exclude_archived: true });
      for (const c of list.channels ?? []) {
        if (!c.id) continue;
        if (c.is_channel && !c.is_member) continue;
        const kind = c.is_im ? 'direct' : c.is_mpim ? 'group' : 'channel';
        const name = c.is_im ? await this.userName(String(c.user ?? '')) : `#${c.name ?? c.id}`;
        this.ensureChat(c.id, name, kind);
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
