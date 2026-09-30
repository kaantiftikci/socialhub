import { useState } from 'react';
import type { Message } from './types';
import { Icon } from './ui';
import { modelReady, requestTranscript, useMlStatus, useTranscript } from './ml-client';
import { LANG_NAMES } from './lang-detect';

/**
 * Yerel AI'ın balon parçası (Conversation.tsx yalnız bağlar):
 * - VoiceTranscript: sesli mesajın altında yazıya dökülmüş metin (katlanabilir) / "Yazıya dök" / sürüyor / hata
 * Çeviri 30.09'da kaldırıldı (Kaan: işletim sistemlerinin kendi çevirisi var).
 */
const langName = (l?: string | null) => (l ? (LANG_NAMES[l] ?? l.toUpperCase()) : '');
const hasVoice = (m: Message) => !!m.attachments?.some((a) => a.kind === 'audio' && (a.link || a.url));

export function VoiceTranscript({ m }: { m: Message }) {
  const t = useTranscript(m.id);
  const status = useMlStatus();
  const [open, setOpen] = useState(true);
  if (!hasVoice(m) || m.deleted) return null;
  if (!t) {
    // model yoksa düğme yine görünür: tıklayınca ne yapılacağı (indir) yazılır
    return (
      <button type="button" className="vt-btn b" onClick={() => void requestTranscript(m.id)} title={modelReady(status, 'whisper') ? 'Cihazında yazıya dök (hiçbir yere gönderilmez)' : 'Önce Ayarlar → Yerel AI modelleri’nden konuşma tanıma modelini indir'}>
        <Icon name="transcript" size={13} /> Yazıya dök
      </button>
    );
  }
  if (t.status === 'pending')
    return (
      <span className="vt vt-busy" role="status">
        <span className="spin" /> Yazıya dökülüyor…
      </span>
    );
  if (t.status === 'error')
    return (
      <span className="vt vt-err">
        <Icon name="alert" size={13} />
        <span>{t.error || 'Yazıya dökülemedi'}</span>
        <button type="button" className="vt-link b" onClick={() => void requestTranscript(m.id)}>
          Yeniden dene
        </button>
      </span>
    );
  if (!t.text.trim())
    return (
      <span className="vt vt-empty">
        <Icon name="transcript" size={13} /> Konuşma algılanmadı
      </span>
    );
  const long = t.text.length > 220;
  return (
    <div className={`vt ${open ? '' : 'closed'}`}>
      <button type="button" className="vt-head b" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={open ? 'Metni gizle' : 'Metni göster'}>
        <Icon name="transcript" size={12} />
        <span>Yazıya döküldü{t.lang && t.lang !== 'tr' ? ` · ${langName(t.lang)}` : ''}</span>
        <Icon name={open ? 'chevup' : 'chev'} size={11} />
      </button>
      {open && <p className={`vt-text ${long ? 'long' : ''}`}>{t.text}</p>}
    </div>
  );
}
