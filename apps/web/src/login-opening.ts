import { useEffect, useState } from 'react';
import type { Account } from './types';

/**
 * "Giriş penceresi açılıyor" göstergesi: Yeniden bağlan'a basılınca hesap buraya yazılır; çekirdek hesabı 'connecting'e alıp
 * sonra başka bir duruma geçirene dek (pairing = giriş penceresi açıldı, connected = oturum zaten geçerliydi, error…) ekranda
 * kalır. Eskiden 3,5 sn'lik bildirimdi: pencere 10-20 sn sonra açılınca kullanıcı bir şey olmadığını sanıyordu.
 */
interface Opening {
  text: string;
  since: number;
  seenConnecting: boolean;
}
const opening = new Map<string, Opening>();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const MAX_MS = 90_000;

export function markOpening(accountId: string, text: string): void {
  opening.set(accountId, { text, since: Date.now(), seenConnecting: false });
  emit();
  setTimeout(() => {
    const o = opening.get(accountId);
    if (o && Date.now() - o.since >= MAX_MS - 50) (opening.delete(accountId), emit());
  }, MAX_MS);
}

export function clearOpening(accountId: string): void {
  if (opening.delete(accountId)) emit();
}

/** Hesap durumları değiştikçe biten açılışları temizle; gösterilecek metinleri döndür */
export function useLoginOpening(accounts: Account[]): string[] {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  useEffect(() => {
    let changed = false;
    for (const [id, o] of opening) {
      const a = accounts.find((x) => x.id === id);
      if (!a) {
        opening.delete(id);
        changed = true;
      } else if (a.status === 'connecting') o.seenConnecting = true;
      else if (o.seenConnecting) {
        opening.delete(id);
        changed = true;
      }
    }
    if (changed) emit();
  }, [accounts]);
  return [...opening.values()].map((o) => o.text);
}
