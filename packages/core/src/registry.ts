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
import { SlackConnector } from './connectors/slack.js';
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

  constructor(private store: Store) {}

  list(): Account[] {
    return this.store.listAccounts();
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

  async add(platform: Platform, opts: { token?: string; label?: string } = {}): Promise<Account> {
    // Tek hesaplı platformlar: ikinci kez "Bağlan" denirse kopya hesap açma, var olanı yeniden başlat
    const SINGLE: Platform[] = ['whatsapp', 'telegram', 'slack', 'imessage', 'linkedin', 'x', 'instagram', 'messenger', 'shopier', 'trendyol', 'hepsiburada', 'etsy', 'shopify', 'n11', 'amazon'];
    const existing = SINGLE.includes(platform) ? this.list().find((a) => a.platform === platform) : undefined;
    if (existing) {
      if (opts.token) fs.writeFileSync(path.join(sessionDir(existing.id), 'token'), opts.token, { mode: 0o600 });
      await this.restart(existing.id);
      return existing;
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

  async remove(id: string): Promise<void> {
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

  async restart(id: string): Promise<void> {
    const a = this.store.getAccount(id);
    if (!a) throw new Error('Hesap yok');
    const c = this.connectors.get(id);
    if (c) await withTimeout(c.stop(), 15_000).catch(() => undefined);
    await this.spawn(a);
  }

  private async spawn(account: Account, interactive = true): Promise<void> {
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
        const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
        c = token.startsWith('xox') ? new SlackConnector(account, this.store, token) : new BrowserConnector(account, this.store, slackStrategy, 20_000);
        break;
      }
      case 'demo':
        c = new DemoConnector(account, this.store);
        break;
      case 'imessage':
        c = new IMessageConnector(account, this.store);
        break;
      case 'linkedin':
        c = new BrowserConnector(account, this.store, linkedin, 15_000);
        break;
      case 'instagram':
        c = new BrowserConnector(account, this.store, instagram, 15_000);
        break;
      case 'x':
        c = new BrowserConnector(account, this.store, x, 20_000);
        break;
      case 'messenger':
        c = new BrowserConnector(account, this.store, messenger, 20_000);
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
                ? new EtsyConnector(account, this.store, cfg)
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
          c = new BrowserConnector(account, this.store, gmail, 90_000); // boşta tarayıcı kapalı: her yoklama açılış+sayfa yükü, 90 sn
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
          c = new BrowserConnector(account, this.store, account.platform === 'outlook' ? outlook : icloud, 90_000);
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
    this.connectors.set(account.id, c);
    // start() uzun sürebilir (QR bekleme vb.); arka planda çalışsın
    void c.start({ interactive }).catch((e) => bus.log('error', `${account.platform} hata: ${(e as Error).message}`));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.connectors.values()].map((c) => c.stop().catch(() => undefined)));
  }
}

function safeUser(token: string): string {
  try {
    return (JSON.parse(token) as { user?: string }).user || 'e-posta';
  } catch {
    return 'e-posta';
  }
}
