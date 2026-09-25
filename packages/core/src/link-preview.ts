import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

/**
 * Bağlantı önizlemesi (Open Graph): mesajdaki http(s) adresinin başlık/açıklama/görselini getirir.
 * SSRF koruması: yalnız http/https ve 80/443; ana makine adı çözülür, özel/yerel adresler (127/8, 10/8, 172.16/12,
 * 192.168/16, 169.254/16, ::1, fc00::/7, fe80::/10) reddedilir; en çok 3 yönlendirme (her biri yeniden denetlenir);
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

function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return privateIp(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb');
}

async function safeHost(u: URL): Promise<boolean> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.port && u.port !== '80' && u.port !== '443') return false;
  if (u.username || u.password) return false;
  const host = u.hostname;
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (net.isIP(host)) return !privateIp(host);
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !privateIp(a.address));
  } catch {
    return false;
  }
}

function get(u: URL): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).get(
      u,
      { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Mivelo/1.0; +https://mivelo.app) facebookexternalhit/1.1', accept: 'text/html,application/xhtml+xml', 'accept-language': 'tr,en;q=0.8' }, timeout: 6000 },
      (res) => {
        const type = String(res.headers['content-type'] ?? '');
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          return resolve({ status: res.statusCode, headers: res.headers, body: '' });
        }
        if (!/text\/html|application\/xhtml/i.test(type)) {
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
  try {
    let cur = u;
    for (let i = 0; i < 4; i++) {
      if (!(await safeHost(cur))) break;
      const r = await get(cur);
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
