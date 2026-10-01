import { useEffect, useRef, useState } from 'react';
import { STATIC_DEMO } from './profile';
import { reducedMotion } from './motion/motion';
import { Icon } from './ui';
import { LegalLink } from './Consent';
import { LEGAL_URLS } from './consent-store';

/**
 * Geri bildirim düğmesi (sağ alt): hata / öneri / talep + fotoğraf/video dosyası (ekran görüntüsü dahil; yapıştırılabilir) →
 * mivelo.app/api/feedback.php → yönetim paneli "Geri bildirim". Kapatılınca yalnız bu oturumda gizlenir (sayfa yenilenince
 * geri gelir; durum bilerek kalıcı değil).
 */
const FEEDBACK_URL = (import.meta.env.VITE_FEEDBACK_URL as string | undefined) || 'https://mivelo.app/api/feedback.php';
const TYPES = [
  ['bug', 'Hata'],
  ['idea', 'Öneri'],
  ['request', 'Talep'],
  ['other', 'Diğer'],
] as const;
const MAX_FILES = 5;
const MAX_FILE = 40 * 1024 * 1024;
const MAX_TOTAL = 60 * 1024 * 1024;

interface Att {
  file: File;
  url: string;
}


export function FeedbackButton() {
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<(typeof TYPES)[number][0]>('bug');
  const [message, setMessage] = useState('');
  const [atts, setAtts] = useState<Att[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const website = useRef('');
  // kapanış: panel sağ alta doğru 150 ms'de küçülüp solar (motion/extras.css `.fb-panel.closing`), sonra kaldırılır
  const [closing, setClosing] = useState(false);
  const closeT = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(closeT.current), []);
  const close = () => {
    if (closing) return;
    if (reducedMotion()) return setOpen(false);
    setClosing(true);
    closeT.current = window.setTimeout(() => (setOpen(false), setClosing(false)), 150);
  };
  const openPanel = () => {
    window.clearTimeout(closeT.current);
    setClosing(false);
    setOpen(true);
    setSent(false);
  };

  useEffect(() => () => atts.forEach((a) => URL.revokeObjectURL(a.url)), []); // eslint-disable-line react-hooks/exhaustive-deps
  // Ayarlar → Yardım / Hakkında: "Sorun bildir"
  useEffect(() => {
    const on = () => (window.clearTimeout(closeT.current), setClosing(false), setHidden(false), setOpen(true));
    window.addEventListener('mivelo-feedback', on);
    return () => window.removeEventListener('mivelo-feedback', on);
  }, []);

  const add = (files: File[]) => {
    setErr('');
    const next = [...atts];
    for (const f of files) {
      if (!/^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm|quicktime))/.test(f.type)) {
        setErr(`Yalnız görsel ya da video eklenebilir (${f.name})`);
        continue;
      }
      if (f.size > MAX_FILE) {
        setErr(`${f.name} çok büyük (en çok 40 MB)`);
        continue;
      }
      if (next.length >= MAX_FILES) {
        setErr(`En çok ${MAX_FILES} dosya`);
        break;
      }
      next.push({ file: f, url: URL.createObjectURL(f) });
    }
    if (next.reduce((n, a) => n + a.file.size, 0) > MAX_TOTAL) {
      setErr('Ekler toplamı 60 MB’ı geçemez');
      return;
    }
    setAtts(next);
  };
  const remove = (i: number) => {
    URL.revokeObjectURL(atts[i].url);
    setAtts(atts.filter((_, j) => j !== i));
  };

  const submit = async () => {
    if (message.trim().length < 3) return setErr('Ne olduğunu kısaca yaz');
    setBusy(true);
    setErr('');
    try {
      const fd = new FormData();
      fd.set('type', type);
      fd.set('message', message.trim());
      fd.set('page', location.href.replace(/([?&#])token=[^&#]*/g, '$1'));
      fd.set('website', website.current);
      for (const a of atts) fd.append('files[]', a.file, a.file.name);
      let res: Response;
      try {
        // demo: kendi API'sine (üye kimliğini sunucu oturumdan yazar); yerel uygulama: mivelo.app
        res = await fetch(STATIC_DEMO ? '/api/index.php?action=feedback' : FEEDBACK_URL, { method: 'POST', body: fd, credentials: STATIC_DEMO ? 'same-origin' : 'omit' });
      } catch {
        throw new Error('Gönderilemedi: internet bağlantını kontrol et');
      }
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      // yalnız sunucunun açık onayı başarı sayılır (yanlış adres HTML sayfası döndürüp 200 verebilir)
      if (!res.ok || data.ok !== true) throw new Error(data.error || `Gönderilemedi (${res.status})`);
      atts.forEach((a) => URL.revokeObjectURL(a.url));
      setAtts([]);
      setMessage('');
      setSent(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (hidden) return null;
  return (
    <>
      {!open && (
        <div className="fb-fab">
          <button className="fb-bubble" onClick={openPanel} tabIndex={-1} aria-hidden="true">
            Hata / öneri bildir
          </button>
          <button className="fb-open" onClick={openPanel} aria-label="Hata bildir ya da öneri gönder" title="Hata bildir / öneri gönder">
            <Icon name="thread" size={24} sw={2} />
          </button>
          <button className="fb-hide" onClick={() => setHidden(true)} aria-label="Geri bildirim düğmesini gizle" title="Gizle (sayfa yenilenince geri gelir)">
            <Icon name="x" size={11} sw={2.6} />
          </button>
        </div>
      )}
      {open && (
        <div className={`fb-panel ${closing ? 'closing' : ''}`} role="dialog" aria-label="Geri bildirim" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), close())}>
          <div className="fb-head">
            <b>Geri bildirim</b>
            <span>Hata, öneri ya da isteğini doğrudan bize ilet</span>
            <button className="btn icon ghost xs b" onClick={close} aria-label="Kapat">
              <Icon name="x" size={14} sw={2} />
            </button>
          </div>
          {sent ? (
            <div className="fb-sent">
              {/* onay: halka pop ile büyür, tik çizilir (motion/extras.css) */}
              <span className="fb-ok" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="26" height="26">
                  <path d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} />
                </svg>
              </span>
              <b>Teşekkürler, iletildi!</b>
              <span>İnceleyip gerekirse sana döneceğiz.</span>
              <button className="btn sm b b2" onClick={() => setSent(false)}>
                Yeni bildirim
              </button>
            </div>
          ) : (
            <div className="fb-body">
              <div className="fb-types" role="radiogroup" aria-label="Tür">
                {TYPES.map(([k, l]) => (
                  <button key={k} role="radio" aria-checked={type === k} className={type === k ? 'on' : ''} onClick={() => setType(k)}>
                    {l}
                  </button>
                ))}
              </div>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={type === 'bug' ? 'Ne oldu? Ne yapıyordun, ne bekliyordun?' : type === 'idea' ? 'Önerin nedir?' : 'Ne istiyorsun?'}
                maxLength={5000}
                rows={5}
                autoFocus
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData.files);
                  if (files.length) {
                    e.preventDefault();
                    add(files);
                  }
                }}
              />
              <input className="fb-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" onChange={(e) => (website.current = e.target.value)} />
              {atts.length > 0 && (
                <div className="fb-atts">
                  {atts.map((a, i) => (
                    <div key={a.url} className="fb-att">
                      {a.file.type.startsWith('video/') ? <video src={a.url} muted /> : <img src={a.url} alt="" />}
                      <button onClick={() => remove(i)} aria-label="Eki kaldır">
                        <Icon name="x" size={11} sw={2.6} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="fb-tools">
                <button className="btn xs b b2" onClick={() => fileRef.current?.click()} disabled={atts.length >= MAX_FILES} title="Fotoğraf ya da video ekle">
                  <Icon name="image" size={13} /> Fotoğraf / video ekle
                </button>
                <span className="fb-limit">en çok {MAX_FILES} dosya · dosya başına 40 MB</span>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,video/quicktime" multiple hidden onChange={(e) => (add(Array.from(e.target.files ?? [])), (e.target.value = ''))} />
              </div>
              {err && <div className="fb-err">{err}</div>}
              <p className="fb-legal">
                Gönderdiğin metin ve dosyalar hataları gidermek için mivelo.app sunucusunda saklanır; ekranda başkalarına ait bilgiler varsa gizlemeni öneririz.{' '}
                <LegalLink href={LEGAL_URLS.kvkk}>Aydınlatma Metni</LegalLink>
              </p>
              <button className="btn primary b fb-send" onClick={() => void submit()} disabled={busy || message.trim().length < 3}>
                {busy ? <span className="spin" /> : <Icon name="send" size={14} sw={2} />} Gönder
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
