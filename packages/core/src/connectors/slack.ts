import { WebClient } from '@slack/web-api';
import WebSocket from 'ws';
import { BaseConnector } from './base.js';
import { bus } from '../bus.js';
import type { Account } from '../model.js';
import type { Store } from '../store.js';

/**
 * Slack uygulama bildirimi (manifest): kullanıcı Bağlan ekranındaki bağlantıyla KENDİ çalışma alanında dahili bir uygulama
 * oluşturur (Marketplace dışı dahili uygulamalara Mayıs 2025 hız kısıtı uygulanmıyor), kurar ve User OAuth Token'ı (xoxp)
 * yapıştırır. İsteğe bağlı App-Level Token (xapp, connections:write) verilirse Socket Mode ile anlık olay alınır.
 */
export const SLACK_USER_SCOPES = ['channels:history', 'groups:history', 'im:history', 'mpim:history', 'channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read', 'chat:write'];
export const SLACK_MANIFEST = {
  display_information: { name: 'Mivelo', description: 'Mivelo birleşik gelen kutusu — yalnız bu bilgisayarda, kişisel kullanım', background_color: '#6c47ff' },
  oauth_config: { scopes: { user: SLACK_USER_SCOPES } },
  settings: {
    event_subscriptions: { user_events: ['message.channels', 'message.groups', 'message.im', 'message.mpim'] },
    socket_mode_enabled: true,
    org_deploy_enabled: false,
    token_rotation_enabled: false,
  },
};

/** Belirteç dosyası: düz "xoxp-…" (eski) ya da JSON {token, appToken} */
export function parseSlackToken(raw: string): { token: string; appToken?: string } | undefined {
  const t = raw.trim();
  if (t.startsWith('xox')) return { token: t };
  if (!t.startsWith('{')) return undefined;
  try {
    const j = JSON.parse(t) as { token?: unknown; appToken?: unknown };
    const token = typeof j.token === 'string' ? j.token.trim() : '';
    if (!token.startsWith('xox')) return undefined;
    const appToken = typeof j.appToken === 'string' && j.appToken.trim().startsWith('xapp-') ? j.appToken.trim() : undefined;
    return { token, appToken };
  } catch {
    return undefined;
  }
}

/**
 * Slack: resmi Web API, kullanıcı token'ı (xoxp-…) ile. App-Level Token varsa Socket Mode: mesaj olayı gelen sohbetin
 * geçmişi hemen çekilir, yoklama ~5 dk'lık yedeğe iner. Yoksa ~60 sn'lik (±%30) yoklama.
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

  /** Socket Mode */
  private sock?: WebSocket;
  private sockUp = false;
  private sockFails = 0;
  private sockTimer?: NodeJS.Timeout;
  /** olay gelen, geçmişi çekilecek sohbetler (1,5 sn'de toplanır) */
  private dirty = new Set<string>();
  private dirtyTimer?: NodeJS.Timeout;

  constructor(account: Account, store: Store, private token: string, private appToken?: string) {
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
    if (this.appToken) void this.openSocket();
  }

  private schedule(): void {
    if (this.stopped) return;
    // Socket Mode açıkken olaylar anında geliyor: yoklama yalnız kaçan olaylar için yedek (~5 dk)
    const base = this.sockUp ? 300_000 : 60_000;
    this.timer = setTimeout(async () => {
      await this.poll(false);
      this.schedule();
    }, Math.round(base * (0.7 + Math.random() * 0.6)));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.sockTimer) clearTimeout(this.sockTimer);
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    this.sock?.removeAllListeners();
    this.sock?.close();
    this.sock = undefined;
    this.sockUp = false;
    this.setStatus('disconnected');
  }

  /**
   * Socket Mode: apps.connections.open (xapp) → wss adresi. Her zarf onaylanır ({envelope_id}); message olayında sohbet
   * "kirli" işaretlenir. Slack bağlantıyı düzenli yeniler ('disconnect' → hemen yeniden aç). Hata/kopmada üstel bekleme ≤5 dk.
   */
  private async openSocket(): Promise<void> {
    if (this.stopped || !this.appToken) return;
    let url: string | undefined;
    try {
      const r = (await new WebClient(this.appToken).apps.connections.open()) as { url?: string };
      url = r.url;
    } catch (e) {
      bus.log('warn', `Slack Socket Mode açılamadı (${(e as Error).message}); yoklamayla devam`);
      return this.retrySocket();
    }
    if (!url) return this.retrySocket();
    const ws = new WebSocket(url);
    this.sock = ws;
    ws.on('message', (data) => {
      let env: { type?: string; envelope_id?: string; payload?: { event?: { type?: string; channel?: string; subtype?: string } } };
      try {
        env = JSON.parse(String(data));
      } catch {
        return;
      }
      if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
      if (env.type === 'hello') {
        if (!this.sockUp) bus.log('info', 'Slack: Socket Mode bağlı, mesajlar anında geliyor');
        this.sockUp = true;
        this.sockFails = 0;
      } else if (env.type === 'disconnect') {
        ws.removeAllListeners();
        ws.close();
        this.sockUp = false;
        void this.openSocket();
      } else if (env.type === 'events_api') {
        const ev = env.payload?.event;
        if (ev?.type === 'message' && ev.channel) this.markDirty(ev.channel);
      }
    });
    ws.on('close', () => {
      if (this.sock !== ws) return;
      this.sockUp = false;
      this.retrySocket();
    });
    ws.on('error', () => undefined);
  }

  private retrySocket(): void {
    if (this.stopped) return;
    const ms = Math.min(300_000, 5_000 * 2 ** this.sockFails++) * (0.7 + Math.random() * 0.6);
    if (this.sockTimer) clearTimeout(this.sockTimer);
    this.sockTimer = setTimeout(() => void this.openSocket(), ms);
  }

  private markDirty(channel: string): void {
    this.dirty.add(channel);
    if (this.dirtyTimer) return;
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = undefined;
      void this.pollDirty();
    }, 1500);
  }

  /** Olay gelen sohbetlerin yalnız yeni mesajları (oldest = son görülen ts) */
  private async pollDirty(): Promise<void> {
    if (this.polling) {
      // yoklama sürüyor: bitince yeniden dene
      this.dirtyTimer = setTimeout(() => {
        this.dirtyTimer = undefined;
        void this.pollDirty();
      }, 2000);
      return;
    }
    const ids = [...this.dirty];
    this.dirty.clear();
    this.polling = true;
    try {
      // listede olmayan (yeni DM/kanal) → liste yenilensin
      if (ids.some((id) => !this.convs.some((c) => c.id === id))) await this.refreshList();
      for (const id of ids) {
        const c = this.convs.find((x) => x.id === id);
        if (c) await this.fetchHistory(c, false);
      }
    } catch (e) {
      bus.log('warn', `Slack olay işleme: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
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
      if (first || Date.now() - this.convsAt > 10 * 60_000) await this.refreshList();
      for (const c of this.pickForPoll(first)) await this.fetchHistory(c, first);
    } catch (e) {
      bus.log('warn', `Slack yoklama hatası: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  private async refreshList(): Promise<void> {
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

  private async fetchHistory(c: { id: string }, first: boolean): Promise<void> {
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
}
