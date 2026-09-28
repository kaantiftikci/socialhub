// Mivelo ağ geçidi — oturum belirteci (demo PHP arka ucuyla aynı sözleşme; bağımlılıksız)
//
// Belirteç: <payloadB64url>.<sigB64url>
//   payload = base64url(JSON {"u":"<uid>","e":<bitiş, unix saniye>}), dolgusuz
//   sig     = base64url(HMAC-SHA256(CORE_SECRET, payloadB64url)), dolgusuz
// PHP karşılığı: rtrim(strtr(base64_encode(hash_hmac('sha256', $p, $secret, true)), '+/', '-_'), '=')
//
// Üye silme (sunucudan sunucuya, POST /gw/delete-user): x-gw-sig = base64url(HMAC-SHA256(CORE_SECRET, "delete:<uid>:<ts>"))
//
// Komut satırı (deneme için): CORE_SECRET=… node apps/gateway/token.mjs u-test1 [geçerlilik saniye, varsayılan 3600]
//                             CORE_SECRET=… node apps/gateway/token.mjs --delete u-test1   → {"uid","ts","sig"}
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** Üye kimliği: demo arka ucunun verdiği biçim (u-admin, u-b1f2e37fe2b5) — klasör adı olarak da güvenli */
export const UID_RE = /^u-[a-z0-9-]{3,40}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
/** Silme isteğinin zaman damgası en çok bu kadar kayabilir (saniye) */
export const DELETE_SKEW_SEC = 300;

const mac = (secret, data) => createHmac('sha256', secret).update(data).digest('base64url');

/** Sabit sürede metin karşılaştırma (uzunluk farkı da zamanlamayla sızmasın diye özetler karşılaştırılır) */
export function safeEqual(a, b) {
  const x = createHmac('sha256', 'cmp').update(String(a)).digest();
  const y = createHmac('sha256', 'cmp').update(String(b)).digest();
  return timingSafeEqual(x, y) && String(a).length === String(b).length;
}

/** Belirteç üret (PHP tarafıyla aynı biçim; testler ve komut satırı için) */
export function sign(payload, secret) {
  const p = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${p}.${mac(secret, p)}`;
}

/**
 * Belirteci doğrula. Geçerliyse { u, e }, değilse null (biçim, imza, kimlik ya da süre hatası — nedeni dışarı verilmez).
 * nowSec: şimdiki zaman (unix saniye; testler için)
 */
export function verify(token, secret, nowSec = Date.now() / 1000) {
  if (typeof token !== 'string' || !secret || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !B64URL_RE.test(parts[0]) || !B64URL_RE.test(parts[1])) return null;
  if (!safeEqual(mac(secret, parts[0]), parts[1])) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
  const { u, e } = claims;
  if (typeof u !== 'string' || !UID_RE.test(u)) return null;
  if (typeof e !== 'number' || !Number.isFinite(e) || e <= nowSec) return null;
  return { u, e };
}

/** Üye silme imzası: base64url(HMAC-SHA256(secret, "delete:<uid>:<ts>")) */
export function signDelete(uid, ts, secret) {
  return mac(secret, `delete:${uid}:${ts}`);
}

/** Üye silme isteğini doğrula: kimlik biçimi, tam sayı ts (±300 sn), imza (sabit sürede) */
export function verifyDelete(uid, ts, sig, secret, nowSec = Date.now() / 1000) {
  if (!secret || typeof uid !== 'string' || !UID_RE.test(uid)) return false;
  if (typeof ts !== 'number' || !Number.isInteger(ts) || Math.abs(nowSec - ts) > DELETE_SKEW_SEC) return false;
  if (typeof sig !== 'string' || sig.length > 128 || !B64URL_RE.test(sig)) return false;
  return safeEqual(signDelete(uid, ts, secret), sig);
}

// ---------- komut satırı ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.CORE_SECRET ?? '';
  const args = process.argv.slice(2);
  if (secret.length < 32) {
    console.error('CORE_SECRET (en az 32 karakter) ortam değişkeni gerekli');
    process.exit(1);
  }
  if (args[0] === '--delete') {
    const uid = args[1] ?? '';
    if (!UID_RE.test(uid)) {
      console.error('Kullanım: node token.mjs --delete u-xxx');
      process.exit(1);
    }
    const ts = Math.floor(Date.now() / 1000);
    console.log(JSON.stringify({ uid, ts, sig: signDelete(uid, ts, secret) }));
  } else {
    const uid = args[0] ?? '';
    const ttl = Number(args[1] ?? 3600);
    if (!UID_RE.test(uid) || !(ttl > 0)) {
      console.error('Kullanım: node token.mjs u-xxx [saniye]');
      process.exit(1);
    }
    console.log(sign({ u: uid, e: Math.floor(Date.now() / 1000) + ttl }, secret));
  }
}
