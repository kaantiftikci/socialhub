import { useState } from 'react';
import { api, type QuestionDraftResult } from './api';
import { PLATFORMS, type Chat } from './types';
import { Icon } from './ui';
import { requireAiConsent } from './consent-store';

/** Ayarlar penceresini belirli bölümde aç (App dinler) */
export function openSettingsTab(tab: 'ai' | 'notify'): void {
  window.dispatchEvent(new CustomEvent('mivelo-open-settings', { detail: tab }));
}

/** Pazaryeri müşteri sorusu mu (sipariş sayfası değil): AI yanıt taslağı düğmesi burada görünür */
export function isShopQuestion(chat: Chat): boolean {
  return PLATFORMS[chat.platform]?.category === 'shop' && !chat.meta?.order && !!chat.meta?.question;
}

/**
 * "AI ile yanıt taslağı": ürün bilgisi, aynı ürüne verilmiş eski cevaplar, satıcının üslubu ve pazaryeri kurallarıyla (telefon,
 * e-posta, harici bağlantı yok) taslak üretir, yazma alanına koyar. Otomatik gönderim YOK. Anahtar yoksa Ayarlar → AI'ye götürür.
 */
export function QuestionDraftBar({ chat, ai, onDraft, notify }: { chat: Chat; ai: boolean; onDraft: (text: string) => void; notify: (t: string, err?: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<QuestionDraftResult | null>(null);
  const run = async () => {
    if (!(await requireAiConsent())) return;
    setBusy(true);
    try {
      const r = await api.questionDraft(chat.id);
      setRes(r);
      if (r.draft) onDraft(r.draft);
      else notify('AI boş taslak döndürdü; yeniden dene', true);
    } catch (e) {
      const msg = (e as Error).message;
      if (/anahtar/i.test(msg)) openSettingsTab('ai');
      notify(msg, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="comp-top qd-bar">
      {ai ? (
        <button type="button" className="aipill b b2" onClick={() => void run()} disabled={busy} title="Ürün bilgisi, aynı ürüne verdiğin eski cevaplar ve pazaryeri kurallarıyla taslak yazar; göndermeden önce düzenleyebilirsin">
          {busy ? <span className="spin" /> : <Icon name="sparkle" size={13} color="var(--v)" sw={2} />} {res ? 'Yeniden yaz' : 'AI ile yanıt taslağı'}
        </button>
      ) : (
        <button type="button" className="aipill b b2" onClick={() => openSettingsTab('ai')} title="Ayarlar → AI özellikleri → Anthropic anahtarı">
          <Icon name="lock" size={13} sw={2} /> AI anahtarı gerekli
        </button>
      )}
      <span className="ctx-n">· {PLATFORMS[chat.platform].name} kurallarına uygun, iletişim bilgisi içermez</span>
      {res && (
        <div className="qd-info">
          {res.sameProduct > 0 && <span>Bu ürüne verdiğin {res.sameProduct} cevap dikkate alındı.</span>}
          {res.removed.length > 0 && (
            <span className="warn">
              <Icon name="alert" size={12} sw={2} /> Taslaktan çıkarıldı: {res.removed.join(', ')} (pazaryeri kuralı)
            </span>
          )}
          {res.notes.map((n) => (
            <span key={n} className="note">
              <Icon name="pen" size={12} sw={2} /> {n}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
