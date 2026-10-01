import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Account, Platform } from './model.js';
import type { Store } from './store.js';
import { bus } from './bus.js';
import { sessionDir } from './config.js';
import type { Connector } from './connectors/base.js';
import { WhatsAppConnector } from './connectors/whatsapp.js';
import { TelegramConnector } from './connectors/telegram.js';
import { SlackConnector, parseSlackToken } from './connectors/slack.js';
import { DemoConnector } from './connectors/demo.js';
import { NotesConnector } from './connectors/notes.js';
import { IMessageConnector } from './connectors/imessage.js';
import { BrowserConnector } from './connectors/browser/bridge.js';
import { linkedin } from './connectors/browser/linkedin.js';
import { instagram } from './connectors/browser/instagram.js';
import { x } from './connectors/browser/x.js';
import { messenger } from './connectors/browser/messenger.js';
import { tiktok } from './connectors/browser/tiktok.js';
import { gmail } from './connectors/browser/gmail.js';
import { outlook } from './connectors/browser/outlook.js';
import { icloud } from './connectors/browser/icloud.js';
import { yahoo } from './connectors/browser/yahoo.js';
import { yandex } from './connectors/browser/yandex.js';
import { slackStrategy } from './connectors/browser/slack.js';
import { MailConnector, type MailConfig } from './connectors/mail.js';
import { ShopierConnector } from './connectors/shopier.js';
import { TrendyolConnector } from './connectors/trendyol.js';
import { HepsiburadaConnector } from './connectors/hepsiburada.js';
import { EtsyConnector } from './connectors/etsy.js';
import { ShopifyConnector } from './connectors/shopify.js';
import { N11Connector } from './connectors/n11.js';
import { PttAvmConnector } from './connectors/pttavm.js';
import { AmazonConnector } from './connectors/amazon.js';
import { MAIL_PLATFORMS } from './model.js';
import { bootOrder, bootSlots, type BootInfo } from './boot-plan.js';
import { MautrixConnector, MAUTRIX_NET } from './connectors/mautrix/connector.js';
import { ensureBinary, sidecar } from './connectors/mautrix/sidecar.js';

/** Hesap ↔ connector eşlemesi. Açılışta kayıtlı hesapları kaldırır, yenilerini oluşturur. */
/** Asılı kalan stop()/logout() HTTP isteğini sonsuza dek bekletmesin */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('zaman aşımı')), ms).unref?.())]);
}

export class Registry {
  private connectors = new Map<string, Connector>();
  /** Hesap başına sıralı yaşam döngüsü (restart/add/remove): eşzamanlı iki "Yeniden bağlan" iki connector başlatmasın */
  private locks = new Map<string, Promise<unknown>>();

  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  /**
   * Kendiliğinden iyileşme (29.09, Kaan: "ufacık bağlantı sorununda uyarı çıkmasın; Yeniden bağlan deyince giriş yapmadan bağlanıyor —
   * önce arka planda birkaç kez dene"). Geçici görünen düşüşte (ağ/zaman aşımı/tarayıcı çöktü/açılışta oturum geç göründü) hesap
   * penceresiz (etkileşimsiz) yeniden başlatılır: 15 sn, 45 sn, 2 dk (±%20). Bu sürede `autoRetry` → arayüz uyarı göstermez. Üç deneme
   * de tutmazsa uyarı çıkar. Şifre reddi, kısıtlama, captcha/güvenlik doğrulaması, QR/PIN bekleyen eşleşme, kullanıcı iptali denenmez
   * (tekrarlı deneme hesabı kilitleyebilir ya da kullanıcı eylemi gerekir).
   */
  private heal = new Map<string, { tries: number; timer?: NodeJS.Timeout; conn?: Connector; visible?: boolean; stable?: NodeJS.Timeout }>();
  private halted = false;
  private static HEAL_DELAYS = [15_000, 45_000, 120_000];
  /** Sayaç ancak hesap bu kadar süre kesintisiz 'connected' kalırsa sıfırlanır (doğrulamadan 'connected' deyip hemen düşen açılış sonsuz döngü kurmasın) */
  private static HEAL_STABLE_MS = 120_000;

  private transient(a: Account): boolean {
    const d = (a.detail ?? '').replace(/\s+/g, ' ');
    const hard =
      /reddedildi|şifre|parola|kimlik doğrulama|yetkisiz|unauthori[sz]ed|invalid|authenticationfailed|login failed|auth(entication)? failed|\b40[1-6]\b|api anahtar|girilmedi|yalnızca macos|bulunamadı|tam disk|playwright paketi|kısıtlan|başka bir yerde|giriş yapılmadı|iptal|doğrulanamadı|captcha|güvenlik doğrulaması|lisans/i;
    if (a.status === 'error') return !hard.test(d);
    if (a.status === 'disconnected') return !!d && !hard.test(d);
    // açılışta ya da yoklamada "giriş gerekli / oturum düştü" (sayfa geç çizildi, ağ koptu): yalnız tarayıcı kanallarında, penceresiz yeniden denetim
    if (a.status === 'pairing') return /giriş gerekli|oturum düştü/i.test(d) && this.connectors.get(a.id) instanceof BrowserConnector;
    return false;
  }

  private onStatusForHeal(a: Account): void {
    const h = this.heal.get(a.id);
    if (a.status === 'connected') {
      if (h) {
        // bekleyen deneme gereksiz; ama sayaç HEMEN silinmez: sayfasız açılış oturumu doğrulamadan 'connected' yayınlayıp ilk
        // yoklamada yeniden düşebiliyor → sayaç her seferinde 1/3'e dönüp sonsuz Chromium döngüsü + hiç çıkmayan uyarı.
        // Kesintisiz ≈2 dk bağlı kalırsa sıfırlanır; bu sürede düşerse kaldığı yerden devam eder.
        clearTimeout(h.timer);
        h.timer = undefined;
        if (!h.stable) {
          h.stable = setTimeout(() => {
            h.stable = undefined;
            if (this.heal.get(a.id) === h && this.store.getAccount(a.id)?.status === 'connected') this.heal.delete(a.id);
          }, Registry.HEAL_STABLE_MS);
          h.stable.unref?.();
        }
      }
      return;
    }
    // bağlı kalma süresi kesildi: sayaç korunur
    if (h?.stable) {
      clearTimeout(h.stable);
      h.stable = undefined;
    }
    if (a.status === 'connecting') {
      if (h) a.autoRetry = true; // deneme sürüyor
      return;
    }
    const c = this.connectors.get(a.id);
    if (this.halted || !c || this.store.isRemoving(a.id) || !this.transient(a)) {
      // ayrıntısız 'disconnected' = deneme sırasında eski connector'ın durması; sayaç SİLİNMEZ (silinince her deneme 1/3 sayılıp
      // sonsuz döngüye giriyordu — duman testinde Instagram 15 sn'de bir yeniden açılıyordu)
      if (h && !h.timer && !(a.status === 'disconnected' && !a.detail)) this.heal.delete(a.id);
      return;
    }
    const st = h ?? { tries: 0 };
    if (st.timer) {
      if (!st.visible) a.autoRetry = true;
      return;
    }
    if (st.tries >= Registry.HEAL_DELAYS.length) {
      // denemeler bitti: uyarı çıksın (sonraki başarılı bağlanmada sayaç sıfırlanır)
      return;
    }
    // sağlayıcı açıkça "bekle" dediyse (e-posta [LIMIT]/çok bağlantı → 15 dk, connector `retryAfterMs` ile bildirir) o süreden önce yeni
    // oturum açılmaz: yeni connector bekleme bilgisini taşımıyor, 15 sn sonra yeniden LOGIN kilitlenme riskini artırıyordu
    const hint = Math.max(0, Number((c as { retryAfterMs?: number }).retryAfterMs) || 0);
    const delay = Math.max(Registry.HEAL_DELAYS[st.tries] * (0.8 + Math.random() * 0.4), hint * (1 + Math.random() * 0.2));
    st.tries++;
    st.conn = c;
    // uzun bekleme (>2 dk) sessiz geçmesin: uyarı görünür kalır, deneme yine arka planda yapılır
    st.visible = hint > 120_000;
    st.timer = setTimeout(() => void this.healNow(a.id, st), delay);
    st.timer.unref?.();
    this.heal.set(a.id, st);
    if (!st.visible) a.autoRetry = true; // bu olay (arayüze giden kopya) uyarısız gösterilsin
    bus.log('info', `${a.platform}: ${st.visible ? 'sağlayıcı sınırı' : 'geçici sorun'} (${(a.detail ?? a.status).slice(0, 80)}); ${delay >= 120_000 ? `${Math.round(delay / 60_000)} dk` : `${Math.round(delay / 1000)} sn`} sonra arka planda yeniden denenecek (${st.tries}/${Registry.HEAL_DELAYS.length})`);
  }

  private healNow(id: string, st: { tries: number; timer?: NodeJS.Timeout; conn?: Connector; visible?: boolean; stable?: NodeJS.Timeout }): Promise<void> {
    return this.serial(id, async () => {
      st.timer = undefined;
      const a = this.store.getAccount(id);
      const c = this.connectors.get(id);
      // bu arada kullanıcı yeniden bağladı / kaldırdı / düzeldi: dokunma
      if (!a || this.halted || c !== st.conn || a.status === 'connected' || a.status === 'connecting') return;
      if (!this.transient(a)) return;
      this.connectors.delete(id);
      if (c) await withTimeout(c.stop(), 15_000).catch(() => undefined);
      const last = st.tries >= Registry.HEAL_DELAYS.length;
      // tarayıcı kanalı açılış yuvası beklerken eski connector'ın ayrıntısız 'disconnected'ı uyarı gibi görünmesin
      if (isBrowserAccount(a)) this.markStarting(a);
      await this.spawn(a, false);
      // son deneme de düşerse onStatusForHeal yeni zamanlayıcı kurmaz → uyarı görünür; kurulmuşsa bir sonraki denemeyi bekler
      if (last) bus.log('info', `${a.platform}: son otomatik yeniden deneme başlatıldı`);
    }).catch((e) => bus.log('warn', `${id} otomatik yeniden deneme: ${(e as Error).message}`));
  }

  /** Bu oturumda "Bağlan" ile açılmış ve henüz hiç bağlanmamış hesaplar: giriş iptal edilince tamamen kaldırılır */
  private fresh = new Set<string>();

  constructor(private store: Store) {
    bus.on((ev) => {
      if (ev.type === 'account.status') this.onStatusForHeal(ev.account);
      // tarayıcı girişli e-posta hesabı bağlanınca önceki denemelerden kalan boş kopyaları temizle
      if (ev.type === 'account.status' && ev.account.status === 'connected') {
        this.fresh.delete(ev.account.id);
        void this.pruneStaleLogins(ev.account);
      }
      // giriş penceresi girişsiz kapatıldı: yeni hesap iz bırakmasın (Bağlan kartı ilk haline döner)
      if (ev.type === 'account.login-cancelled' && this.fresh.has(ev.accountId)) void this.cancelLogin(ev.accountId).catch(() => undefined);
    });
  }

  /**
   * Bağlanmayı iptal et (QR/giriş penceresi kapatıldı, arayüzde Bağlan penceresi kapandı): hiç bağlanmamış yeni hesap tamamen
   * kaldırılır ('removed' + account.removed olayı), var olan hesabın bağlanma denemesi durdurulur ('stopped'). Bağlıysa dokunulmaz.
   */
  cancelLogin(id: string): Promise<'removed' | 'stopped' | 'none'> {
    this.stopHeal(id);
    return this.serial(id, async () => {
      const a = this.store.getAccount(id);
      if (!a || a.status === 'connected') return 'none';
      if (this.fresh.has(id)) {
        this.fresh.delete(id);
        await this.removeNow(id);
        return 'removed';
      }
      const c = this.connectors.get(id);
      if (c) {
        this.connectors.delete(id);
        await withTimeout(c.stop(), 15_000).catch(() => undefined);
      }
      const cur = this.store.getAccount(id) ?? a;
      const next: Account = { ...cur, status: 'disconnected', detail: 'Bağlanma iptal edildi — bağlanmak için Yeniden bağlan' };
      this.store.upsertAccount(next);
      bus.emit({ type: 'account.status', account: next });
      return 'stopped';
    });
  }

  /** Aynı platformda token'sız (tarayıcı girişli), hiç bağlanamamış ve sohbeti olmayan e-posta hesapları: yarım kalmış
   *  "Bağlan" denemelerinin kopyaları. Kartta bağlı hesabın yerine "Bağlı değil" gösteriyorlardı. */
  private async pruneStaleLogins(acc: Account): Promise<void> {
    if (!MAIL_PLATFORMS.includes(acc.platform) || readToken(acc.id) !== undefined) return;
    const stale = this.list().filter(
      (o) => o.id !== acc.id && o.platform === acc.platform && o.status !== 'connected' && readToken(o.id) === undefined && this.store.listChatsOf(o.id).length === 0,
    );
    for (const o of stale) {
      bus.log('info', `${o.id}: yarım kalmış giriş denemesi kaldırıldı (${acc.id} bağlandı)`);
      await this.remove(o.id).catch(() => undefined);
    }
  }

  list(): Account[] {
    // attention kalıcı değil: çalışan connector'dan eklenir; autoRetry arka plan denemesi sürerken
    return this.store.listAccounts().map((a) => {
      const att = (this.connectors.get(a.id) as { attention?: string } | undefined)?.attention;
      const h = this.heal.get(a.id);
      const retry = a.status !== 'connected' && !!h?.timer && !h.visible;
      return att || retry ? { ...a, ...(att ? { attention: att } : {}), ...(retry ? { autoRetry: true } : {}) } : a;
    });
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  async bootAll(): Promise<void> {
    this.halted = false;
    // yarıda kalmış kaldırmalar: bu hesaplar başlatılmaz, verisi silinir
    const purging = new Set(this.store.pendingPurges());
    if (purging.size) this.resumePurges();
    // sıra: hafif kanallar hemen, tarayıcı kanalları puana göre (boot-plan.ts); köprü açılış yuvaları bu sırayla dolar
    const act = this.store.accountActivity();
    const infos: BootInfo[] = this.store
      .listAccounts()
      .filter((a) => !purging.has(a.id) && a.platform !== 'demo')
      .map((a) => ({
        account: a,
        browser: isBrowserAccount(a),
        unread: act.get(a.id)?.unread ?? 0,
        lastAt: act.get(a.id)?.lastAt ?? 0,
        estMs: Number(this.store.meta(`boot_ms:${a.id}`)) || undefined,
      }));
    const order = bootOrder(infos);
    const heavy = order.filter((b) => b.browser);
    if (heavy.length) bus.log('info', `Açılış sırası (tarayıcı kanalları, aynı anda ${bootSlots()}): ${heavy.map((b) => `${b.account.platform}${b.unread ? `(${b.unread} okunmamış)` : ''}`).join(' → ')}`);
    const slots = bootSlots();
    for (const b of order) {
      const a = b.account;
      try {
        // sıradaki tarayıcı kanalı yuva beklerken son kapanıştan kalan 'disconnected' (kırmızı uyarı) ya da çökme sonrası kalan
        // 'connected' (sahte yeşil) görünmesin
        if (b.browser) this.markStarting(a, heavy.indexOf(b) >= slots ? 'Açılış sırası bekleniyor' : undefined);
        await this.spawn(a, false);
      } catch (e) {
        bus.log('error', `${a.platform} başlatılamadı: ${(e as Error).message}`);
      }
    }
  }

  /** Başlatılacak hesabı 'connecting' göster (yuva sırasında durum yazılmıyordu); QR/PIN bekleyen 'pairing'e dokunulmaz */
  private markStarting(a: Account, detail?: string): void {
    const cur = this.store.getAccount(a.id) ?? a;
    if (cur.status === 'pairing' || (cur.status === 'connecting' && cur.detail === detail)) return;
    const next: Account = { ...cur, status: 'connecting', detail };
    this.store.upsertAccount(next);
    bus.emit({ type: 'account.status', account: next });
  }

  add(platform: Platform, opts: { token?: string; label?: string } = {}): Promise<Account> {
    // aynı platforma eşzamanlı iki "Bağlan": ikincisi birincinin açtığı hesabı görsün (kopya hesap açılmasın)
    return this.serial(`add:${platform}`, () => this.addNow(platform, opts));
  }

  private async addNow(platform: Platform, opts: { token?: string; label?: string }): Promise<Account> {
    // Tek hesaplı platformlar: ikinci kez "Bağlan" denirse kopya hesap açma, var olanı yeniden başlat
    const SINGLE: Platform[] = ['whatsapp', 'telegram', 'slack', 'imessage', 'linkedin', 'x', 'instagram', 'messenger', 'tiktok', 'shopier', 'trendyol', 'hepsiburada', 'etsy', 'shopify', 'n11', 'amazon', 'pttavm', 'mivelo'];
    const existing = SINGLE.includes(platform) ? this.list().find((a) => a.platform === platform) : undefined;
    if (existing) {
      if (opts.token) fs.writeFileSync(path.join(sessionDir(existing.id), 'token'), opts.token, { mode: 0o600 });
      await this.restart(existing.id);
      return existing;
    }
    // Yahoo tarayıcı girişi (token'sız): IMAP'i reddedilen var olan Yahoo hesabı kopya açılmadan tarayıcı yoluna geçirilir
    if ((platform === 'yahoo' || platform === 'yandex') && !opts.token) {
      const imapOnes = this.list().filter((a) => a.platform === platform && readToken(a.id) !== undefined);
      const broken = imapOnes.find((a) => a.status === 'error' || a.status === 'disconnected') ?? (imapOnes.length === 1 ? imapOnes[0] : undefined);
      if (broken) {
        fs.rmSync(path.join(sessionDir(broken.id), 'token'), { force: true });
        bus.log('info', `${broken.id}: uygulama şifresi yolu bırakıldı, Yahoo tarayıcı girişine geçiliyor`);
        await this.restart(broken.id);
        return broken;
      }
    }
    // E-posta tarayıcı girişi (token'sız) yeniden denendi: bağlanamamış token'sız hesap varsa onu yeniden başlat, kopya açma
    if (MAIL_PLATFORMS.includes(platform) && !opts.token) {
      const pending = this.list().find((a) => a.platform === platform && a.status !== 'connected' && readToken(a.id) === undefined);
      if (pending) {
        await this.restart(pending.id);
        return pending;
      }
    }
    // E-posta: aynı adres yeniden bağlanınca kopya hesap açma → var olan hesabın bilgilerini güncelle (ör. yenilenen uygulama şifresi)
    // ve yeniden başlat. Yeni formda verilmeyen alanlar (elle girilmiş sunucu vb.) eskisinden korunur.
    if (MAIL_PLATFORMS.includes(platform) && opts.token) {
      const next = parseJson(opts.token);
      const user = String(next.user ?? '').trim().toLowerCase();
      const same = user
        ? this.list().find((a) => a.platform === platform && String(parseJson(readToken(a.id)).user ?? a.label ?? '').trim().toLowerCase() === user)
        : undefined;
      if (same) {
        const merged = { ...parseJson(readToken(same.id)) };
        for (const [k, v] of Object.entries(next)) if (v !== undefined && v !== null && v !== '') merged[k] = v;
        fs.writeFileSync(path.join(sessionDir(same.id), 'token'), JSON.stringify(merged), { mode: 0o600 });
        bus.log('info', `${same.id}: giriş bilgileri güncellendi, yeniden bağlanılıyor`);
        await this.restart(same.id);
        return same;
      }
    }
    const account: Account = {
      id: `${platform}:${randomBytes(4).toString('hex')}`,
      platform,
      label: opts.label ?? (MAIL_PLATFORMS.includes(platform) && opts.token ? safeUser(opts.token) : platform),
      status: 'disconnected',
      createdAt: Date.now(),
    };
    this.store.upsertAccount(account);
    if (opts.token) fs.writeFileSync(path.join(sessionDir(account.id), 'token'), opts.token, { mode: 0o600 });
    this.fresh.add(account.id);
    try {
      await this.spawn(account);
    } catch (e) {
      // connector kurulamadıysa hayalet hesap kalmasın
      this.store.deleteAccount(account.id);
      fs.rmSync(sessionDir(account.id), { recursive: true, force: true });
      throw e;
    }
    return account;
  }

  /**
   * Kaldır: hesap HEMEN listeden kalkar ve yanıt döner; platform çıkışı (WhatsApp telefondan düşürme), connector durdurma,
   * mesajların silinmesi ve oturum klasörü arka planda (29.09, Kaan: "Kaldır ya çalışmıyor ya çok yavaş" — çıkış + durdurma
   * 30 sn'ye, büyük hesapta tek işlemde mesaj/FTS silme saniyelere varıyordu). Arka plan işi hesap kilidinde sürer: aynı
   * hesaba sonraki işlem (yeniden ekleme vb.) temizlik bitince çalışır.
   */
  remove(id: string): Promise<void> {
    if (!this.store.getAccount(id) && !this.connectors.has(id)) return Promise.reject(new Error('Hesap yok'));
    this.fresh.delete(id);
    this.stopHeal(id);
    const c = this.connectors.get(id);
    this.connectors.delete(id);
    const purge = this.store.purgeAccount(id);
    bus.emit({ type: 'account.removed', accountId: id });
    const job = this.serial(id, async () => {
      if (c) {
        await withTimeout(c.logout?.() ?? Promise.resolve(), 15_000).catch((e) => bus.log('warn', `${id} platform çıkışı yapılamadı: ${(e as Error).message}`));
        await withTimeout(c.stop(), 15_000).catch(() => undefined);
      }
      await purge.catch((e) => bus.log('warn', `${id} verisi silinemedi: ${(e as Error).message}`));
      await fs.promises.rm(sessionDir(id), { recursive: true, force: true }).catch(() => undefined);
      bus.log('info', `Hesap kaldırıldı: ${id}`);
    });
    this.removals.set(id, job);
    void job.finally(() => this.removals.get(id) === job && this.removals.delete(id));
    return Promise.resolve();
  }
  private removals = new Map<string, Promise<void>>();

  /**
   * "Tüm verileri sil" (Ayarlar → Hesap): hesaplar HEMEN gizlenir, platform çıkışları (WhatsApp bağlı cihazlar, Telegram
   * oturumu…) ve durdurmalar AYNI ANDA yapılır (hesap başına çıkış ≤6 sn, durdurma ≤5 sn). Veri silme hesap hesap değil,
   * çağıran tarafın `store.wipeAll`'ıyla tek seferde (01.10, Kaan: sırayla çıkış + dilimli silme dakikalar sürüyordu).
   * Süren tekil kaldırmalar beklenir.
   */
  async removeAll(): Promise<number> {
    const ids = [...new Set([...this.store.listAccounts().map((a) => a.id), ...this.connectors.keys()])];
    this.store.hideAccounts(ids);
    const conns = ids.map((id) => {
      this.fresh.delete(id);
      this.stopHeal(id);
      const c = this.connectors.get(id);
      this.connectors.delete(id);
      bus.emit({ type: 'account.removed', accountId: id });
      return [id, c] as const;
    });
    await Promise.all(
      conns.map(async ([id, c]) => {
        if (!c) return;
        await withTimeout(c.logout?.() ?? Promise.resolve(), 6_000).catch((e) => bus.log('warn', `${id} platform çıkışı yapılamadı: ${(e as Error).message}`));
        await withTimeout(c.stop(), 5_000).catch(() => undefined);
      }),
    );
    await Promise.all([...this.removals.values()].map((j) => j.catch(() => undefined)));
    return ids.length;
  }

  /** Çekirdek kaldırma sürerken kapandıysa: açılışta kalan veriyi sil */
  resumePurges(): void {
    for (const id of this.store.pendingPurges()) {
      void this.serial(id, async () => {
        await this.store.purgeAccount(id).catch(() => undefined);
        await fs.promises.rm(sessionDir(id), { recursive: true, force: true }).catch(() => undefined);
        bus.log('info', `Yarıda kalan hesap kaldırma tamamlandı: ${id}`);
      });
    }
  }

  private async removeNow(id: string): Promise<void> {
    await this.remove(id);
  }

  /**
   * opts.browserLogin: e-posta sağlayıcısının kendi giriş penceresiyle yeniden bağlan — uygulama şifresiyle (eski IMAP yolu, token
   * dosyası) bağlanmış hesap da token'ı bırakıp tarayıcı girişine geçer (arayüzde artık şifre formu yok; Kaan 29.09).
   */
  restart(id: string, opts: { external?: boolean; browserLogin?: boolean } = {}): Promise<void> {
    return this.serial(id, () => this.restartNow(id, opts));
  }

  private stopHeal(id: string): void {
    const h = this.heal.get(id);
    if (h) {
      clearTimeout(h.timer);
      clearTimeout(h.stable);
    }
    this.heal.delete(id);
  }

  private async restartNow(id: string, opts: { external?: boolean; browserLogin?: boolean } = {}): Promise<void> {
    this.stopHeal(id);
    const a = this.store.getAccount(id);
    if (!a) throw new Error('Hesap yok');
    const c = this.connectors.get(id);
    // e-posta: uygulama şifreli (token) hesap sağlayıcının giriş penceresine geçer; çerezsiz profilde pencere hemen açılır
    let toBrowser = false;
    if (opts.browserLogin && MAIL_BROWSER_LOGIN.includes(a.platform) && readToken(id) !== undefined) {
      fs.rmSync(path.join(sessionDir(id), 'token'), { force: true });
      bus.log('info', `${id}: uygulama şifresi yolu bırakıldı, ${a.platform} giriş penceresine geçiliyor`);
      toBrowser = true;
    }
    // PIN gibi kullanıcı eylemi bekleniyorsa yeni bağlantı pencereyi doğrudan açar (görünmez denetim turu yok)
    const window = !!(c as { attention?: string } | undefined)?.attention;
    // 'pairing' = giriş gerektiği biliniyor: görünmez denetim turu (10-20 sn) boşuna → giriş penceresi hemen açılır
    const login = !window && (a.status === 'pairing' || toBrowser);
    if (c) {
      this.connectors.delete(id);
      await withTimeout(c.stop(), 15_000).catch(() => undefined);
    }
    await this.spawn(a, true, window, !!opts.external, login);
  }

  /** Bir düzeltmeden sonra hesabın sohbetlerini bir kez silip yeniden eşitlet (işaret dosyası hesabın oturum klasöründe) */
  private resyncOnce(account: Account, mark: string, why: string): void {
    const file = path.join(sessionDir(account.id), mark);
    if (fs.existsSync(file)) return;
    const n = this.store.dropAccountChats(account.id);
    if (n) bus.log('info', `${account.platform}: ${why}; ${n} sohbet yeniden eşitlenecek`);
    fs.writeFileSync(file, '');
  }

  private async spawn(account: Account, interactive = true, window = false, external = false, login = false): Promise<void> {
    let c: Connector | undefined;
    // Beeper (mautrix) köprüleri: WhatsApp, Instagram, Messenger, X, LinkedIn, Slack — ikili yoksa eski bağlayıcılar
    if (mautrixWanted(account)) {
      const bin = await ensureBinary();
      if (bin) c = new MautrixConnector(account, this.store);
      else bus.log('warn', `${account.platform}: köprü bileşeni yok, eski bağlayıcı kullanılıyor`);
    }
    if (!c) switch (account.platform) {
      case 'whatsapp':
        c = new WhatsAppConnector(account, this.store);
        break;
      case 'telegram':
        c = new TelegramConnector(account, this.store);
        break;
      case 'slack': {
        // xoxp token verildiyse resmi API; yoksa tarayıcı oturumu (app.slack.com girişi)
        const tokenFile = path.join(sessionDir(account.id), 'token');
        // belirteç dosyası: düz xoxp (eski) ya da {token, appToken} (Bağlan → Slack uygulaması; appToken varsa Socket Mode)
        const tok = fs.existsSync(tokenFile) ? parseSlackToken(fs.readFileSync(tokenFile, 'utf8')) : undefined;
        c = tok ? new SlackConnector(account, this.store, tok.token, tok.appToken) : new BrowserConnector(account, this.store, slackStrategy, 30_000, { keepOpen: 'whileActive', rtSlowdown: 3, backfillMs: 8_000 }); // Mivelo öndeyken web istemcisi açık + kendi soketi dinlenir (anlık), boşta sayfasız 30 sn
        break;
      }
      case 'demo':
        c = new DemoConnector(account, this.store);
        break;
      case 'mivelo':
        c = new NotesConnector(account, this.store);
        break;
      case 'imessage':
        c = new IMessageConnector(account, this.store);
        break;
      // Resmi olmayan kanallarda yoklama aralıkları ban riskine göre (±%30 sapmayla, bridge.schedule): LinkedIn/X seyrek
      case 'linkedin':
        c = new BrowserConnector(account, this.store, linkedin, 60_000, { rtSlowdown: 5, backfillMs: 25_000 }); // anlık akış canlıyken yedek 5 dk
        break;
      case 'instagram':
        c = new BrowserConnector(account, this.store, instagram, 30_000, { idlePollMs: 120_000, keepOpen: 'always', rtSlowdown: 10, softReloadHours: [12, 20], backfillMs: 8_000 }); // sayfa açık + soket dinleme; soket yoksa odakta 30 sn / boşta 2 dk, canlıyken yedek 5 dk
        break;
      case 'x':
        c = new BrowserConnector(account, this.store, x, 60_000, { rtSlowdown: 3, backfillMs: 20_000 }); // soket canlıyken yedek 3 dk
        break;
      case 'messenger':
        c = new BrowserConnector(account, this.store, messenger, 30_000, { rtSlowdown: 5, backfillMs: 10_000 }); // soket/liste canlıyken yedek 2,5 dk
        break;
      case 'tiktok':
        // DOM okuyan deneysel yol; TikTok otomasyona sert (captcha): LinkedIn/X gibi seyrek, soket/liste canlıyken yedek 3 dk
        c = new BrowserConnector(account, this.store, tiktok, 60_000, { rtSlowdown: 3, backfillMs: 20_000 });
        break;
      case 'shopier': {
        const tokenFile = path.join(sessionDir(account.id), 'token');
        const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
        c = new ShopierConnector(account, this.store, token);
        break;
      }
      // Pazar yerleri: token dosyası JSON yapılandırma (Bağlan formundan); yalnız resmi API (tarayıcı köprüsü yok)
      case 'trendyol':
      case 'hepsiburada':
      case 'etsy':
      case 'shopify':
      case 'n11':
      case 'pttavm':
      case 'amazon': {
        const tokenFile = path.join(sessionDir(account.id), 'token');
        const cfg = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
        c =
          account.platform === 'trendyol'
            ? new TrendyolConnector(account, this.store, cfg)
            : account.platform === 'hepsiburada'
              ? new HepsiburadaConnector(account, this.store, cfg)
              : account.platform === 'etsy'
                ? new EtsyConnector(account, this.store, cfg)
                : account.platform === 'n11'
                  ? new N11Connector(account, this.store, cfg)
                  : account.platform === 'pttavm'
                    ? new PttAvmConnector(account, this.store, cfg)
                  : account.platform === 'amazon'
                    ? new AmazonConnector(account, this.store, cfg)
                    : new ShopifyConnector(account, this.store, cfg);
        break;
      }
      case 'gmail': {
        // Gmail: varsayılan tarayıcı girişi (uygulama şifresi/OAuth istemcisi gerekmez); IMAP yapılandırması (token) verildiyse eski yol
        const tokenFile = path.join(sessionDir(account.id), 'token');
        if (!fs.existsSync(tokenFile)) {
          c = new BrowserConnector(account, this.store, gmail, 30_000, { idlePollMs: 90_000, keepOpen: 'whileActive' }); // Mivelo odaktayken açık sayfa + canlı liste izleme (30 sn yedek); boşta tarayıcı kapalı, 90 sn
          break;
        }
        let cfg: MailConfig = { user: '' };
        try {
          cfg = JSON.parse(fs.readFileSync(tokenFile, 'utf8')) as MailConfig;
        } catch {
          /* yapılandırma yok */
        }
        c = new MailConnector(account, this.store, cfg);
        break;
      }
      case 'outlook':
      case 'icloud': {
        // Outlook.com / iCloud Mail: varsayılan tarayıcı girişi; IMAP yapılandırması (token) verildiyse eski yol
        const tokenFile = path.join(sessionDir(account.id), 'token');
        if (account.platform === 'icloud' && !fs.existsSync(tokenFile)) this.resyncOnce(account, 'ts-v1', 'e-posta saatleri düzeltildi');
        if (!fs.existsSync(tokenFile)) {
          // Outlook: IMAP yolu yok (Microsoft şifreli IMAP'i kapattı) → sayfa sürekli açık, canlı liste izlenir (~3-5 sn; ~200-300 MB).
          // iCloud tarayıcı yolu Gmail gibi: odaktayken açık. (Uygulamaya özel şifreyle IMAP önerilen yol.)
          c =
            account.platform === 'outlook'
              ? new BrowserConnector(account, this.store, outlook, 90_000, { keepOpen: 'always' })
              : new BrowserConnector(account, this.store, icloud, 30_000, { idlePollMs: 90_000, keepOpen: 'whileActive' });
          break;
        }
        let cfg: MailConfig = { user: '' };
        try {
          cfg = JSON.parse(fs.readFileSync(tokenFile, 'utf8')) as MailConfig;
        } catch {
          /* yapılandırma yok */
        }
        c = new MailConnector(account, this.store, cfg);
        break;
      }
      case 'yahoo':
      case 'yandex':
      case 'imap': {
        const tokenFile = path.join(sessionDir(account.id), 'token');
        if (account.platform !== 'imap' && !fs.existsSync(tokenFile)) this.resyncOnce(account, 'ts-v1', 'e-posta saatleri düzeltildi');
        // Yahoo: uygulama şifresi (token) yoksa tarayıcı girişi — Yahoo birçok hesapta uygulama şifresini kapattı, IMAP normal şifreyi reddediyor
        if (account.platform === 'yahoo' && !fs.existsSync(tokenFile)) {
          c = new BrowserConnector(account, this.store, yahoo, 30_000, { idlePollMs: 90_000, keepOpen: 'whileActive' });
          break;
        }
        // Yandex: aynı şekilde token'sız hesap = tarayıcı girişi (normal şifre + Yandex doğrulaması; uygulama şifresi gerekmez)
        if (account.platform === 'yandex' && !fs.existsSync(tokenFile)) {
          // iki haneli yıllı liste tarihleri (28.04.25) okunamıyordu → eski e-postalar eşitleme saatinde görünüyordu; bir kez yeniden eşitle
          this.resyncOnce(account, 'ts-v2', 'Yandex e-posta tarihleri düzeltildi');
          // ilk sürümün seçicileri satır parçalarını ayrı ileti sayıyordu → boş "(konu yok)" sohbetleri; bir kez temizle
          const mark = path.join(sessionDir(account.id), 'prune-v1');
          if (!fs.existsSync(mark)) {
            const n = this.store.dropChatsNamed(account.id, '(konu yok)');
            if (n) bus.log('info', `Yandex Mail: ${n} hatalı boş sohbet temizlendi`);
            fs.writeFileSync(mark, '');
          }
          c = new BrowserConnector(account, this.store, yandex, 30_000, { idlePollMs: 90_000, keepOpen: 'whileActive' });
          break;
        }
        let cfg: MailConfig = { user: '' };
        try {
          cfg = JSON.parse(fs.readFileSync(tokenFile, 'utf8')) as MailConfig;
        } catch {
          /* yapılandırma yok */
        }
        c = new MailConnector(account, this.store, cfg);
        break;
      }
      default:
        throw new Error(`${account.platform} için connector henüz yok`);
    }
    // aynı hesabın hâlâ çalışan bir connector'ı varsa (yarış/yeniden deneme) önce durdur: aynı oturumla iki bağlantı olmasın
    const old = this.connectors.get(account.id);
    if (old && old !== c) {
      this.connectors.delete(account.id);
      await withTimeout(old.stop(), 15_000).catch(() => undefined);
    }
    this.connectors.set(account.id, c);
    // start() uzun sürebilir (QR bekleme vb.); arka planda çalışsın
    void c.start({ interactive, window, external, login }).catch((e) => bus.log('error', `${account.platform} hata: ${(e as Error).message}`));
  }

  async stopAll(): Promise<void> {
    this.halted = true;
    for (const id of [...this.heal.keys()]) this.stopHeal(id);
    // tek bir asılı stop() kapanışı sonsuza dek bekletmesin
    await Promise.all([...this.connectors.values()].map((c) => withTimeout(c.stop(), 10_000).catch(() => undefined)));
    // arka planda süren kaldırma/yeniden deneme işleri (kaldırılan hesabın connector'ını durdurma vb.) de bitsin: kapanışta açık bağlantı kalmasın
    await withTimeout(Promise.all([...this.locks.values()]), 20_000).catch(() => undefined);
    await withTimeout(sidecar.stop(), 15_000).catch(() => undefined);
  }
}

/** Tarayıcı girişi (sağlayıcının kendi giriş penceresi) olan e-posta platformları; token (uygulama şifresi) yalnız eski hesaplarda */
const MAIL_BROWSER_LOGIN: Platform[] = ['gmail', 'outlook', 'yahoo', 'yandex', 'icloud'];

/** Hesap Beeper (mautrix) köprüsüyle mi çalışacak: Slack'te eski belirteçli (xoxp) hesaplar resmi API bağlayıcısında kalır */
function mautrixWanted(a: Account): boolean {
  if (!MAUTRIX_NET[a.platform] || process.env.MIVELO_ENGINE === 'legacy') return false;
  if (a.platform === 'slack' && readToken(a.id) !== undefined) return false;
  return true;
}

/** Hesap tarayıcı köprüsüyle mi çalışacak (spawn'daki seçimle aynı: token dosyası yoksa tarayıcı yolu) */
function isBrowserAccount(a: Account): boolean {
  if (mautrixWanted(a)) return false;
  const hasToken = readToken(a.id) !== undefined;
  switch (a.platform) {
    case 'linkedin':
    case 'instagram':
    case 'x':
    case 'messenger':
    case 'tiktok':
      return true;
    case 'slack':
    case 'gmail':
    case 'outlook':
    case 'icloud':
    case 'yahoo':
    case 'yandex':
      return !hasToken;
    default:
      return false;
  }
}

function parseJson(t: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(t ?? '');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readToken(id: string): string | undefined {
  try {
    return fs.readFileSync(path.join(sessionDir(id), 'token'), 'utf8');
  } catch {
    return undefined;
  }
}

function safeUser(token: string): string {
  try {
    return (JSON.parse(token) as { user?: string }).user || 'e-posta';
  } catch {
    return 'e-posta';
  }
}
