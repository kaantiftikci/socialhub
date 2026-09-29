import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

/**
 * Mivelo profili (29.09, Kaan: Ayarlar → Profil: fotoğraf, ad, kullanıcı adı, e-posta, telefon). Yalnız bu bilgisayarda
 * `~/.mivelo/profile.json` (0600); hiçbir sunucuya gitmez. Boş alan = varsayılan (lisans sahibi / işletim sistemi adı).
 * Lisans e-postası bundan etkilenmez (anahtar hangi adrese gönderildiyse o).
 */
export interface Profile {
  name?: string;
  username?: string;
  email?: string;
  phone?: string;
  /** data:image/(png|jpeg|webp);base64,… — arayüz kırpıp küçültür (≤256 px) */
  photo?: string;
}

export const PROFILE_FILE = () => path.join(DATA_DIR, 'profile.json');
export const PHOTO_MAX = 400_000;

export class ProfileError extends Error {}

const clean = (v: unknown, max: number): string | undefined => {
  if (v == null) return undefined;
  if (typeof v !== 'string') throw new ProfileError('Geçersiz değer');
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (s.length > max) throw new ProfileError('Değer çok uzun');
  return s || undefined;
};

/** Gelen profili doğrula ve temizle (hatalıysa ProfileError) */
export function validateProfile(input: unknown): Profile {
  if (!input || typeof input !== 'object') throw new ProfileError('Geçersiz profil');
  const b = input as Record<string, unknown>;
  const out: Profile = {
    name: clean(b.name, 60),
    username: clean(b.username, 30),
    email: clean(b.email, 120),
    phone: clean(b.phone, 30),
    photo: clean(b.photo, PHOTO_MAX),
  };
  if (out.username) {
    out.username = out.username.replace(/^@/, '');
    if (!/^[a-zA-Z0-9._-]{2,30}$/.test(out.username)) throw new ProfileError('Kullanıcı adı yalnız harf, rakam, nokta, alt çizgi ve tire içerebilir (2-30)');
  }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(out.email)) throw new ProfileError('E-posta adresi geçersiz');
  if (out.phone) {
    if (!/^\+?[0-9 ()-]{7,20}$/.test(out.phone) || out.phone.replace(/\D/g, '').length < 7) throw new ProfileError('Telefon numarası geçersiz');
  }
  if (out.photo && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(out.photo)) throw new ProfileError('Fotoğraf PNG, JPEG ya da WebP olmalı');
  for (const k of Object.keys(out) as Array<keyof Profile>) if (out[k] === undefined) delete out[k];
  return out;
}

export function readProfile(): Profile {
  try {
    return validateProfile(JSON.parse(fs.readFileSync(PROFILE_FILE(), 'utf8')));
  } catch {
    return {};
  }
}

export function saveProfile(input: unknown): Profile {
  const p = validateProfile(input);
  const file = PROFILE_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return p;
}
