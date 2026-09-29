import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { isMac, isTauri, openExternal } from './desktop';
import { setupDone } from './Onboarding';
import { Icon } from './ui';

type Missing = 'notifications' | 'fulldisk' | 'microphone' | 'messages';

const TEXT: Record<Missing, { icon: string; text: string; pane: 'notifications' | 'fulldisk' | 'microphone' | 'automation' }> = {
  notifications: { icon: 'belloff', text: 'Bildirimler Mivelo için kapalı. Yeni mesaj geldiğinde uyarı almak için Sistem Ayarları’ndan aç.', pane: 'notifications' },
  fulldisk: { icon: 'lock', text: 'Tam Disk Erişimi verilmedi. iMessage mesajlarını ve rehberdeki adları okuyabilmek için Sistem Ayarları’nda Mivelo’yu aç.', pane: 'fulldisk' },
  microphone: { icon: 'mic', text: 'Mikrofon izni kapalı. Sesli mesaj kaydedebilmek için Sistem Ayarları’ndan aç.', pane: 'microphone' },
  messages: { icon: 'send', text: 'Mesajlar ile gönderme izni verilmedi. iMessage yanıtları için Sistem Ayarları → Otomasyon’da Mivelo’ya izin ver.', pane: 'automation' },
};
const ORDER: Missing[] = ['notifications', 'fulldisk', 'microphone', 'messages'];
const DISMISS_KEY = 'mivelo.permDismiss';
const DISMISS_MS = 3 * 86_400_000;

function dismissed(): Partial<Record<Missing, number>> {
  try {
    return JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}') as Partial<Record<Missing, number>>;
  } catch {
    return {};
  }
}

async function notificationsGranted(): Promise<boolean | null> {
  try {
    const n = await import('@tauri-apps/plugin-notification');
    return await n.isPermissionGranted();
  } catch {
    return null;
  }
}

/** Şu an verilmemiş izinler (yalnız kesin bilinenler; bilinmeyen durum uyarı sayılmaz) */
async function missingPermissions(hasIMessage: boolean): Promise<Missing[]> {
  const out: Missing[] = [];
  if ((await notificationsGranted()) === false) out.push('notifications');
  const p = isMac ? await api.permissions().catch(() => undefined) : undefined;
  if (isMac && hasIMessage && p?.fullDisk === false) out.push('fulldisk');
  // mikrofon / Mesajlar: macOS izin kaydı (TCC, Tam Disk Erişimi varsa) asıl kaynak; yoksa tarayıcı sorgusu / kurulumdaki yanıt
  let micDenied = p?.tcc?.microphone === 'denied';
  if (!p?.tcc) {
    try {
      micDenied = (await navigator.permissions?.query({ name: 'microphone' as PermissionName }))?.state === 'denied';
    } catch {
      /* WebKit sorgulamayı desteklemeyebilir */
    }
  }
  if (micDenied) out.push('microphone');
  if (isMac && hasIMessage) {
    let msgDenied = p?.tcc?.messages === 'denied';
    if (!p?.tcc) {
      try {
        msgDenied = (JSON.parse(localStorage.getItem('mivelo.setupPerms') || '{}') as Record<string, string>).messages === 'denied';
      } catch {
        /* yok */
      }
    }
    if (msgDenied) out.push('messages');
  }
  return out;
}

/**
 * Verilmemiş izin uyarısı (29.09, Kaan: "en başta izin verilmeyen izinler varsa böyle bir uyarı göster" — Claude uygulamasındaki
 * "Notifications are turned off" kartı gibi). Yalnız masaüstü paketinde ve ilk kurulumdan sonra; sağ üstte tek kart (öncelik:
 * bildirim → Tam Disk Erişimi → mikrofon → Mesajlar). "Sistem Ayarları’nı aç" ilgili bölmeyi açar (bildirimde önce izin penceresi
 * denenir); ✕ o izni 3 gün göstermez. Açılışta, pencere öne gelince ve 30 sn'de bir yeniden denetlenir → izin verilince kaybolur.
 */
export function PermissionBanner({ hasIMessage }: { hasIMessage: boolean }) {
  const [missing, setMissing] = useState<Missing | null>(null);
  const check = useCallback(async () => {
    if (!isTauri || !setupDone()) return setMissing(null);
    const d = dismissed();
    const list = (await missingPermissions(hasIMessage)).filter((k) => !d[k] || Date.now() - d[k]! > DISMISS_MS);
    setMissing(ORDER.find((k) => list.includes(k)) ?? null);
  }, [hasIMessage]);
  useEffect(() => {
    if (!isTauri) return;
    const first = window.setTimeout(() => void check(), 4000); // açılış animasyonu/kurulum bitsin
    const t = window.setInterval(() => void check(), 30_000);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [check]);
  if (!missing) return null;
  const m = TEXT[missing];
  const open = async () => {
    if (missing === 'notifications') {
      try {
        const n = await import('@tauri-apps/plugin-notification');
        if ((await n.requestPermission()) === 'granted') return void check();
      } catch {
        /* izin penceresi açılamadı: ayarlara git */
      }
    }
    if (isMac) await api.openPermissionPane(m.pane).catch(() => undefined);
    else await openExternal(missing === 'notifications' ? 'ms-settings:notifications' : missing === 'microphone' ? 'ms-settings:privacy-microphone' : 'ms-settings:privacy');
  };
  const close = () => {
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify({ ...dismissed(), [missing]: Date.now() }));
    } catch {
      /* yok */
    }
    setMissing(null);
  };
  return (
    <div className="perm-card" role="status">
      <Icon name={m.icon} size={18} sw={1.8} />
      <div>
        <p>{m.text}</p>
        <button className="btn sm b b2" onClick={() => void open()}>
          Sistem Ayarları’nı aç
        </button>
      </div>
      <button className="perm-x" aria-label="Kapat" onClick={close}>
        <Icon name="x" size={16} sw={2} />
      </button>
    </div>
  );
}
