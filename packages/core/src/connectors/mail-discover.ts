import type { MailConfig } from './mail.js';

type Servers = Required<Pick<MailConfig, 'host' | 'port' | 'secure' | 'smtpHost' | 'smtpPort' | 'smtpSecure'>>;

/** Bilinen sağlayıcılar (alan adı → sunucular); kullanıcı yalnız e-posta + şifre girer */
const KNOWN: Array<[RegExp, Servers]> = [
  [/^(gmail|googlemail)\.com$/, { host: 'imap.gmail.com', port: 993, secure: true, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true }],
  [/^(outlook|hotmail|live|msn)\.[a-z.]+$/, { host: 'outlook.office365.com', port: 993, secure: true, smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false }],
  [/^(yahoo|ymail|rocketmail)\.[a-z.]+$/, { host: 'imap.mail.yahoo.com', port: 993, secure: true, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpSecure: true }],
  [/^(icloud|me|mac)\.com$/, { host: 'imap.mail.me.com', port: 993, secure: true, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecure: false }],
  [/^yandex\.[a-z.]+$|^ya\.ru$/, { host: 'imap.yandex.com', port: 993, secure: true, smtpHost: 'smtp.yandex.com', smtpPort: 465, smtpSecure: true }],
  [/^(gmx|gmx\.de|gmx\.net)$|^gmx\.[a-z.]+$/, { host: 'imap.gmx.com', port: 993, secure: true, smtpHost: 'mail.gmx.com', smtpPort: 465, smtpSecure: true }],
  [/^(aol)\.com$/, { host: 'imap.aol.com', port: 993, secure: true, smtpHost: 'smtp.aol.com', smtpPort: 465, smtpSecure: true }],
  [/^(zoho|zohomail)\.[a-z.]+$/, { host: 'imap.zoho.com', port: 993, secure: true, smtpHost: 'smtp.zoho.com', smtpPort: 465, smtpSecure: true }],
  [/^(fastmail)\.[a-z.]+$/, { host: 'imap.fastmail.com', port: 993, secure: true, smtpHost: 'smtp.fastmail.com', smtpPort: 465, smtpSecure: true }],
  [/^(proton\.me|protonmail\.com)$/, { host: '127.0.0.1', port: 1143, secure: false, smtpHost: '127.0.0.1', smtpPort: 1025, smtpSecure: false }],
  [/^mail\.ru$|^(inbox|list|bk)\.ru$/, { host: 'imap.mail.ru', port: 993, secure: true, smtpHost: 'smtp.mail.ru', smtpPort: 465, smtpSecure: true }],
];

/** Mozilla ISPDB / alan adının kendi autoconfig'i (Thunderbird'ün kullandığı) → IMAP + SMTP */
async function autoconfig(domain: string): Promise<Servers | undefined> {
  const urls = [`https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=info@${domain}`, `https://autoconfig.thunderbird.net/v1.1/${domain}`];
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const xml = await r.text();
      const inc = /<incomingServer type="imap">([\s\S]*?)<\/incomingServer>/i.exec(xml)?.[1];
      const out = /<outgoingServer type="smtp">([\s\S]*?)<\/outgoingServer>/i.exec(xml)?.[1];
      if (!inc || !out) continue;
      const tag = (b: string, t: string) => new RegExp(`<${t}>([^<]+)</${t}>`, 'i').exec(b)?.[1]?.trim() ?? '';
      const port = Number(tag(inc, 'port')) || 993;
      const sport = Number(tag(out, 'port')) || 465;
      return {
        host: tag(inc, 'hostname').replace('%EMAILDOMAIN%', domain),
        port,
        secure: tag(inc, 'socketType').toUpperCase() === 'SSL' || port === 993,
        smtpHost: tag(out, 'hostname').replace('%EMAILDOMAIN%', domain),
        smtpPort: sport,
        smtpSecure: tag(out, 'socketType').toUpperCase() === 'SSL' || sport === 465,
      };
    } catch {
      /* sonraki kaynak */
    }
  }
  return undefined;
}

/** E-posta adresinden IMAP/SMTP sunucularını bul: bilinenler → autoconfig → imap.<alan>/smtp.<alan> tahmini */
export async function discoverMail(email: string): Promise<Servers> {
  const domain = email.split('@')[1]?.toLowerCase().trim() ?? '';
  for (const [re, s] of KNOWN) if (re.test(domain)) return s;
  const auto = domain ? await autoconfig(domain) : undefined;
  if (auto?.host) return auto;
  return { host: `imap.${domain}`, port: 993, secure: true, smtpHost: `smtp.${domain}`, smtpPort: 465, smtpSecure: true };
}
