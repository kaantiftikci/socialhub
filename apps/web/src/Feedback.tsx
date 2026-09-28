import { useEffect, useRef, useState } from 'react';
import { PROFILE_NAME, PROFILE_USER, STATIC_DEMO } from './profile';
import { Icon } from './ui';

/**
 * Geri bildirim düğmesi (sağ alt): hata / öneri / talep + ekran görüntüsü, ekran kaydı ya da görsel/video dosyası →
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
const REC_LIMIT = 60; // sn

interface Att {
  file: File;
  url: string;
}

const canCapture = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

export function FeedbackButton() {
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<(typeof TYPES)[number][0]>('bug');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [atts, setAtts] = useState<Att[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(false);
  const [rec, setRec] = useState<{ stop: () => void; secs: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const website = useRef('');

  useEffect(() => () => atts.forEach((a) => URL.revokeObjectURL(a.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

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

  /** Ekran görüntüsü: tarayıcının ekran paylaşım penceresinden seçilen ekran/pencere/sekmeden tek kare */
  const screenshot = async () => {
    setErr('');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise((r) => setTimeout(r, 350)); // paylaşım çerçevesi otursun
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext('2d')!.drawImage(video, 0, 0);
      stream.getTracks().forEach((t) => t.stop());
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
      if (blob) add([new File([blob], `ekran-${Date.now()}.png`, { type: 'image/png' })]);
    } catch (e) {
      if ((e as Error).name !== 'NotAllowedError') setErr('Ekran görüntüsü alınamadı: ' + (e as Error).message);
    }
  };

  /** Ekran kaydı (en çok 60 sn, webm): "Kaydı bitir" ya da paylaşımı durdurunca eklenir */
  const record = async () => {
    setErr('');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 1_500_000 } : undefined);
      const chunks: Blob[] = [];
      let secs = 0;
      const tick = window.setInterval(() => {
        secs++;
        setRec((r) => (r ? { ...r, secs } : r));
        if (secs >= REC_LIMIT) mr.stop();
      }, 1000);
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = () => {
        clearInterval(tick);
        stream.getTracks().forEach((t) => t.stop());
        setRec(null);
        const type = (mr.mimeType || 'video/webm').split(';')[0];
        const blob = new Blob(chunks, { type });
        if (blob.size) add([new File([blob], `kayit-${Date.now()}.${type === 'video/mp4' ? 'mp4' : 'webm'}`, { type })]);
      };
      stream.getVideoTracks()[0]?.addEventListener('ended', () => mr.state !== 'inactive' && mr.stop());
      mr.start(1000);
      setRec({ stop: () => mr.state !== 'inactive' && mr.stop(), secs: 0 });
    } catch (e) {
      if ((e as Error).name !== 'NotAllowedError') setErr('Ekran kaydı başlatılamadı: ' + (e as Error).message);
    }
  };

  const submit = async () => {
    if (message.trim().length < 3) return setErr('Ne olduğunu kısaca yaz');
    setBusy(true);
    setErr('');
    try {
      const fd = new FormData();
      fd.set('type', type);
      fd.set('message', message.trim());
      fd.set('email', email.trim());
      fd.set('name', PROFILE_NAME);
      fd.set('user', PROFILE_USER);
      fd.set('page', location.href.replace(/([?&#])token=[^&#]*/g, '$1'));
      fd.set('app', STATIC_DEMO ? 'demo' : 'local');
      fd.set('website', website.current);
      for (const a of atts) fd.append('files[]', a.file, a.file.name);
      let res: Response;
      try {
        res = await fetch(FEEDBACK_URL, { method: 'POST', body: fd });
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
          <button className="fb-open" onClick={() => (setOpen(true), setSent(false))} aria-label="Geri bildirim gönder" title="Hata bildir / öneri gönder">
            <Icon name="thread" size={20} sw={2} />
          </button>
          <button className="fb-hide" onClick={() => setHidden(true)} aria-label="Geri bildirim düğmesini gizle" title="Gizle (sayfa yenilenince geri gelir)">
            <Icon name="x" size={11} sw={2.6} />
          </button>
        </div>
      )}
      {open && (
        <div className="fb-panel" role="dialog" aria-label="Geri bildirim">
          <div className="fb-head">
            <b>Geri bildirim</b>
            <span>Hata, öneri ya da isteğini doğrudan bize ilet</span>
            <button className="btn icon ghost xs b" onClick={() => setOpen(false)} aria-label="Kapat">
              <Icon name="x" size={14} sw={2} />
            </button>
          </div>
          {sent ? (
            <div className="fb-sent">
              <Icon name="check" size={22} sw={2.4} color="var(--green-txt)" />
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
              <input className="fb-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-postan (isteğe bağlı, yanıt için)" maxLength={120} />
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
                {canCapture && (
                  <button className="btn xs b b2" onClick={() => void screenshot()} disabled={!!rec || atts.length >= MAX_FILES} title="Ekran görüntüsü al">
                    <Icon name="camera" size={13} /> Ekran görüntüsü
                  </button>
                )}
                {canCapture && typeof MediaRecorder !== 'undefined' &&
                  (rec ? (
                    <button className="btn xs b fb-rec" onClick={rec.stop}>
                      <span className="fb-dot" /> Kaydı bitir · {rec.secs} sn
                    </button>
                  ) : (
                    <button className="btn xs b b2" onClick={() => void record()} disabled={atts.length >= MAX_FILES} title={`Ekran kaydı (en çok ${REC_LIMIT} sn)`}>
                      <Icon name="play" size={13} /> Ekran kaydı
                    </button>
                  ))}
                <button className="btn xs b b2" onClick={() => fileRef.current?.click()} disabled={atts.length >= MAX_FILES} title="Görsel ya da video ekle">
                  <Icon name="clip" size={13} /> Dosya
                </button>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,video/quicktime" multiple hidden onChange={(e) => (add(Array.from(e.target.files ?? [])), (e.target.value = ''))} />
              </div>
              {err && <div className="fb-err">{err}</div>}
              <button className="btn primary b fb-send" onClick={() => void submit()} disabled={busy || !!rec || message.trim().length < 3}>
                {busy ? <span className="spin" /> : <Icon name="send" size={14} sw={2} />} Gönder
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
