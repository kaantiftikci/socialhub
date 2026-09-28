import { WebClient } from '@slack/web-api';
import WebSocket from 'ws';
import fs from 'node:fs';
import { BaseConnector, type OutFile, type SendOptions } from './base.js';
import { bus } from '../bus.js';
import type { Account, Participant, Reaction } from '../model.js';
import type { Store } from '../store.js';
import { SKIP_SUBTYPES, SLACK_EMOJI, completedShareTs, fileToAttachment, formatSlackText, slackEmojiName, type UserInfo } from './browser/slack.js';

/**
 * Slack uygulama bildirimi (manifest): kullanıcı Bağlan ekranındaki bağlantıyla KENDİ çalışma alanında dahili bir uygulama
 * oluşturur (Marketplace dışı dahili uygulamalara Mayıs 2025 hız kısıtı uygulanmıyor), kurar ve User OAuth Token'ı (xoxp)
 * yapıştırır. İsteğe bağlı App-Level Token (xapp, connections:write) verilirse Socket Mode ile anlık olay alınır.
 */
export const SLACK_USER_SCOPES = [
  'channels:history', 'groups:history', 'im:history', 'mpim:history',
  'channels:read', 'groups:read', 'im:read', 'mpim:read', 'users:read', 'chat:write',
  // tepki ver/gör, dosya gönder/indir, okundu işaretle (conversations.mark) ve birebir aç (conversations.open)
  'reactions:read', 'reactions:write', 'files:read', 'files:write', 'channels:write', 'groups:write', 'im:write', 'mpim:write',
];
export const SLACK_MANIFEST = {
  display_information: { name: 'Mivelo', description: 'Mivelo birleşik gelen kutusu — yalnız bu bilgisayarda, kişisel kullanım', background_color: '#6c47ff' },
  oauth_config: { scopes: { user: SLACK_USER_SCOPES } },
  settings: {
    event_subscriptions: { user_events: ['message.channels', 'message.groups', 'message.im', 'message.mpim', 'reaction_added', 'reaction_removed'] },
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
 * Gerekli scope'lar SLACK_USER_SCOPES. Eski bildirimle kurulmuş uygulamada eksik kapsam (missing_scope) varsa ilgili özellik
 * (tepki/dosya/okundu) anlaşılır bir hatayla durur; metin gönderme/alma etkilenmez — Bağlan ekranındaki bağlantıyla yeniden kurmak yeter.
 */
export class SlackConnector extends BaseConnector {
  private web: WebClient;
  private timer?: NodeJS.Timeout;
  private users = new Map<string, UserInfo>();
  /** iş parçacığı: `kanal/üst ts` → son görülen latest_reply (değişmediyse conversations.replies istenmez) */
  private threadsSeen = new Map<string, string>();
  private meId = '';
  private lastTs = new Map<string, string>();
  private polling = false;
  private stopped = false;
  private convs: Array<{ id: string; name: string; kind: 'direct' | 'group' | 'channel' }> = [];
  private convsAt = 0;
  private cursor = 0;
  /** Bağlanma anı (ms): imleci (lastTs) olmayan sohbette yalnız bundan yeni mesajlar canlı sayılır */
  private startedAt = Date.now();
  /** iş parçacığı: `kanal/üst ts` → alınmış en yeni yanıtın ts'i (sonraki istek oldest ile yalnız yenileri getirir) */
  private threadLast = new Map<string, string>();

  /** Socket Mode */
  private sock?: WebSocket;
  private sockUp = false;
  private sockFails = 0;
  private sockTimer?: NodeJS.Timeout;
  /** olay gelen, geçmişi çekilecek sohbetler (1,5 sn'de toplanır) */
  private dirty = new Set<string>();
  private dirtyTimer?: NodeJS.Timeout;
  private dirtyThreads = new Set<string>();

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
    this.startedAt = Date.now();
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
    if (this.stopped) return; // istek sürerken stop(): soket açılmasın
    if (!url) return this.retrySocket();
    const ws = new WebSocket(url);
    this.sock = ws;
    ws.on('message', (data) => {
      let env: { type?: string; envelope_id?: string; payload?: { event?: SlackEvent } };
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
        if (ev?.type === 'message' && ev.channel) {
          this.markDirty(ev.channel);
          // iş parçacığı yanıtı history'de görünmez: üst mesajın yanıtları da çekilsin
          const parent = ev.thread_ts ?? ev.message?.thread_ts;
          if (parent) this.threadsSeen.delete(`${ev.channel}/${parent}`), this.dirtyThreads.add(`${ev.channel}/${parent}`);
        } else if ((ev?.type === 'reaction_added' || ev?.type === 'reaction_removed') && ev.item?.channel && ev.item.ts && ev.reaction && ev.user) {
          void this.onReaction(ev.item.channel, ev.item.ts, ev.reaction, ev.user, ev.type === 'reaction_removed');
        }
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
      const threads = [...this.dirtyThreads];
      this.dirtyThreads.clear();
      for (const key of threads) {
        const [ch, ts] = key.split('/');
        await this.fetchReplies(ch, ts);
      }
    } catch (e) {
      bus.log('warn', `Slack olay işleme: ${(e as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  async sendText(remoteChatId: string, text: string, opts?: SendOptions): Promise<{ remoteId: string }> {
    const res = await this.web.chat.postMessage({ channel: remoteChatId, text, ...(opts?.threadId ? { thread_ts: opts.threadId } : {}) });
    const id = String(res.ts ?? Date.now());
    // lastTs burada ilerletilmez: son yoklamayla bu gönderim arasında karşıdan gelen mesaj (daha eski ts) sonraki
    // yoklamada oldest=<benim ts> yüzünden hiç çekilmiyordu. Kendi mesajım yoklamada aynı ts ile gelip üzerine yazılır.
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'sent', threadId: opts?.threadId });
    return { remoteId: id };
  }

  /** Tepki ver/kaldır (reactions:write). Zaten var/yok hataları sessiz: sonuç aynı */
  async react(remoteChatId: string, remoteMsgId: string, emoji: string, remove: boolean): Promise<void> {
    const name = slackEmojiName(emoji);
    try {
      if (remove) await this.web.reactions.remove({ channel: remoteChatId, timestamp: remoteMsgId, name });
      else await this.web.reactions.add({ channel: remoteChatId, timestamp: remoteMsgId, name });
    } catch (e) {
      const code = slackError(e);
      if (code !== 'already_reacted' && code !== 'no_reaction') throw scopeHint(e, 'tepki');
    }
    this.applyReaction(remoteChatId, remoteMsgId, { emoji: SLACK_EMOJI[name] ?? emoji, senderId: this.meId, senderName: 'Ben', fromMe: true }, remove);
  }

  /** Mivelo'da okununca Slack'te de okundu (conversations.mark; *:write kapsamları) */
  async markRead(remoteChatId: string): Promise<void> {
    const ts = this.lastTs.get(remoteChatId) ?? (await this.web.conversations.history({ channel: remoteChatId, limit: 1 })).messages?.[0]?.ts;
    if (!ts) return;
    try {
      await this.web.conversations.mark({ channel: remoteChatId, ts: String(ts) });
    } catch (e) {
      throw scopeHint(e, 'okundu işaretleme');
    }
  }

  /** Yukarı kaydırınca eski mesajlar: latest = yüklü en eski mesaj */
  async loadHistory(remoteChatId: string, limit: number, before?: number): Promise<void> {
    const c = this.convs.find((x) => x.id === remoteChatId) ?? { id: remoteChatId };
    await this.fetchHistory(c, true, { limit: Math.min(200, limit), latest: before ? (before / 1000).toFixed(6) : undefined });
  }

  /** Dosya (files:write): getUploadURLExternal → baytlar → completeUploadExternal (files.upload emekli) */
  async sendMedia(remoteChatId: string, file: OutFile, caption?: string): Promise<{ remoteId: string }> {
    try {
      const up = await this.web.files.getUploadURLExternal({ filename: file.name, length: file.size });
      if (!up.upload_url || !up.file_id) throw new Error('Slack yükleme adresi vermedi');
      const r = await fetch(up.upload_url, { method: 'POST', body: fs.readFileSync(file.path), headers: { 'content-type': file.mime || 'application/octet-stream' } });
      if (!r.ok) throw new Error(`Slack dosya yükleme ${r.status}`);
      const done = await this.web.files.completeUploadExternal({ files: [{ id: up.file_id, title: file.name }], channel_id: remoteChatId, ...(caption ? { initial_comment: caption } : {}) });
      const ts = completedShareTs(done as never, remoteChatId);
      // paylaşım mesajı birkaç sn içinde oluşur: sohbetin yenisi çekilsin
      this.markDirty(remoteChatId);
      return { remoteId: ts ?? `local-${Date.now()}` };
    } catch (e) {
      throw scopeHint(e, 'dosya gönderme');
    }
  }

  /** Slack dosyaları (url_private) yalnız belirteçle iner (files:read); ana makine denetimi sunucuda (PLATFORM_MEDIA_HOSTS) */
  async fetchMedia(u: string): Promise<{ body: Buffer; type: string } | undefined> {
    let cur = u;
    for (let hop = 0; hop < 5; hop++) {
      const host = new URL(cur).hostname;
      if (!/(^|\.)(slack\.com|slack-edge\.com|slack-files\.com)$/i.test(host)) throw new Error(`yönlendirme izinli değil: ${host}`);
      const r = await fetch(cur, { redirect: 'manual', headers: /(^|\.)slack\.com$/i.test(host) ? { authorization: `Bearer ${this.token}` } : {} });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) {
        cur = new URL(loc, cur).toString();
        continue;
      }
      if (!r.ok) throw new Error(`Slack medya ${r.status}`);
      const type = r.headers.get('content-type') ?? 'application/octet-stream';
      // kapsam yoksa Slack giriş sayfası (HTML) döndürür
      if (/text\/html/i.test(type)) throw new Error('Slack medya 403 (files:read kapsamı yok — uygulamayı yeniden kur)');
      return { body: Buffer.from(await r.arrayBuffer()), type };
    }
    throw new Error('Slack medya: çok fazla yönlendirme');
  }

  /** Grup üyesiyle birebir (conversations.open; im:write) */
  async openDirect(p: Participant): Promise<string> {
    try {
      const r = await this.web.conversations.open({ users: p.id });
      const id = String(r.channel?.id ?? '');
      if (!id) throw new Error('Slack birebir sohbet açmadı');
      this.ensureChat(id, p.name, 'direct');
      if (!this.convs.some((c) => c.id === id)) this.convs.push({ id, name: p.name, kind: 'direct' });
      return id;
    } catch (e) {
      throw scopeHint(e, 'birebir sohbet açma');
    }
  }

  /** Socket Mode tepki olayı: eski mesajlarda da (history'nin oldest penceresi dışında) anında işlenir */
  private async onReaction(channel: string, ts: string, name: string, user: string, remove: boolean): Promise<void> {
    const base = name.split('::')[0];
    const fromMe = user === this.meId;
    this.applyReaction(channel, ts, { emoji: SLACK_EMOJI[base] ?? `:${base}:`, senderId: user, senderName: fromMe ? 'Ben' : (await this.user(user)).name, fromMe }, remove);
  }

  private async user(id: string): Promise<UserInfo> {
    if (!id) return { name: 'Slack' };
    const cached = this.users.get(id);
    if (cached) return cached;
    try {
      const r = id.startsWith('B') ? await this.web.bots.info({ bot: id }) : await this.web.users.info({ user: id });
      const u = ((r as { user?: Record<string, any> }).user ?? (r as { bot?: Record<string, any> }).bot ?? {}) as Record<string, any>;
      const v: UserInfo = { name: u.real_name || u.profile?.display_name || u.name || id, avatar: u.profile?.image_72 ?? u.icons?.image_72, handle: u.name && !id.startsWith('B') ? '@' + u.name : undefined };
      this.users.set(id, v);
      return v;
    } catch {
      return { name: id };
    }
  }

  private async userName(id: string): Promise<string> {
    return id ? (await this.user(id)).name : '';
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
    // users.conversations: yalnız üyesi olunan sohbetler (conversations.list üye olunmayan açık kanalları da sayfaya
    // dolduruyordu) + imleçle tüm sayfalar (tek 200'lük sayfada büyük çalışma alanında DM'ler hiç görünmüyordu)
    const channels: NonNullable<Awaited<ReturnType<WebClient['users']['conversations']>>['channels']> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 25; page++) {
      const r = await this.web.users.conversations({ types: 'im,mpim,private_channel,public_channel', limit: 200, exclude_archived: true, ...(cursor ? { cursor } : {}) });
      channels.push(...(r.channels ?? []));
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    const next: typeof this.convs = [];
    for (const c of channels) {
      if (!c.id) continue;
      const kind = c.is_im ? 'direct' : c.is_mpim ? 'group' : 'channel';
      const name = c.is_im ? await this.userName(String(c.user ?? '')) : `#${c.name ?? c.id}`;
      this.ensureChat(c.id, name, kind);
      next.push({ id: c.id, name, kind });
    }
    this.convs = next;
    this.convsAt = Date.now();
  }

  private async fetchHistory(c: { id: string }, first: boolean, older?: { limit: number; latest?: string }): Promise<void> {
    const hist = await this.web.conversations.history({
      channel: c.id,
      limit: older?.limit ?? (first ? 30 : 20),
      ...(older ? (older.latest ? { latest: older.latest } : {}) : { oldest: first ? undefined : this.lastTs.get(c.id) }),
      inclusive: false,
    });
    const msgs = (hist.messages ?? []) as SlackMsg[];
    // İmleci olmayan sohbet (ilk turda seçilmemiş ya da sonradan listeye girmiş): oldest verilmedi, son mesajlar geldi —
    // yalnız bağlandıktan sonra yazılanlar canlı (eskiler bildirim/okunmamış üretmesin)
    const known = this.lastTs.has(c.id);
    const live = !first && !older;
    for (const m of [...msgs].reverse()) {
      await this.ingest(c.id, m, live && (known || Number(m.ts) * 1000 > this.startedAt));
      const prev = this.lastTs.get(c.id);
      if (!older && m.ts && (!prev || Number(m.ts) > Number(prev))) this.lastTs.set(c.id, String(m.ts));
    }
    // iş parçacığı yanıtları history'de yok: yanıtı olan (ve yeni yanıt gelmiş) üst mesajlarınki ayrıca, tur başına en çok 5
    let n = 0;
    for (const m of msgs) {
      if (!m.reply_count || !m.ts || n >= 5) continue;
      const key = `${c.id}/${m.ts}`;
      const latest = String(m.latest_reply ?? m.reply_count);
      if (this.threadsSeen.get(key) === latest) continue;
      n++;
      await this.fetchReplies(c.id, String(m.ts), latest, live);
    }
  }

  /**
   * Yanıtlar eskiden yeniye gelir: tek 40'lık istekte uzun dizilerin yeni yanıtları hiç alınmıyordu. Artık alınmış en yeni
   * yanıttan (oldest) sonrası, imleçle en çok 5 sayfa. live: yalnız depoda olmayan ve bağlandıktan sonra yazılan yanıtlar canlı.
   */
  private async fetchReplies(channel: string, parentTs: string, latest?: string, live = true): Promise<void> {
    const key = `${channel}/${parentTs}`;
    try {
      const all: SlackMsg[] = [];
      let cursor: string | undefined;
      const oldest = this.threadLast.get(key);
      for (let page = 0; page < 5; page++) {
        const rep = await this.web.conversations.replies({ channel, ts: parentTs, limit: 200, ...(oldest ? { oldest, inclusive: false } : {}), ...(cursor ? { cursor } : {}) });
        all.push(...((rep.messages ?? []) as SlackMsg[]));
        cursor = (rep as { response_metadata?: { next_cursor?: string } }).response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
      for (const x of all) {
        if (!x.ts || String(x.ts) === parentTs) continue;
        const isLive = live && !this.hasMessage(channel, String(x.ts)) && Number(x.ts) * 1000 > this.startedAt;
        await this.ingest(channel, { ...x, thread_ts: parentTs }, isLive);
        const prev = this.threadLast.get(key);
        if (!prev || Number(x.ts) > Number(prev)) this.threadLast.set(key, String(x.ts));
      }
      this.threadsSeen.set(key, latest ?? String(all[0]?.latest_reply ?? all.length));
    } catch {
      /* yanıtlar alınamadı; sonraki olay/yoklamada yeniden */
    }
  }

  /** Slack mesajı → ortak model (tarayıcı yoluyla aynı biçimlendirme: bahsetmeler, bağlantılar, dosyalar, tepkiler) */
  private async ingest(channel: string, m: SlackMsg, live: boolean): Promise<void> {
    if (!m.ts || (m.subtype && SKIP_SUBTYPES.has(m.subtype))) return;
    const files = (m.files ?? []).filter((f) => f.mode !== 'tombstone' && f.mode !== 'hidden_by_limit');
    const uid = String(m.user ?? m.bot_id ?? '');
    // bahsetmelerdeki adlar önbellekte olsun
    for (const id of new Set([...(m.text ?? '').matchAll(/<@([A-Z0-9_]+)>/g)].map((x) => x[1]))) await this.user(id);
    const text = formatSlackText(m.text ?? '', this.users);
    if (!text && !files.length) return;
    const fromMe = uid === this.meId;
    const u = m.subtype === 'bot_message' && m.username ? { name: m.username, avatar: m.icons?.image_64 } : fromMe ? { name: 'Ben' } : await this.user(uid);
    const reactions: Reaction[] = [];
    for (const r of m.reactions ?? []) {
      const name = String(r.name ?? '').split('::')[0];
      const emoji = SLACK_EMOJI[name] ?? `:${name}:`;
      const ids = (r.users ?? []).slice(0, 50);
      for (const id of ids) reactions.push({ emoji, senderId: id, senderName: id === this.meId ? 'Ben' : (this.users.get(id)?.name ?? id), fromMe: id === this.meId });
      for (let i = ids.length; i < Number(r.count ?? ids.length); i++) reactions.push({ emoji, senderId: `${name}#${i}`, senderName: '', fromMe: false });
    }
    const proxied = (x?: string) => (x ? `/api/media/${encodeURIComponent(this.account.id)}?u=${encodeURIComponent(x)}` : undefined);
    this.upsertMessage(
      {
        remoteChatId: channel,
        remoteId: String(m.ts),
        senderId: fromMe ? 'me' : uid || 'bot',
        senderName: u.name,
        senderAvatarUrl: u.avatar,
        fromMe,
        text,
        ts: Math.floor(Number(m.ts) * 1000),
        status: fromMe ? 'sent' : 'delivered',
        attachments: files.length ? files.map((f) => fileToAttachment(f)).map((a) => ({ ...a, url: proxied(a.url), link: proxied(a.link) })) : undefined,
        reactions: reactions.length ? reactions : [],
        threadId: m.thread_ts && String(m.thread_ts) !== String(m.ts) ? String(m.thread_ts) : undefined,
        replyCount: m.reply_count ? Number(m.reply_count) : undefined,
      },
      { live },
    );
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type SlackMsg = {
  ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  icons?: { image_64?: string };
  text?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  files?: Array<Record<string, any>>;
  reactions?: Array<{ name?: string; users?: string[]; count?: number }>;
};
type SlackEvent = {
  type?: string;
  channel?: string;
  subtype?: string;
  thread_ts?: string;
  message?: { thread_ts?: string };
  user?: string;
  reaction?: string;
  item?: { channel?: string; ts?: string };
};

function slackError(e: unknown): string {
  return String((e as { data?: { error?: string } })?.data?.error ?? '');
}
/** Eski bildirimle kurulmuş uygulama: yeni kapsam eksikse ne yapılacağını söyle */
function scopeHint(e: unknown, what: string): Error {
  const code = slackError(e);
  if (code === 'missing_scope' || code === 'not_allowed_token_type') {
    return new Error(`Slack ${what} için yeni izin gerekiyor: Bağlan → Slack'teki bağlantıyla uygulamayı güncelleyip yeniden kur ve yeni xoxp belirtecini gir`);
  }
  return e instanceof Error ? e : new Error(String(e));
}
