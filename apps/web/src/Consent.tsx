import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isTauri, openExternal } from './desktop';
import { Icon, Logo } from './ui';
import { USE_STATIC } from './api';
import { LEGAL_URLS, REQUIRED_CONSENTS, registerAiConsentAsker, requireAiConsent, saveConsent, useConsent, type ConsentKey } from './consent-store';
import './consent.css';

/* Yasal onay arayüzü (01.10): lisans ekranındaki zorunlu kutular, sürüm değişince onay ekranı, ilk AI kullanımında açık rıza
   penceresi, Ayarlar → Hakkında → Onaylarım. Metinler mivelo.app'te (kosullar/kvkk/acik-riza.html). */

/** Uygulama içinden yasal metni sistem tarayıcısında aç */
export function LegalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

const LABELS: Record<Exclude<ConsentKey, 'ai'>, ReactNode> = {
  terms: (
    <>
      <LegalLink href={LEGAL_URLS.terms}>Kullanım Koşulları ve Son Kullanıcı Lisans Sözleşmesi</LegalLink>’ni okudum, kabul ediyorum.
    </>
  ),
  kvkk: (
    <>
      Kişisel verilerimin işlenmesine ilişkin <LegalLink href={LEGAL_URLS.kvkk}>KVKK Aydınlatma Metni</LegalLink>’ni okudum, bilgilendim.
    </>
  ),
  risk: (
    <>
      WhatsApp, Instagram, Messenger, X, LinkedIn ve TikTok gibi uygulamalara <b>resmi olmayan yöntemlerle</b> bağlanıldığını; bunun hesabımın kısıtlanması ya da kapatılması riskini taşıdığını ve
      bu riskin sorumluluğunun bende olduğunu anladım.
    </>
  ),
};

export type ConsentChecked = Partial<Record<ConsentKey, boolean>>;
export const allRequiredChecked = (c: ConsentChecked, keys: ConsentKey[] = REQUIRED_CONSENTS) => keys.every((k) => c[k]);

/** Zorunlu onay kutuları (önceden işaretli DEĞİL); keys: yalnız sorulacaklar (sürümü değişenler) */
export function ConsentChecks({ value, onChange, keys = REQUIRED_CONSENTS }: { value: ConsentChecked; onChange: (v: ConsentChecked) => void; keys?: ConsentKey[] }) {
  return (
    <div className="cs-checks" role="group" aria-label="Onaylar">
      {keys
        .filter((k): k is Exclude<ConsentKey, 'ai'> => k !== 'ai')
        .map((k) => (
          <label key={k} className="cs-chk">
            <input type="checkbox" checked={!!value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.checked })} />
            <span>{LABELS[k]}</span>
          </label>
        ))}
      <p className="cs-fine">
        Yapay zekâ özellikleri isteğe bağlıdır; içeriğin yurt dışına aktarılması için <LegalLink href={LEGAL_URLS.consent}>açık rızan</LegalLink> ilk kullanımda ayrıca sorulur.
      </p>
    </div>
  );
}

/** Lisans geçerli ama koşullar yeni sürümde (ya da hiç onaylanmamış): uygulamaya girmeden önce */
export function ConsentScreen({ needed, onDone }: { needed: ConsentKey[]; onDone: () => void }) {
  const st = useConsent();
  const [checked, setChecked] = useState<ConsentChecked>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const updated = needed.some((k) => st.accepted[k]);
  const submit = async () => {
    if (!allRequiredChecked(checked, needed) || busy) return;
    setBusy(true);
    setErr('');
    try {
      const s = await saveConsent({ accept: needed });
      if (s.needed.length) throw new Error('Onaylar kaydedilemedi; yeniden dene');
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-screen">
      <form
        className="auth-card cs-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="brand">
          <Logo size={36} />
          <span>mivelo</span>
        </div>
        <h1>{updated ? 'Koşullar güncellendi' : 'Başlamadan önce'}</h1>
        <p>{updated ? 'Devam etmek için güncellenen metinleri okuyup onayla. Mesajların ve bağlı uygulamaların bu bilgisayarda duruyor.' : "Mivelo'yu kullanmaya başlamadan önce aşağıdakileri okuyup onayla."}</p>
        <ConsentChecks value={checked} onChange={setChecked} keys={needed} />
        {err && (
          <div className="auth-error" role="alert">
            <Icon name="alert" size={14} sw={2} /> {err}
          </div>
        )}
        <button className="btn primary b" type="submit" disabled={busy || !allRequiredChecked(checked, needed)}>
          {busy ? 'Kaydediliyor…' : 'Onayla ve devam et'}
        </button>
      </form>
    </div>
  );
}

/**
 * İlk bulut AI kullanımında açık rıza penceresi (requireAiConsent bekler). Kutu işaretlenmeden "Rıza veriyorum" basılamaz;
 * "Vazgeç" AI çağrısını iptal eder (hiçbir içerik gönderilmez).
 */
export function AiConsentHost() {
  const [pending, setPending] = useState<((ok: boolean) => void) | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const queue = useRef<Array<(ok: boolean) => void>>([]);
  useEffect(() => {
    registerAiConsentAsker((resolve) => {
      queue.current.push(resolve);
      setPending(() => (ok: boolean) => queue.current.splice(0).forEach((r) => r(ok)));
    });
    return () => registerAiConsentAsker(null);
  }, []);
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  if (!pending) return null;
  function close(ok: boolean) {
    pending?.(ok);
    setPending(null);
    setChecked(false);
    setBusy(false);
  }
  const accept = async () => {
    setBusy(true);
    const s = await saveConsent({ ai: true }).catch(() => null);
    close(!!s?.ai);
  };
  return (
    <div className="overlay cs-ov" onMouseDown={() => close(false)}>
      <div className="modal cs-modal" role="dialog" aria-modal="true" aria-labelledby="csAiT" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cs-ic" aria-hidden="true">
          <Icon name="sparkle" size={20} sw={2} />
        </div>
        <h3 id="csAiT">Yapay zekâ için açık rıza</h3>
        <p>Bu özellik, istediğin işlem için ilgili sohbetin son mesajlarını (gönderen adları ve metinler) bilgisayarından doğrudan kendi Anthropic API anahtarınla Anthropic’e (ABD) gönderir. Mivelo sunucularından geçmez.</p>
        <ul>
          <li>ABD’de Türkiye’dekine denk bir veri koruma düzeyi bulunmayabilir.</li>
          <li>Mesajlarda başkalarına ait bilgiler de bulunabilir; göndermeden önce buna hakkın olduğundan emin ol.</li>
          <li>Rıza isteğe bağlıdır; vermezsen yapay zekâ dışındaki her şey çalışır. Ayarlar → Hakkında → Onaylarım’dan geri çekebilirsin.</li>
        </ul>
        <label className="cs-chk">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} autoFocus />
          <span>
            <LegalLink href={LEGAL_URLS.consent}>Açık Rıza Metni</LegalLink>’ni okudum; yapay zekâ özelliklerini kullandığımda ilgili içeriğin Anthropic’e (yurt dışına) aktarılmasına açık rıza veriyorum.
          </span>
        </label>
        <div className="cs-actions">
          <button type="button" className="btn ghost b b2" onClick={() => close(false)}>
            Vazgeç
          </button>
          <button type="button" className="btn primary b b2" disabled={!checked || busy} onClick={() => void accept()}>
            {busy ? 'Kaydediliyor…' : 'Rıza veriyorum'}
          </button>
        </div>
      </div>
    </div>
  );
}

const fmtDate = (at?: number) => (at ? new Date(at).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

/** Ayarlar → Hakkında → Onaylarım: kabul tarihleri, AI açık rızasını ver/geri çek */
export function ConsentPane({ notify }: { notify?: (t: string, err?: boolean) => void }) {
  const st = useConsent();
  const [busy, setBusy] = useState(false);
  const rows: Array<[string, ConsentKey]> = [
    ['Kullanım Koşulları ve EULA', 'terms'],
    ['KVKK Aydınlatma Metni', 'kvkk'],
    ['Resmi olmayan bağlantı riski', 'risk'],
  ];
  const toggleAi = async () => {
    setBusy(true);
    try {
      // vermek: masaüstü/yerelde metinli onay penceresinden (kutu işaretlenmeden verilemez); statik demoda pencere yok
      if (!st.ai && !USE_STATIC) {
        if (await requireAiConsent()) notify?.('Açık rıza verildi');
        return;
      }
      const s = await saveConsent({ ai: !st.ai });
      notify?.(s.ai ? 'Açık rıza verildi' : 'Açık rıza geri çekildi; içerik artık Anthropic’e gönderilmez');
    } catch (e) {
      notify?.((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="set-group cs-pane">
      {/* zorunlu onaylar yalnız masaüstünde istenir; web'de yalnız AI rızası satırı */}
      {rows.filter(([, k]) => isTauri || st.accepted[k]).map(([label, k]) => {
        const e = st.accepted[k];
        return (
          <div key={k} className="set-row">
            <span className="set-txt">
              <b>{label}</b>
              <em>{e ? `${k === 'kvkk' ? 'Okundu' : k === 'risk' ? 'Anlaşıldı' : 'Kabul edildi'} · ${fmtDate(e.at)} · sürüm ${e.v}` : 'Henüz onaylanmadı'}</em>
            </span>
          </div>
        );
      })}
      <div className="set-row">
        <span className="set-txt">
          <b>Yapay zekâ açık rızası</b>
          <em>
            {st.ai ? `Verildi · ${fmtDate(st.accepted.ai?.at)}` : st.accepted.aiRevokedAt ? `Geri çekildi · ${fmtDate(st.accepted.aiRevokedAt)}` : 'Verilmedi (isteğe bağlı)'} ·{' '}
            <LegalLink href={LEGAL_URLS.consent}>metni oku</LegalLink>
          </em>
        </span>
        <span className="set-ctl">
          <button type="button" className={`btn ${st.ai ? 'ghost' : 'soft'} xs b b2`} disabled={busy} onClick={() => void toggleAi()}>
            {st.ai ? 'Geri çek' : 'Rıza ver'}
          </button>
        </span>
      </div>
    </div>
  );
}
