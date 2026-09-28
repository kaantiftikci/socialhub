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
import { IMessageConnector } from './connectors/imessage.js';
import { BrowserConnector } from './connectors/browser/bridge.js';
import { linkedin } from './connectors/browser/linkedin.js';
import { instagram } from './connectors/browser/instagram.js';
import { x } from './connectors/browser/x.js';
import { messenger } from './connectors/browser/messenger.js';
import { gmail } from './connectors/browser/gmail.js';
import { outlook } from './connectors/browser/outlook.js';
import { icloud } from './connectors/browser/icloud.js';
import { slackStrategy } from './connectors/browser/slack.js';
import { MailConnector, type MailConfig } from './connectors/mail.js';
import { ShopierConnector } from './connectors/shopier.js';
import { TrendyolConnector } from './connectors/trendyol.js';
import { HepsiburadaConnector } from './connectors/hepsiburada.js';
import { EtsyConnector } from './connectors/etsy.js';
import { ShopifyConnector } from './connectors/shopify.js';
import { N11Connector } from './connectors/n11.js';
import { AmazonConnector } from './connectors/amazon.js';
import { MAIL_PLATFORMS } from './model.js';

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

  constructor(private store: Store) {}

  list(): Account[] {
    // attention kalıcı değil: çalışan connector'dan eklenir
    return this.store.listAccounts().map((a) => {
      const att = (this.connectors.get(a.id) as { attention?: string } | undefined)?.attention;
      return att ? { ...a, attention: att } : a;
    });
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  async bootAll(): Promise<void> {
    for (const a of this.store.listAccounts()) {
      if (a.platform === 'demo') continue;
      try {
        await this.spawn(a, false);
      } catch (e) {
        bus.log('error', `${a.platform} başlatılamadı: ${(e as Error).message}`);
      }
    }
  }

  add(platform: Platform, opts: { token?: string; label?: string } = {}): Promise<Account> {
    // aynı platforma eşzamanlı iki "Bağlan": ikincisi birincinin açtığı hesabı görsün (kopya hesap açılmasın)
    return this.serial(`add:${platform}`, () => this.addNow(platform, opts));
  }

  private async addNow(platform: Platform, opts: { token?: string; label?: string }): Promise<Account> {
    // Tek hesaplı platformlar: ikinci kez "Bağlan" denirse kopya hesap açma, var olanı yeniden başlat
    const SINGLE: Platform[] = ['whatsapp', 'telegram', 'slack', 'imessage', 'linkedin', 'x', 'instagram', 'messenger', 'shopier', 'trendyol', 'hepsiburada', 'etsy', 'shopify', 'n11', 'amazon'];
    const existing = SINGLE.includes(platform) ? this.list().find((a) => a.platform === platform) : undefined;
    if (existing) {
      if (opts.token) fs.writeFileSync(path.join(sessionDir(existing.id), 'token'), opts.token, { mode: 0o600 });
      await this.restart(existing.id);
      return existing;
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

  remove(id: string): Promise<void> {
    return this.serial(id, () => this.removeNow(id));
  }

  private async removeNow(id: string): Promise<void> {
    if (!this.store.getAccount(id) && !this.connectors.has(id)) throw new Error('Hesap yok');
    const c = this.connectors.get(id);
    if (c) {
      this.connectors.delete(id);
      await withTimeout(c.logout?.() ?? Promise.resolve(), 15_000).catch((e) => bus.log('warn', `${id} platform çıkışı yapılamadı: ${(e as Error).message}`));
      await withTimeout(c.stop(), 15_000).catch(() => undefined);
    }
    this.store.deleteAccount(id);
    fs.rmSync(sessionDir(id), { recursive: true, force: true });
    bus.log('info', `Hesap kaldırıldı: ${id}`);
  }

  restart(id: string): Promise<void> {
    return this.serial(id, () => this.restartNow(id));
  }

  private async restartNow(id: string): Promise<void> {
    const a = this.store.getAccount(id);
    if (!a) throw new Error('Hesap yok');
    const c = this.connectors.get(id);
    // PIN gibi kullanıcı eylemi bekleniyorsa yeni bağlantı pencereyi doğrudan açar (görünmez denetim turu yok)
    const window = !!(c as { attention?: string } | undefined)?.attention;
    if (c) {
      this.connectors.delete(id);
      await withTimeout(c.stop(), 15_000).catch(() => undefined);
    }
    await this.spawn(a, true, window);
  }

  private async spawn(account: Account, interactive = true, window = false): Promise<void> {
    let c: Connector;
    switch (account.platform) {
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
        c = tok ? new SlackConnector(account, this.store, tok.token, tok.appToken) : new BrowserConnector(account, this.store, slackStrategy, 30_000, { keepOpen: 'whileActive', rtSlowdown: 3 }); // Mivelo öndeyken web istemcisi açık + kendi soketi dinlenir (anlık), boşta sayfasız 30 sn
        break;
      }
      case 'demo':
        c = new DemoConnector(account, this.store);
        break;
      case 'imessage':
        c = new IMessageConnector(account, this.store);
        break;
      // Resmi olmayan kanallarda yoklama aralıkları ban riskine göre (±%30 sapmayla, bridge.schedule): LinkedIn/X seyrek
      case 'linkedin':
        c = new BrowserConnector(account, this.store, linkedin, 60_000, { rtSlowdown: 5 }); // anlık akış canlıyken yedek 5 dk
        break;
      case 'instagram':
        c = new BrowserConnector(account, this.store, instagram, 30_000, { idlePollMs: 120_000, keepOpen: 'always', rtSlowdown: 10, softReloadHours: [12, 20] }); // sayfa açık + soket dinleme; soket yoksa odakta 30 sn / boşta 2 dk, canlıyken yedek 5 dk
        break;
      case 'x':
        c = new BrowserConnector(account, this.store, x, 60_000, { rtSlowdown: 3 }); // soket canlıyken yedek 3 dk
        break;
      case 'messenger':
        c = new BrowserConnector(account, this.store, messenger, 30_000, { rtSlowdown: 5 }); // soket/liste canlıyken yedek 2,5 dk
        break;
      case 'shopier': {
        const tokenFile = path.join(sessionDir(account.id), 'token');
        const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
        c = new ShopierConnector(account, this.store, token);
        break;
      }
      // Pazar yerleri: token dosyası JSON yapılandırma (Bağlan formundan); siparişler API'den, mesajlar (Etsy/Shopify) köprüden
      case 'trendyol':
      case 'hepsiburada':
      case 'etsy':
      case 'shopify':
      case 'n11':
      case 'amazon': {
        const tokenFile = path.join(sessionDir(account.id), 'token');
        const cfg = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
        c =
          account.platform === 'trendyol'
            ? new TrendyolConnector(account, this.store, cfg)
            : account.platform === 'hepsiburada'
              ? new HepsiburadaConnector(account, this.store, cfg)
              : account.platform === 'etsy'
                ? // Etsy Mesajları tarayıcı köprüsü varsayılan kapalı (ban önleme); yapılandırmada messaging:true ile açılır
                  new EtsyConnector(account, this.store, cfg, (() => { try { return (JSON.parse(cfg) as { messaging?: boolean }).messaging === true; } catch { return false; } })())
                : account.platform === 'n11'
                  ? new N11Connector(account, this.store, cfg)
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
    void c.start({ interactive, window }).catch((e) => bus.log('error', `${account.platform} hata: ${(e as Error).message}`));
  }

  async stopAll(): Promise<void> {
    // tek bir asılı stop() kapanışı sonsuza dek bekletmesin
    await Promise.all([...this.connectors.values()].map((c) => withTimeout(c.stop(), 10_000).catch(() => undefined)));
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
