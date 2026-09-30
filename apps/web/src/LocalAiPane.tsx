import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './ui';
import { mlApi, type MlModel, type MlSettings, type ModelKey } from './ml-api';
import { refreshMlStatus, useMlStatus } from './ml-client';

/**
 * Ayarlar → Yerel AI modelleri: cihazda çalışan modeller (konuşma tanıma, anlamsal arama).
 * Her model yalnız kullanıcı "İndir" deyip boyutu onaylayınca Hugging Face'ten iner; ilerleme canlı (ml.status olayı).
 */
const DESC: Record<ModelKey, string> = {
  whisper: 'WhatsApp, Telegram ve iMessage sesli mesajlarının altında metin; metin aramada da bulunur.',
  embed: '"Geçen ay Ahmet’in gönderdiği fatura" gibi doğal dille arama (⌘K → Anlamsal).',
};

function Row({ title, hint, children, dim }: { title: string; hint?: ReactNode; children: ReactNode; dim?: boolean }) {
  return (
    <div className={`set-row ${dim ? 'dim' : ''}`}>
      <span className="set-txt">
        <b>{title}</b>
        {hint && <em>{hint}</em>}
      </span>
      <span className="set-ctl">{children}</span>
    </div>
  );
}

function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`sw ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

/**
 * İlerleme çubuğu: dolgu transform scaleX ile (düzen hesabı yok) yumuşak ilerler, aynı indirmede asla geri gitmez;
 * `done` iken %100 + yeşil. `resetKey` değişince (yeni indirme) sıfırdan başlar.
 */
function Progress({ pct, done, thin, resetKey }: { pct: number; done?: boolean; thin?: boolean; resetKey?: string }) {
  const max = useRef({ key: resetKey, v: 0 });
  if (max.current.key !== resetKey) max.current = { key: resetKey, v: 0 };
  max.current.v = Math.max(max.current.v, Math.min(100, Math.max(0, pct)));
  const v = done ? 100 : Math.max(2, max.current.v);
  return (
    <div className={`lai-bar ${thin ? 'thin' : ''} ${done ? 'done' : ''}`} role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <span className="lai-fill" style={{ transform: `scaleX(${v / 100})` }} />
    </div>
  );
}

function ModelCard({ m, runtimeMb, runtimeReady, demo, notify }: { m: MlModel; runtimeMb: number; runtimeReady: boolean; demo?: boolean; notify: (t: string, err?: boolean) => void }) {
  const [ask, setAsk] = useState<'download' | 'remove' | null>(null);
  const act = (p: Promise<unknown>, ok?: string) =>
    p
      .then(() => (ok && notify(ok), refreshMlStatus()))
      .catch((e) => notify((e as Error).message, true))
      .finally(() => setAsk(null));
  // indirme bitince çubuk kısa süre %100 yeşil kalır, "Hazır" rozeti onayla belirir
  const prevState = useRef(m.state);
  const [justDone, setJustDone] = useState(false);
  useLayoutEffect(() => {
    const was = prevState.current;
    prevState.current = m.state;
    if (was !== 'downloading' || m.state !== 'ready') return;
    setJustDone(true);
    const t = window.setTimeout(() => setJustDone(false), 1400);
    return () => window.clearTimeout(t);
  }, [m.state]);
  const size = `${m.approx ? '≈' : ''}${m.sizeMb >= 1000 ? `${(m.sizeMb / 1024).toFixed(1)} GB` : `${m.sizeMb} MB`}`;
  return (
    <div className={`lai-card ${m.state}`}>
      <div className="lai-top">
        <span className="lai-ic" aria-hidden="true">
          <Icon name={m.key === 'whisper' ? 'mic' : 'search'} size={16} />
        </span>
        <span className="lai-txt">
          <b>{m.title}</b>
          <em>{DESC[m.key]}</em>
        </span>
        <span className="lai-state">
          {m.state === 'ready' ? (
            <span className={`lai-ok ${justDone ? 'pop' : ''}`}>
              <Icon name="check" size={12} sw={2.4} /> {demo ? 'Demo: indirilmiş' : 'Hazır'} · {size}
            </span>
          ) : m.state === 'downloading' ? (
            <span className="lai-pct">İndiriliyor %{m.pct}</span>
          ) : (
            <span className="lai-size">{size}</span>
          )}
        </span>
      </div>
      {(m.state === 'downloading' || justDone) && <Progress pct={m.pct} done={m.state === 'ready'} resetKey={m.key} />}
      {m.state === 'error' && m.error && (
        <div className="lai-err">
          <Icon name="alert" size={13} /> {m.error}
        </div>
      )}
      <div className="lai-actions">
        {ask === 'download' ? (
          <>
            <span className="lai-ask">
              {size} indirilecek{runtimeReady ? '' : ` (+ ≈${runtimeMb} MB çalışma zamanı, bir kez)`}. Hugging Face’ten ücretsiz; sonra internetsiz çalışır.
            </span>
            <button type="button" className="btn primary xs b" onClick={() => act(mlApi.download(m.key))}>
              <Icon name="download" size={13} /> İndir
            </button>
            <button type="button" className="btn ghost xs b" onClick={() => setAsk(null)}>
              Vazgeç
            </button>
          </>
        ) : ask === 'remove' ? (
          <>
            <span className="lai-ask">Model silinsin mi? Yazıya dökülmüş metinler ve çeviriler kalır.</span>
            <button type="button" className="btn xs b danger-btn" onClick={() => act(mlApi.remove(m.key), 'Model silindi')}>
              <Icon name="trash" size={13} /> Sil
            </button>
            <button type="button" className="btn ghost xs b" onClick={() => setAsk(null)}>
              Vazgeç
            </button>
          </>
        ) : m.state === 'downloading' ? (
          <button type="button" className="btn ghost xs b" onClick={() => act(mlApi.cancel(m.key))}>
            İptal
          </button>
        ) : m.state === 'ready' ? (
          <button type="button" className="btn ghost xs b" onClick={() => setAsk('remove')}>
            <Icon name="trash" size={13} /> Sil
          </button>
        ) : (
          <button type="button" className="btn xs b" onClick={() => setAsk('download')}>
            <Icon name="download" size={13} /> {m.state === 'error' ? 'Yeniden dene' : 'İndir'}
          </button>
        )}
      </div>
    </div>
  );
}

export function LocalAiPane({ notify }: { notify: (t: string, err?: boolean) => void }) {
  const st = useMlStatus();
  if (!st)
    return (
      <div className="set-group">
        <p className="set-note">
          <span className="spin" /> Yükleniyor…
        </p>
      </div>
    );
  const ready = (k: ModelKey) => st.models.some((m) => m.key === k && m.state === 'ready');
  const save = (p: Partial<MlSettings>) => mlApi.saveSettings(p).then(() => refreshMlStatus()).catch((e) => notify((e as Error).message, true));
  const ix = st.index;
  return (
    <>
      <p className="set-note lai-intro">
        <Icon name="shield" size={14} /> Bu modeller bilgisayarında çalışır: sesli mesajların ve mesajların hiçbir yere gönderilmez. Her biri yalnız sen indirince, bir kez iner.
      </p>
      <div className="lai-list">
        {st.models.map((m) => (
          <ModelCard key={m.key} m={m} runtimeMb={st.runtime.approxMb} runtimeReady={st.runtime.ready} demo={st.demo} notify={notify} />
        ))}
      </div>
      <div className="set-group">
        <Row title="Sesli mesajları kendiliğinden yazıya dök" hint={ready('whisper') ? 'Yeni gelen sesli mesajlar arka planda metne çevrilir' : 'Önce konuşma tanıma modelini indir'} dim={!ready('whisper')}>
          <Switch label="Sesli mesajları kendiliğinden yazıya dök" disabled={!ready('whisper')} on={st.settings.autoTranscribe} onChange={(v) => void save({ autoTranscribe: v })} />
        </Row>
        <Row
          title="Anlamsal arama dizini"
          hint={
            !ready('embed') ? (
              'Önce anlamsal arama modelini indir'
            ) : st.settings.semanticIndex ? (
              <>
                %{ix.pct} dizinlendi ({ix.indexed.toLocaleString('tr-TR')} / {ix.total.toLocaleString('tr-TR')} mesaj){ix.running ? ' · sürüyor' : ''}
              </>
            ) : (
              'Mesajlar arka planda dizinlenir (önce son 12 ay)'
            )
          }
          dim={!ready('embed')}
        >
          <Switch label="Anlamsal arama dizini" disabled={!ready('embed')} on={st.settings.semanticIndex} onChange={(v) => void save({ semanticIndex: v })} />
        </Row>
        {st.settings.semanticIndex && ready('embed') && ix.pct < 100 && (
          <Progress pct={ix.pct} thin resetKey="index" />
        )}
      </div>
      <p className="set-note">Modeller ~/.mivelo/models klasöründe durur. Çalışırken biraz işlemci kullanır; birkaç dakika kullanılmayınca bellekten çıkar.</p>
    </>
  );
}
