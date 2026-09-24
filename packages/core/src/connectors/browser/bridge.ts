import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { BrowserContext, Page } from 'playwright';
import { BaseConnector, type StartOptions } from '../base.js';
import { chatId } from '../../model.js';
import { persistSessionCookies } from './outlook.js';
import { bus } from '../../bus.js';
import { sessionDir } from '../../config.js';
import type { Account, Attachment, ChatKind, Participant } from '../../model.js';
import type { Store } from '../../store.js';

/**
 * Tarayıcı köprüsü: resmi mesaj API'si olmayan platformlar (LinkedIn, X, Instagram, Messenger)
 * için kalıcı profilli bir Chromium penceresi açılır; kullanıcı bir kez giriş yapar.
 * Sonrasında platformun kendi web istemcisinin kullandığı iç uçlar sayfa bağlamında
 * (çerezlerle) çağrılır ya da DOM okunur. Oturum ~/.kavsak/sessions/<hesap>/profile altında kalır.
 *
 * Bu yollar platformların kullanım koşullarına aykırı olabilir; test hesabı kullan.
 */
export interface Thread {
  id: string;
  name: string;
  kind: ChatKind;
  lastTs: number;
  preview: string;
  unread: number;
  avatarUrl?: string;
  handle?: string;
  link?: string;
  participants?: Participant[];
  /** Karşı tarafın son gördüğü an (ms): bundan eski giden mesajlar 'görüldü' olur */
  readByOthersUpTo?: number;
  /** Aynı sohbetin eski kimlikleri (ör. X'te eski DM grubu "<id>" → XChat "g<id>"): depoda varsa bu sohbete birleştirilir */
  aliases?: string[];
}

export interface Msg {
  id: string;
  text: string;
  ts: number;
  fromMe: boolean;
  senderId: string;
  senderName: string;
  attachments?: Attachment[];
  senderAvatarUrl?: string;
  /** Platform iletim/görülme bilgisi veriyorsa (varsayılan: benimkiler 'sent', gelenler 'delivered') */
  status?: 'sent' | 'delivered' | 'read';
}

export interface Strategy {
  home: string;
  loginHint: string;
  /** Giriş yapılmış mı? (çerezler Node tarafında okunur, sayfa da verilir) */
  /** passive=true: görünür giriş penceresi açıkken çağrılır — sayfayı YÖNLENDİRME, yalnızca çerez/URL'ye bak (kullanıcının girişini bölmemek için) */
  loggedIn(page: Page, cookies: Record<string, string>, passive?: boolean): Promise<boolean>;
  /** Kendi kimliğini ve görünen adını döndür */
  me(page: Page, cookies: Record<string, string>): Promise<{ id: string; label: string }>;
  threads(page: Page, cookies: Record<string, string>): Promise<Thread[]>;
  /** `before`: verilirse bu zamandan (ms) eski mesajlar (eski mesaj yükleme) */
  messages(page: Page, cookies: Record<string, string>, threadId: string, limit: number, before?: number): Promise<Msg[]>;
  /** true: API tabanlı strateji, mesaj çağrıları paralel yapılabilir (DOM okuyanlar tek sayfayı paylaştığı için sıralı) */
  parallel?: boolean;
  send(page: Page, cookies: Record<string, string>, threadId: string, text: string): Promise<string | undefined>;
  /** Bir üyeyle birebir sohbet kimliği (yoksa oluştur) */
  openDirect?(page: Page, cookies: Record<string, string>, participant: Participant): Promise<string>;
  /** Platformda okundu işaretle; lastIncomingId depodaki son gelen mesajın kimliği */
  markRead?(page: Page, cookies: Record<string, string>, threadId: string, lastIncomingId?: string): Promise<void>;
  /** http(s) olmayan özel medya şeması (ör. X'in "xc:<sohbet>/<ek>" çözülmüş OPFS dosyaları): strateji sayfa bağlamından okur */
  fetchMedia?(page: Page, cookies: Record<string, string>, u: string): Promise<{ body: Buffer; type: string } | undefined>;
  /** Fotoğraf/video/dosya gönder: genelde düzenleyicideki input[type=file]'a setInputFiles ile; dönen kimlik ya da undefined */
  sendFile?(page: Page, cookies: Record<string, string>, threadId: string, file: { path: string; name: string; mime: string; size: number }, caption?: string): Promise<string | undefined>;
  /** Sohbet listesinin `pageIndex`. sayfası (1 = ilk sayfadan sonraki); boş dizi = daha yok */
  moreThreads?(page: Page, cookies: Record<string, string>, pageIndex: number): Promise<Thread[]>;
  /** Kayıtlı oturum olsa da "Yeniden bağlan"da görünür pencere gerekiyor mu (ör. Messenger uçtan uca şifreli geçmiş için PIN adımı)? */
  needsWindow?(page: Page): Promise<boolean>;
  /** Görünür pencere kapatılmadan önce: kullanıcının tamamlaması gereken ek adım (PIN) için bekle */
  afterLogin?(page: Page): Promise<void>;
}

export class BrowserConnector extends BaseConnector {
  private chromium?: (typeof import('playwright'))['chromium'];
  private ctx?: BrowserContext;
  private page?: Page;
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private polling = false;
  private known = new Map<string, number>(); // threadId → son görülen ts

  constructor(
    account: Account,
    store: Store,
    private strategy: Strategy,
    private pollMs = 20_000,
  ) {
    super(account, store);
  }

  async start(opts: StartOptions = {}): Promise<void> {
    const interactive = opts.interactive !== false;
    this.stopping = false;
    try {
      ({ chromium: this.chromium } = await import('playwright'));
    } catch {
      this.setStatus('error', 'playwright paketi yok: npm i playwright && npx playwright install chromium');
      return;
    }
    this.setStatus('connecting');

    // 1) Kayıtlı oturum var mı? Önce görünmez pencerede dene.
    if (!(await this.launch(true))) return;
    this.syncProgress(20, 'tarayıcı açıldı');
    const loggedIn = await this.isLoggedIn();
    // Giriş var ama platform görünür pencerede ek adım istiyor (Messenger PIN): yalnızca kullanıcı 'Yeniden bağlan' dediyse pencere aç
    const needsWindow = loggedIn && interactive && !!this.strategy.needsWindow && (await withTimeout(this.strategy.needsWindow(this.page!), 30_000, 'pencere denetimi').catch(() => false));
    if (!loggedIn || needsWindow) {
      if (!interactive) {
        // Açılışta pencere fırlatma: kullanıcı "Yeniden bağlan" deyince giriş penceresi açılır.
        await this.closeCtx();
        this.setStatus('pairing', 'Giriş gerekli — kanala sağ tıklayıp "Yeniden bağlan" de');
        return;
      }
      // 2) Yok: görünür pencere aç, kullanıcı giriş yapsın; izin adımları bitince pencereyi kapat.
      await this.closeCtx();
      if (!(await this.launch(false))) return;
      this.setStatus('pairing', this.strategy.loginHint);
      if (!(await this.waitForLogin())) return;
      // Platforma özgü son adım (Messenger: "PIN kodunu gir") — pencere hâlâ açıkken
      if (this.strategy.afterLogin && this.page && !this.page.isClosed()) await this.strategy.afterLogin(this.page).catch(() => undefined);
      // Görünür pencereden görünmeze geçişte süresiz (oturum) çerezleri silinir → Microsoft/Google/Apple oturumu düşer.
      // Pencere kapanmadan tüm oturum çerezlerini 30 günlük çereze çevir (tüm tarayıcı kanalları)
      if (this.ctx) {
        const n = await persistSessionCookies(this.ctx, /./).catch(() => 0);
        if (n) bus.log('info', `${this.account.platform}: ${n} oturum çerezi kalıcı yapıldı`);
      }
      bus.log('info', `${this.account.platform}: giriş yapıldı, pencere kapatılıyor`);
      await this.closeCtx();
      if (!(await this.launch(true))) return;
    }
    if (this.stopping) return;
    try {
      const me = await this.strategy.me(this.page!, await this.cookies());
      this.account.label = me.label;
    } catch {
      /* etiket kalsın */
    }
    this.syncProgress(45, 'oturum doğrulandı');
    this.setStatus('connected');
    await this.poll(true);
    this.syncProgress(100);
    this.timer = setInterval(() => void this.poll(false), this.pollMs);
  }

  /** Kalıcı profille Chromium aç. headless=true: arka planda çalışan görünmez pencere. */
  private async launch(headless: boolean, retried = false): Promise<boolean> {
    const profile = path.join(sessionDir(this.account.id), 'profile');
    try {
      const hidden = headless || process.env.KAVSAK_HEADLESS === '1';
      this.ctx = await this.chromium!.launchPersistentContext(profile, {
        headless: hidden,
        // Görünmez modda Chromium kimliği "HeadlessChrome" içerir; Microsoft/Google bazı oturumları bu yüzden reddeder
        // (Outlook görünmezde login.microsoftonline.com'a düşüyordu). Görünür pencereyle aynı gerçek kimlik kullanılır.
        userAgent: hidden ? await realUserAgent(this.chromium!) : undefined,
        // tam Chromium (headless-shell değil): siteler "yeni headless" modu normal tarayıcı gibi görür
        channel: process.env.KAVSAK_CHROMIUM ? undefined : 'chromium',
        executablePath: process.env.KAVSAK_CHROMIUM || undefined,
        viewport: { width: 1180, height: 820 },
        locale: 'tr-TR',
        args: ['--disable-blink-features=AutomationControlled'],
      });
    } catch (e) {
      const msg = (e as Error).message;
      // Önceki çekirdekten kalan Chromium profil kilidini tutuyorsa: o süreci kapat, kilidi sil, bir kez daha dene
      if (!retried && /ProcessSingleton|SingletonLock|profile directory is already in use/i.test(msg)) {
        bus.log('warn', `${this.account.platform}: profil kilidi bulundu (eski tarayıcı açık kalmış); temizlenip yeniden deneniyor`);
        await new Promise<void>((r) => execFile('pkill', ['-f', `--user-data-dir=${profile}`], () => r()));
        await sleep(1500);
        for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) fs.rmSync(path.join(profile, f), { force: true });
        return this.launch(headless, true);
      }
      this.setStatus('error', `Chromium açılamadı: ${msg.split('\n')[0]}. Çözüm: npx playwright install chromium`);
      return false;
    }
    const ctx = this.ctx;
    this.page = ctx.pages()[0] ?? (await ctx.newPage());
    ctx.on('close', () => {
      if (this.ctx !== ctx) return; // biz kapattık (görünürden görünmeze geçiş)
      if (!this.stopping) this.setStatus('disconnected', 'Tarayıcı penceresi kapatıldı');
      if (this.timer) clearInterval(this.timer);
    });
    await this.page.goto(this.strategy.home, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    return true;
  }

  private async closeCtx(): Promise<void> {
    const ctx = this.ctx;
    this.ctx = undefined;
    this.page = undefined;
    await ctx?.close().catch(() => undefined);
  }

  private async isLoggedIn(passive = false): Promise<boolean> {
    if (!this.page || this.page.isClosed()) return false;
    try {
      return await this.strategy.loggedIn(this.page, await this.cookies(), passive);
    } catch {
      return false;
    }
  }

  /**
   * Kullanıcı görünür pencerede giriş yapana kadar bekle. Çerezler göründükten sonra
   * platformun izin/onay adımları (2FA, "girişi kaydet", uygulama izinleri) için sayfa
   * birkaç saniye hareketsiz kalana dek bekler, sonra döner.
   */
  private async waitForLogin(): Promise<boolean> {
    let ticks = 0;
    while (!this.stopping) {
      this.adoptNewestPage();
      if (!this.page || this.page.isClosed()) {
        bus.log('warn', `${this.account.platform}: giriş penceresi kapatıldı, giriş tamamlanmadı`);
        return false;
      }
      if (await this.isLoggedIn(true)) break;
      // ilerleme görünür olsun: 20 sn'de bir hangi sayfada beklendiği
      if (++ticks % 10 === 0) bus.log('info', `${this.account.platform}: giriş bekleniyor (${this.page.url().slice(0, 90)})`);
      await sleep(2000);
    }
    if (this.stopping) return false;
    bus.log('info', `${this.account.platform}: giriş algılandı (${this.page?.url().slice(0, 90)}), izin adımları için bekleniyor`);
    // izin ekranları: URL 4 sn boyunca değişmeyene ve giriş hâlâ geçerli olana kadar bekle (en fazla 60 sn)
    let lastUrl = '';
    let stableFor = 0;
    for (let i = 0; i < 30 && !this.stopping; i++) {
      this.adoptNewestPage();
      if (!this.page || this.page.isClosed()) return false;
      const url = this.page.url();
      const stillIn = await this.isLoggedIn(true);
      if (url === lastUrl && stillIn) stableFor += 2;
      else stableFor = 0;
      lastUrl = url;
      if (stableFor >= 4) break;
      await sleep(2000);
    }
    return !this.stopping;
  }

  /**
   * Görünür giriş penceresinde site yeni sekme açtıysa (OAuth / "çalışma alanını aç" bağlantıları yeni sekmede
   * açılabilir) girişi o sekmede izle; ilk sekme kapandıysa da kalan sekmeye geç.
   */
  private adoptNewestPage(): void {
    const pages = this.ctx?.pages().filter((p) => !p.isClosed()) ?? [];
    const newest = pages[pages.length - 1];
    if (newest && newest !== this.page && (!this.page || this.page.isClosed() || newest.url() !== 'about:blank')) this.page = newest;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.closeCtx();
    this.setStatus('disconnected');
  }

  /** Strateji çağrıları tek sayfayı paylaşır: yoklama, gönderme ve geçmiş isteği sırayla çalışsın (sayfa gezintisi çakışmasın). */
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    if (!this.page || this.page.isClosed()) throw new Error('Tarayıcı oturumu açık değil');
    const id = (await this.serial(async () => this.strategy.send(this.page!, await this.cookies(), remoteChatId, text))) ?? `local-${Date.now()}`;
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'sent' });
    return { remoteId: id };
  }

  async sendMedia(remoteChatId: string, file: { path: string; name: string; mime: string; size: number }, caption?: string): Promise<{ remoteId: string }> {
    if (!this.strategy.sendFile) throw new Error('Bu platformda dosya gönderme desteklenmiyor');
    if (!this.page || this.page.isClosed()) throw new Error('Tarayıcı oturumu açık değil');
    const id = (await this.serial(async () => this.strategy.sendFile!(this.page!, await this.cookies(), remoteChatId, file, caption))) ?? `local-${Date.now()}`;
    const kind = file.mime.startsWith('image/') ? 'image' : file.mime.startsWith('video/') ? 'video' : file.mime.startsWith('audio/') ? 'audio' : 'file';
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text: caption ?? '', ts: Date.now(), status: 'sent', attachments: [{ kind, name: file.name, mime: file.mime, size: file.size }] });
    return { remoteId: id };
  }

  private morePage = 0;
  async loadMoreChats(): Promise<number> {
    if (!this.strategy.moreThreads) throw new Error('Bu platformda daha eski sohbet listesi desteklenmiyor');
    if (!this.page || this.page.isClosed()) throw new Error('Tarayıcı oturumu açık değil');
    const idx = this.morePage + 1;
    const threads = await this.serial(async () => this.strategy.moreThreads!(this.page!, await this.cookies(), idx));
    let added = 0;
    for (const t of threads) {
      if (!this.store.getChat(chatId(this.account.id, t.id))) added++;
      this.upsertChat({ remoteId: t.id, name: t.name, kind: t.kind, unread: t.unread, lastMessageAt: t.lastTs || undefined, lastPreview: t.preview || undefined, avatarUrl: t.avatarUrl, handle: t.handle, link: t.link, participants: t.participants });
    }
    if (threads.length) this.morePage = idx;
    return added;
  }

  async markRead(remoteChatId: string): Promise<void> {
    if (!this.strategy.markRead || !this.page || this.page.isClosed()) return;
    const last = this.store.listMessages(chatId(this.account.id, remoteChatId), 30).filter((m) => !m.fromMe).pop();
    await this.serial(async () => this.strategy.markRead!(this.page!, await this.cookies(), remoteChatId, last?.remoteId));
  }

  async openDirect(p: Participant): Promise<string> {
    if (!this.strategy.openDirect) throw new Error('Bu platformda doğrudan sohbet açma desteklenmiyor');
    if (!this.page || this.page.isClosed()) throw new Error('Tarayıcı oturumu açık değil');
    return this.serial(async () => this.strategy.openDirect!(this.page!, await this.cookies(), p));
  }

  async loadHistory(remoteChatId: string, limit = 50, before?: number): Promise<void> {
    if (!this.page) return;
    const msgs = await this.serial(async () => this.strategy.messages(this.page!, await this.cookies(), remoteChatId, limit, before));
    for (const m of msgs) this.ingest(remoteChatId, m, false);
  }

  /**
   * Oturum çerezleriyle medya indir (X'in DM görselleri, Instagram CDN'i vb. arayüzden doğrudan açılamaz).
   * Disk önbelleği: ~/.kavsak/sessions/<hesap>/media/<sha1>. CDN bağlantıları süreli olduğundan
   * bir kez inen dosya sonra da gösterilebilir.
   */
  async fetchMedia(url: string): Promise<{ body: Buffer; type: string } | undefined> {
    const dir = path.join(sessionDir(this.account.id), 'media');
    const key = createHash('sha1').update(url).digest('hex');
    const file = path.join(dir, key);
    if (fs.existsSync(file) && fs.existsSync(file + '.type')) {
      return { body: fs.readFileSync(file), type: fs.readFileSync(file + '.type', 'utf8') };
    }
    if (!this.ctx) return undefined;
    let body: Buffer;
    let type: string;
    if (!/^https?:\/\//.test(url)) {
      // özel şema: stratejinin kancası (sayfa bağlamından okur; tek sayfayı paylaştığı için sırayla)
      if (!this.strategy.fetchMedia || !this.page || this.page.isClosed()) return undefined;
      const r = await this.serial(async () => this.strategy.fetchMedia!(this.page!, await this.cookies(), url));
      if (!r) return undefined;
      ({ body, type } = r);
    } else {
      const r = await this.ctx.request.get(url, { timeout: 25_000, headers: { referer: new URL(this.strategy.home).origin + '/' } });
      if (!r.ok()) throw new Error(`medya ${r.status()}`);
      body = await r.body();
      type = r.headers()['content-type'] ?? 'application/octet-stream';
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body);
    fs.writeFileSync(file + '.type', type);
    return { body, type };
  }

  /** Uzak medya adresini çekirdeğin vekil yoluna çevir (arayüz API_BASE ile önekler). */
  private proxied(u: string | undefined): string | undefined {
    // http(s) adresleri ve stratejiye özel şemalar ("xc:…") vekilden geçer; vekil yolu / data: / blob: olduğu gibi kalır
    if (!u || u.startsWith('/') || /^(data|blob):/.test(u)) return u;
    return `/api/media/${encodeURIComponent(this.account.id)}?u=${encodeURIComponent(u)}`;
  }

  private async cookies(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const c of (await this.ctx?.cookies()) ?? []) out[c.name] = c.value;
    return out;
  }

  private async poll(first: boolean): Promise<void> {
    if (this.polling || !this.page || this.page.isClosed()) return;
    this.polling = true;
    try {
      await this.serial(() => this.pollInner(first));
    } finally {
      this.polling = false;
    }
  }

  private async pollInner(first: boolean): Promise<void> {
    if (!this.page || this.page.isClosed()) return;
    const page = this.page;
    try {
      const cookies = await this.cookies();
      // Strateji çağrıları asılı kalmasın: sayfa donarsa uyarı düşsün, sonraki yoklama devam etsin
      const threads = await withTimeout(this.strategy.threads(page, cookies), 120_000, 'sohbet listesi');
      if (first) this.syncProgress(70, `${threads.length} sohbet, mesajlar alınıyor`);
      const changed: Thread[] = [];
      for (const t of threads) {
        // lastTs=0: strateji zaman bilgisi vermiyor (DOM okuyan Messenger) → depodaki değer korunur
        // Kavşak'ta okunan sohbeti platformun eski 'okunmamış' değeri geri açmasın: yalnızca yeni etkinlikte aktar
        const ex = this.store.getChat(chatId(this.account.id, t.id));
        // lastTs=0 (DOM okuyan Messenger): çekirdek yeniden başladıysa platformun okunmamış durumu depoya aktarılsın
        // ilk yoklamada (açılış) platformun okunmamış/önizleme değeri yetkili; sonra yalnızca yeni etkinlikte
        const fresh = first || !ex || t.lastTs > ex.lastMessageAt || !ex.lastPreview;
        // okunmamış her zaman platformun değeri: telefonda okunan sohbet burada da okundu olur (Kavşak'ta okunan platforma markRead ile gider)
        this.upsertChat({ remoteId: t.id, name: t.name, kind: t.kind, unread: t.unread, lastMessageAt: t.lastTs || undefined, lastPreview: fresh ? t.preview || undefined : undefined, avatarUrl: t.avatarUrl, handle: t.handle, link: t.link, participants: t.participants });
        if (t.readByOthersUpTo) this.outgoingRead(t.id, t.readByOthersUpTo);
        // eski kimlikli kopya (hedef sohbet yukarıda yazıldı)
        for (const a of t.aliases ?? []) {
          const from = chatId(this.account.id, a);
          if (a !== t.id && this.store.getChat(from)) {
            this.store.mergeChats(from, chatId(this.account.id, t.id));
            bus.emit({ type: 'chat.delete', chatId: from });
          }
        }
        if (!this.known.has(t.id) || (this.known.get(t.id) ?? 0) < t.lastTs) changed.push(t);
      }
      const batch = changed.slice(0, first ? 16 : 8);
      const failed: string[] = [];
      let firstErr = '';
      // API stratejileri 4'lü paralel; DOM okuyanlar sıralı (tek sayfayı paylaşır)
      const width = this.strategy.parallel ? 4 : 1;
      for (let i = 0; i < batch.length; i += width) {
        await Promise.all(
          batch.slice(i, i + width).map(async (t) => {
            try {
              const msgs = await withTimeout(this.strategy.messages(page, cookies, t.id, first ? 25 : 15), 60_000, 'mesajlar');
              for (const m of msgs) this.ingest(t.id, m, !first && !this.hasMessage(t.id, m.id));
              this.known.set(t.id, t.lastTs);
            } catch (e) {
              failed.push(t.id);
              firstErr ||= (e as Error).message;
            }
          }),
        );
      }
      // aynı hata her sohbet için ayrı satır basmasın: yoklama başına tek özet
      if (failed.length) bus.log('warn', `${this.account.platform} mesajlar alınamadı: ${failed.length}/${batch.length} sohbet (ilk: ${failed[0]}): ${firstErr}`);
      if (first) bus.log('info', `${this.account.platform}: ${threads.length} sohbet yüklendi`);
    } catch (e) {
      bus.log('warn', `${this.account.platform} yoklama: ${(e as Error).message}`);
      if (!(await this.isLoggedIn())) {
        bus.log('warn', `${this.account.platform}: oturum düşmüş, yeniden giriş gerekli`);
        if (this.timer) clearInterval(this.timer);
        this.polling = false;
        await this.closeCtx();
        this.setStatus('pairing', 'Oturum düştü — kanala sağ tıklayıp "Yeniden bağlan" de');
        return;
      }
    }
  }

  private ingest(threadId: string, m: Msg, live: boolean): void {
    if (!m.text && !m.attachments?.length) return;
    // Platformun okunmamış sayısı yetkili (threads() ile yazılır); canlı mesaj burada ayrıca +1 yapmasın (çift sayım)
    this.upsertMessage(
      {
        remoteChatId: threadId,
        remoteId: m.id,
        senderId: m.fromMe ? 'me' : m.senderId,
        senderName: m.fromMe ? 'Ben' : m.senderName,
        fromMe: m.fromMe,
        text: m.text,
        ts: m.ts,
        status: m.status ?? (m.fromMe ? 'sent' : 'delivered'),
        senderAvatarUrl: m.senderAvatarUrl,
        attachments: m.attachments?.length ? m.attachments.map((a) => ({ ...a, url: this.proxied(a.url), link: isMediaFile(a.link) ? this.proxied(a.link) : a.link })) : undefined,
      },
      { live, bump: false },
    );
  }
}

/** Bağlantı bir medya dosyası mı (gönderi sayfası değil)? Bunlar vekil üzerinden, çerezlerle indirilir. */
function isMediaFile(u: string | undefined): boolean {
  if (!u) return false;
  // fbsbx.com: Instagram/Messenger sesli mesaj ve dosyaları; ton.x.com: X eski DM medyası; linkedin.com/dms: LinkedIn ekleri (çerez ister)
  return /(ton\.(x|twitter)\.com|video\.twimg\.com|pbs\.twimg\.com|cdninstagram\.com|fbcdn\.net|fbsbx\.com|licdn\.com|linkedin\.com\/dms\/|giphy\.com|tenor\.com|mail\.google\.com\/mail\/|googleusercontent\.com|outlook\.(live|office)\.com|icloud\.com|icloud-content\.com)/.test(u);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Gerçek (görünür) Chromium'un kullanıcı-aracısı: görünmez modda "HeadlessChrome" yerine bu gönderilir. Bir kez hesaplanır. */
let cachedUA: string | undefined;
async function realUserAgent(chromium: (typeof import('playwright'))['chromium']): Promise<string | undefined> {
  if (cachedUA) return cachedUA;
  try {
    const b = await chromium.launch({ headless: true, channel: process.env.KAVSAK_CHROMIUM ? undefined : 'chromium', executablePath: process.env.KAVSAK_CHROMIUM || undefined });
    const p = await b.newPage();
    const ua = await p.evaluate(() => navigator.userAgent);
    await b.close();
    cachedUA = ua.replace(/HeadlessChrome/g, 'Chrome');
  } catch {
    cachedUA = undefined;
  }
  return cachedUA;
}

/** Söz belirli sürede çözülmezse hata ver (Playwright çağrıları bazen sonsuza dek bekleyebiliyor). */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: ${Math.round(ms / 1000)} sn içinde yanıt gelmedi`)), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Basit, kararlı bir metin özeti — DOM'dan okunan mesajlara kimlik üretmek için. */
export function hashId(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
