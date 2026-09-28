import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { bus } from './bus.js';

/**
 * Bağlantı önizlemesi (Open Graph): mesajdaki http(s) adresinin başlık/açıklama/görselini getirir.
 * SSRF koruması: yalnız http/https ve 80/443; ana makine adı çözülür, özel/yerel adresler (127/8, 10/8, 172.16/12,
 * 192.168/16, 169.254/16, 100.64/10, 198.18/15; IPv6'da yalnız 2000::/3, gömülü IPv4 — ::ffff:7f00:1, NAT64, 6to4 — denetlenir) reddedilir; en çok 3 yönlendirme (her biri yeniden denetlenir);
 * yalnız text/html; en çok 512 KB; 6 sn zaman aşımı. Sonuçlar bellekte 6 saat tutulur (başarısızlar 30 dk).
 */
export interface LinkPreview {
  url: string;
  site?: string;
  title?: string;
  description?: string;
  image?: string;
}

const cache = new Map<string, { at: number; v: LinkPreview | null }>();
const MAX_CACHE = 800;
const TTL_OK = 6 * 3600_000;
const TTL_FAIL = 30 * 60_000;

function privateV4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** IPv6 → 8 adet 16 bitlik sözcük (gömülü IPv4 ve :: açılır); geçersizse null */
function v6Words(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((x) => x > 255)) return null;
    s = s.slice(0, v4.index) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (h: string) => (h ? h.split(':') : []);
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const words = [...head, ...Array(fill).fill('0'), ...tail].map((w) => (/^[0-9a-f]{1,4}$/.test(w) ? parseInt(w, 16) : NaN));
  return words.length === 8 && words.every((w) => !Number.isNaN(w)) ? words : null;
}

export function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return privateV4(ip);
  const w = v6Words(ip);
  if (!w) return true; // çözülemeyen adres: güvenli taraf
  const embedded = (hi: number, lo: number) => privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  const zero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  // IPv4 eşlenmiş (::ffff:a.b.c.d / ::ffff:7f00:1) ve IPv4 uyumlu (::a.b.c.d; ::, ::1 dahil)
  if (zero(0, 5) && w[5] === 0xffff) return embedded(w[6], w[7]);
  if (zero(0, 6)) return true;
  // NAT64 (64:ff9b::/96 gömülü IPv4; 64:ff9b:1::/48 yerel çeviri → engelle)
  if (w[0] === 0x64 && w[1] === 0xff9b) return zero(2, 6) ? embedded(w[6], w[7]) : true;
  // 6to4 (2002:AABB:CCDD::) gömülü IPv4
  if (w[0] === 0x2002) return embedded(w[1], w[2]);
  // Teredo (2001:0::/32) ve belgeleme (2001:db8::/32): engelle
  if (w[0] === 0x2001 && (w[1] === 0 || w[1] === 0xdb8)) return true;
  // yalnız küresel tek noktaya yayın (2000::/3); ULA fc00::/7, fe80::/10, ff00::/8 vb. hepsi dışarıda
  return (w[0] & 0xe000) !== 0x2000;
}

/** Denetlenmiş adres: bağlantı bu IP'ye sabitlenir (DNS yeniden bağlama / TOCTOU ile iç ağa sızılamaz) */
interface Vetted {
  address: string;
  family: number;
}

async function safeHost(u: URL): Promise<Vetted | null> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (net.isIP(host)) return privateIp(host) ? null : { address: host, family: net.isIP(host) };
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => privateIp(a.address))) return null;
    return { address: addrs[0].address, family: addrs[0].family };
  } catch {
    return null;
  }
}

function get(u: URL, pin: Vetted, json = false): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).get(
      u,
      {
        // ad çözümlemesi yeniden yapılmaz: safeHost'un onayladığı adrese bağlan (SNI/Host yine asıl ad)
        lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
          opts?.all ? cb(null, [{ address: pin.address, family: pin.family }]) : cb(null, pin.address, pin.family)) as unknown as http.RequestOptions['lookup'],
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; Mivelo/1.0; +https://mivelo.app) facebookexternalhit/1.1', accept: json ? 'application/json' : 'text/html,application/xhtml+xml', 'accept-language': 'tr,en;q=0.8' }, timeout: 6000 },
      (res) => {
        const type = String(res.headers['content-type'] ?? '');
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          return resolve({ status: res.statusCode, headers: res.headers, body: '' });
        }
        if (!(json ? /json/i : /text\/html|application\/xhtml/i).test(type)) {
          res.resume();
          return resolve({ status: res.statusCode ?? 0, headers: res.headers, body: '' });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 512 * 1024) {
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
        res.on('close', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('zaman aşımı')));
    req.on('error', reject);
  });
}

function meta(html: string, ...names: string[]): string | undefined {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i');
    const tag = html.match(re)?.[0];
    const v = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (v) return decode(v.trim());
  }
  return undefined;
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

export function parsePreview(url: string, html: string): LinkPreview | null {
  const head = html.slice(0, 200_000);
  const title = meta(head, 'og:title', 'twitter:title') ?? decode(head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? '');
  const description = meta(head, 'og:description', 'twitter:description', 'description');
  let image = meta(head, 'og:image', 'og:image:url', 'twitter:image');
  const site = meta(head, 'og:site_name');
  if (image) {
    try {
      const iu = new URL(image, url);
      image = iu.protocol === 'https:' || iu.protocol === 'http:' ? iu.href : undefined;
    } catch {
      image = undefined;
    }
  }
  if (!title && !description) return null;
  return { url, site: site || new URL(url).hostname.replace(/^www\./, ''), title: title?.slice(0, 200) || undefined, description: description?.slice(0, 300), image };
}

/** x.com / twitter.com gönderi adresinden kimlik (…/status/<id>) */
export function xStatusId(u: URL): string | undefined {
  if (!/(^|\.)(x|twitter)\.com$/i.test(u.hostname)) return undefined;
  return u.pathname.match(/\/status(?:es)?\/(\d{1,25})/)?.[1];
}

/** Gömme ucunun istediği belirteç (react-tweet ile aynı hesap: kimlikten türetilir, gizli değil) */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(6 ** 2).replace(/(0+|\.)/g, '');
}

/**
 * X gönderi önizlemesi: x.com botlara Open Graph vermiyor; herkese açık gömme verisi (cdn.syndication.twimg.com/tweet-result,
 * Vercel react-tweet'in kullandığı uç) okunur. Hesap oturumu KULLANILMAZ — X hesabı için risk yok. Silinmiş/korumalı gönderide null.
 */
export function parseSyndication(url: string, j: Record<string, any>): LinkPreview | null { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!j || j.__typename === 'TweetTombstone' || !j.user) return null;
  const clean = (t: unknown) =>
    String(t ?? '')
      .replace(/https:\/\/t\.co\/\w+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  // metin yalnız bağlantıdan ibaretse (salt video/görsel paylaşımı) alıntılanan gönderinin ya da kartın metnine düş
  const text = clean(j.text) || clean(j.quoted_tweet?.text) || clean(j.card?.binding_values?.title?.string_value);
  const pick = (t: any): string | undefined => // eslint-disable-line @typescript-eslint/no-explicit-any
    t?.photos?.[0]?.url ??
    t?.mediaDetails?.find((m: { media_url_https?: string }) => m.media_url_https)?.media_url_https ??
    t?.video?.poster ??
    t?.entities?.media?.[0]?.media_url_https ??
    t?.card?.binding_values?.thumbnail_image_original?.image_value?.url ??
    t?.card?.binding_values?.player_image_original?.image_value?.url;
  const avatar = j.user.profile_image_url_https ? String(j.user.profile_image_url_https).replace('_normal.', '_bigger.') : undefined;
  const image = pick(j) ?? pick(j.quoted_tweet) ?? avatar;
  return {
    url,
    site: 'X',
    title: `${j.user.name ?? ''} (@${j.user.screen_name ?? '?'})`.trim(),
    description: text ? (text.length > 280 ? text.slice(0, 279) + '…' : text) : undefined,
    image,
  };
}

async function fetchXPost(page: URL, id: string): Promise<LinkPreview | null> {
  const api = new URL(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=tr&token=${syndicationToken(id)}`);
  const pin = await safeHost(api);
  if (!pin) return null;
  const r = await get(api, pin, true);
  if (r.status !== 200 || !r.body) {
    bus.log('info', `X önizleme: ${id} için gömme verisi yok (HTTP ${r.status})`);
    return null;
  }
  const j = JSON.parse(r.body) as Record<string, unknown>;
  const v = parseSyndication(page.href, j);
  // tanı: metin ya da medya gelmediyse yanıtın yapısı (içerik değil, yalnız alan adları) günlüğe
  if (v && (!v.description || !v.image || v.image.includes('profile_images')))
    bus.log('info', `X önizleme: ${id} eksik (metin ${v.description ? 'var' : 'yok'}, görsel ${v.image ? (v.image.includes('profile_images') ? 'profil' : 'var') : 'yok'}); alanlar: ${Object.keys(j).join(',')}`);
  return v;
}

export async function fetchPreview(raw: string): Promise<LinkPreview | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const key = u.href;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.v ? TTL_OK : TTL_FAIL)) return hit.v;
  let v: LinkPreview | null = null;
  const xid = xStatusId(u);
  try {
    if (xid) v = await fetchXPost(u, xid);
    let cur = u;
    for (let i = 0; i < (xid ? 0 : 4); i++) {
      const pin = await safeHost(cur);
      if (!pin) break;
      const r = await get(cur, pin);
      if (r.status >= 300 && r.status < 400 && r.headers.location) {
        cur = new URL(String(r.headers.location), cur);
        continue;
      }
      if (r.status === 200 && r.body) v = parsePreview(cur.href, r.body);
      break;
    }
  } catch {
    v = null;
  }
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), v });
  return v;
}
