import { useEffect, useMemo, useRef, useState } from 'react';
import type { Chat, Message } from './types';
import { Icon } from './ui';
import { mlApi } from './ml-api';
import { hideTranslation, modelReady, requestTranscript, setAutoTranslate, translateMessage, useAutoTranslate, useMlStatus, useTranscript, useTranslation } from './ml-client';
import { detectLanguage, dominantLanguage, LANG_NAMES } from './lang-detect';

/**
 * Yerel AI'ın balon ve yazma alanı parçaları (Conversation.tsx yalnız bağlar):
 * - VoiceTranscript: sesli mesajın altında yazıya dökülmüş metin (katlanabilir) / "Yazıya dök" / sürüyor / hata
 * - TranslationBlock: mesajın altında çeviri (Çevir düğmesi ya da sohbette otomatik çeviri)
 * - ComposeTranslate: yazma alanında "Çevir ve gönder" (karşı tarafın dilini son mesajlarından algılar)
 * - AutoTranslateRow: sağ panelde sohbet başına "Otomatik çevir"
 */
const hasVoice = (m: Message) => !!m.attachments?.some((a) => a.kind === 'audio' && (a.link || a.url));
const langName = (l?: string | null) => (l ? (LANG_NAMES[l] ?? l.toUpperCase()) : '');

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

export function TranslationBlock({ m }: { m: Message }) {
  const st = useTranslation(m.id);
  if (!st || st.state === 'hidden') return null;
  if (st.state === 'loading')
    return (
      <div className="trx trx-busy" role="status">
        <span className="spin" /> Çevriliyor…
      </div>
    );
  if (st.state === 'error')
    return (
      <div className="trx trx-err">
        <Icon name="alert" size={12} /> {st.error}
        <button type="button" className="vt-link b" onClick={() => void translateMessage(m.id)}>
          Yeniden dene
        </button>
      </div>
    );
  const t = st.t;
  return (
    <div className="trx">
      <div className="trx-head">
        <Icon name="translate" size={12} />
        <span>{t.same ? `Zaten ${langName(t.lang)}` : `${langName(t.source) || 'Çeviri'} → ${langName(t.lang)}`}</span>
        {t.same && (
          <button type="button" className="vt-link b" onClick={() => void translateMessage(m.id, { force: true })}>
            Yine de çevir
          </button>
        )}
        <button type="button" className="trx-x b" onClick={() => hideTranslation(m.id)} aria-label="Çeviriyi gizle" title="Gizle">
          <Icon name="x" size={11} sw={2} />
        </button>
      </div>
      {!t.same && <p>{t.text}</p>}
    </div>
  );
}

/** Mesaj üstü düğmeler için: gelen, metinli mesaj çevrilebilir */
export const canTranslate = (m: Message) => !m.fromMe && !m.deleted && m.text.trim().length > 1;

/** Sohbetin karşı tarafının dili: son gelen mesajlardan (arayüz dili Türkçe) */
export function chatLang(messages: Message[]): string | null {
  const texts = messages.filter((m) => !m.fromMe && m.text.trim().length > 3).slice(-15).map((m) => m.text);
  const g = dominantLanguage(texts);
  return g.lang && g.confidence >= 0.5 ? g.lang : null;
}

const COMMON = ['en', 'de', 'fr', 'es', 'it', 'ru', 'ar', 'nl', 'pl', 'az'];

/**
 * "Çevir ve gönder": yazılan (Türkçe) metin karşı tarafın diline çevrilir, önizleme düzenlenebilir; Gönder ile çeviri gider,
 * "Metne koy" yazma alanına bırakır. Hedef dil sohbetten algılanır, değiştirilebilir.
 */
export function ComposeTranslate({ chat, messages, text, setText, onSend, disabled }: { chat: Chat; messages: Message[]; text: string; setText: (t: string) => void; onSend: (t: string) => void; disabled?: boolean }) {
  const detected = useMemo(() => chatLang(messages), [messages]);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string>(detected && detected !== 'tr' ? detected : 'en');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [engine, setEngine] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (detected && detected !== 'tr') setTarget(detected);
  }, [detected, chat.id]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setOpen(false));
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const run = (to = target) => {
    const src = text.trim();
    if (!src) {
      setErr('Önce Türkçe yanıtını yaz, sonra çevir.');
      setOut(null);
      return;
    }
    setBusy(true);
    setErr(null);
    mlApi
      .translateText(src, to, detectLanguage(src).lang ?? 'tr')
      .then((r) => {
        setOut(r.text);
        setEngine('Google Çeviri ile');
      })
      .catch((e) => (setErr((e as Error).message), setOut(null)))
      .finally(() => setBusy(false));
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) run();
  };
  return (
    <span className="ctr-anchor" ref={boxRef}>
      <button className={`btn ghost sm icon b ${open ? 'soft' : ''}`} onClick={toggle} disabled={disabled} aria-label="Çevir ve gönder" title={`Çevir ve gönder${detected && detected !== 'tr' ? ` (${langName(detected)})` : ''}`} aria-expanded={open}>
        <Icon name="translate" size={16} />
      </button>
      {open && (
        <div className="ctr-pop" role="dialog" aria-label="Çevir ve gönder">
          <div className="ctr-head">
            <Icon name="translate" size={14} />
            <b>Çevir ve gönder</b>
            <select
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                run(e.target.value);
              }}
              aria-label="Hedef dil"
            >
              {[...new Set([target, ...(detected && detected !== 'tr' ? [detected] : []), ...COMMON])].map((l) => (
                <option key={l} value={l}>
                  {langName(l)}
                  {l === detected ? ' (sohbetin dili)' : ''}
                </option>
              ))}
            </select>
          </div>
          {busy ? (
            <div className="ctr-busy">
              <span className="spin" /> Çevriliyor…
            </div>
          ) : err ? (
            <div className="ctr-err">{err}</div>
          ) : out !== null ? (
            <>
              <textarea value={out} onChange={(e) => setOut(e.target.value)} rows={3} aria-label="Çeviri önizlemesi" />
              <div className="ctr-note">
                Orijinal: <span>{text.trim()}</span>
                {engine ? <em> · {engine} çevrildi</em> : null}
              </div>
              <div className="ctr-actions">
                <button type="button" className="btn ghost xs b" onClick={() => (setText(out), setOpen(false))}>
                  Metne koy
                </button>
                <button type="button" className="btn primary xs b" disabled={!out.trim()} onClick={() => (onSend(out.trim()), setOpen(false), setOut(null))}>
                  <Icon name="send" size={13} /> Gönder
                </button>
              </div>
            </>
          ) : null}
        </div>
      )}
    </span>
  );
}

/** Sağ panel: bu sohbette yabancı dildeki mesajları kendiliğinden çevir */
export function AutoTranslateRow({ chatId }: { chatId: string }) {
  const on = useAutoTranslate(chatId);
  return (
    <div className="ctx-sec">
      <span className="label">Çeviri</span>
      <div className="auto-tr-row">
        <span>
          <b>Otomatik çevir</b>
          <em>Yabancı dildeki mesajların altında Türkçe çevirisi</em>
        </span>
        <button type="button" role="switch" aria-checked={on} aria-label="Otomatik çevir" className={`sw ${on ? 'on' : ''}`} onClick={() => setAutoTranslate(chatId, !on)} />
      </div>
    </div>
  );
}
