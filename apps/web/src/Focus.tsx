import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { PLATFORMS, type Chat, type DraftResult } from './types';
import { Avatar, Chip, Icon, ago, agoLong } from './ui';
import { PROFILE_NAME } from './profile';
import { useAiPrefs } from './ai-prefs';

/**
 * Odak modu: yanıt bekleyenler (en eskiden yeniye), her biri için AI taslağı ve tek tıkla gönderme.
 * Sağda: verdiğin sözler (AI aksiyonlarından), senin beklediklerin (son mesaj senin, 2+ gün cevap yok), sessize alınanlar.
 */
export function Focus({
  waiting,
  chats,
  ai,
  notify,
  onOpen,
  onBack,
  onMenu,
}: {
  waiting: Chat[];
  chats: Chat[];
  ai: boolean;
  notify: (t: string, err?: boolean) => void;
  onOpen: (id: string) => void;
  onBack: () => void;
  onMenu?: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, DraftResult | 'loading' | 'error'>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const aiP = useAiPrefs();
  const draftOn = ai && aiP.drafts;

  const hour = new Date().getHours();
  const greet = hour < 6 ? 'İyi geceler' : hour < 12 ? 'Günaydın' : hour < 18 ? 'İyi günler' : 'İyi akşamlar';
  const dateStr = new Date().toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });

  // Senin beklediklerin: son mesajı sen atmışsın, 2 gündür cevap yok (lastPreview senin mesajın → unread 0 ve eski)
  const awaiting = useMemo(() => chats.filter((c) => c.lastFromMe && c.unread === 0 && c.kind === 'direct' && Date.now() - c.lastMessageAt > 2 * 86_400_000 && c.lastMessageAt > 0).sort((a, b) => a.lastMessageAt - b.lastMessageAt).slice(0, 4), [chats]);
  // Sessize alınanlar: grup/kanallar ve "sessiz" etiketliler
  const muted = useMemo(() => chats.filter((c) => c.kind !== 'direct' || c.tags.includes('sessiz')), [chats]);
  const mutedGroups = muted.filter((c) => c.kind === 'group').length;
  const mutedChannels = muted.filter((c) => c.kind === 'channel').length;

  // AI açıksa ilk 3 bekleyen için taslak üret (taslak ve aksiyon çıkarma ikisi de kapalıysa hiç çağırma)
  useEffect(() => {
    if (!ai || (!aiP.drafts && !aiP.actions)) return;
    for (const c of waiting.slice(0, 3)) {
      if (drafts[c.id]) continue;
      setDrafts((d) => ({ ...d, [c.id]: 'loading' }));
      api
        .draft(c.id)
        .then((r) => setDrafts((d) => ({ ...d, [c.id]: r })))
        .catch(() => setDrafts((d) => ({ ...d, [c.id]: 'error' })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai, aiP.drafts, aiP.actions, waiting.map((c) => c.id).join(',')]);

  const actions = useMemo(() => {
    const out: Array<{ chat: Chat; text: string }> = [];
    for (const c of waiting) {
      const d = drafts[c.id];
      if (aiP.actions && d && typeof d === 'object') for (const a of d.actions) out.push({ chat: c, text: a });
    }
    return out.slice(0, 5);
  }, [drafts, waiting, aiP.actions]);

  async function sendDraft(c: Chat) {
    const d = drafts[c.id];
    if (!d || typeof d !== 'object' || !d.draft) return;
    setSending(c.id);
    try {
      await api.send(c.id, d.draft);
      await api.markRead(c.id);
      setDone((x) => ({ ...x, [c.id]: true }));
      notify(`${c.name} için taslak gönderildi`);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setSending(null);
    }
  }

  const visible = waiting.filter((c) => !done[c.id]);

  return (
    <section className="focus" aria-label="Odak modu">
      <div className="top">
        {onMenu && (
          <button className="btn icon b b2" aria-label="Menü" title="Menü" onClick={onMenu}>
            <Icon name="grip" size={16} sw={2} />
          </button>
        )}
        <button className="btn b b2" onClick={onBack}>
          <Icon name="back" size={15} sw={2} /> Gelen kutusu <span className="kbd">Esc</span>
        </button>
        <span style={{ flexGrow: 1 }} />
        <span style={{ fontSize: 13, color: 'var(--text3)' }}>{dateStr}</span>
        <Avatar name={PROFILE_NAME} size={34} />
      </div>

      <div className="focus-hero">
        <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span className="chip" style={{ alignSelf: 'flex-start', background: 'var(--v-soft)', color: 'var(--v-txt)' }}>
            <Icon name="sparkle" size={13} color="#6C47FF" sw={2} /> Odak · günlük özet
          </span>
          <h1>
            {greet}, <em>{PROFILE_NAME}.</em>
          </h1>
          <p className="lead">
            {visible.length > 0 ? `${visible.length} kişi yanıtını bekliyor` : 'Yanıt bekleyen kimse yok'}
            {actions.length > 0 ? `, ${actions.length} sözün var` : ''}. {muted.length > 0 ? 'Gerisini sessize aldık.' : 'Harika gidiyorsun.'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <div className="stat lime">
            <span className="n">{visible.length}</span>
            <span className="t">Yanıt bekleyen</span>
          </div>
          <div className="stat">
            <span className="n">{actions.length}</span>
            <span className="t">Verdiğin söz</span>
          </div>
          <div className="stat">
            <span className="n">{muted.length}</span>
            <span className="t">Sessize alınan</span>
          </div>
        </div>
      </div>

      <div className="focus-cols">
        <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: -0.3 }}>Yanıt bekleyenler</h2>
            {visible.length > 0 && <span className="pill lime">{visible.length}</span>}
            <span style={{ flexGrow: 1 }} />
            <span style={{ fontSize: 12.5, color: 'var(--text3)' }}>En eskiden yeniye</span>
          </div>
          {visible.length === 0 && <div className="empty card">Şu an yanıt bekleyen kimse yok. Yeni mesaj gelince burada görünür.</div>}
          {visible.map((c, i) => {
            const d = drafts[c.id];
            const draft = typeof d === 'object' ? d : null;
            return (
              <div key={c.id} className={`fcard ${i === 0 ? 'hot' : ''}`}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span className="avwrap">
                    <Avatar name={c.name} size={42} url={c.avatarUrl} />
                    <Chip platform={c.platform} size={17} ring="#fff" />
                  </span>
                  <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 600 }}>{c.name}</span>
                      <span style={{ fontSize: 12, color: 'var(--text3)' }}>
                        {PLATFORMS[c.platform].name}
                        {c.tags[0] ? ` · ${c.tags[0]}` : ''}
                      </span>
                    </div>
                    <span className="q">“{c.lastPreview}”</span>
                  </div>
                  <span className="wait">
                    <Icon name="clock" size={12} sw={2} />
                    {agoLong(c.lastMessageAt)}
                  </span>
                  <button className="btn sm icon b b2" aria-label="Sohbeti aç" onClick={() => onOpen(c.id)}>
                    <Icon name="chev" size={14} sw={2} />
                  </button>
                </div>

                {draftOn && (
                  <div className="fdraft">
                    <span className="h">
                      <Icon name="sparkle" size={13} color="#6C47FF" sw={2} /> Taslak · senin tarzında
                    </span>
                    {d === 'loading' && (
                      <span style={{ color: 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <span className="spin" /> Yazılıyor…
                      </span>
                    )}
                    {d === 'error' && <span style={{ color: 'var(--text3)' }}>Taslak üretilemedi.</span>}
                    {draft && <span>{draft.draft}</span>}
                    {!d && (
                      <button
                        className="btn sm b b2"
                        style={{ alignSelf: 'flex-start' }}
                        onClick={() => {
                          setDrafts((x) => ({ ...x, [c.id]: 'loading' }));
                          api.draft(c.id).then((r) => setDrafts((x) => ({ ...x, [c.id]: r }))).catch(() => setDrafts((x) => ({ ...x, [c.id]: 'error' })));
                        }}
                      >
                        Taslak yaz
                      </button>
                    )}
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {draftOn && draft?.draft ? (
                    <button className="btn lime b" onClick={() => sendDraft(c)} disabled={sending === c.id}>
                      {sending === c.id ? <span className="spin" /> : <Icon name="send" size={15} sw={1.9} />} Taslağı gönder
                    </button>
                  ) : (
                    <button className="btn primary b" onClick={() => onOpen(c.id)}>
                      <Icon name="pen" size={14} sw={2} /> Yanıtla
                    </button>
                  )}
                  {draftOn && draft?.draft && (
                    <button className="btn b b2" onClick={() => onOpen(c.id)}>
                      <Icon name="pen" size={14} /> Düzenle
                    </button>
                  )}
                  <span style={{ flexGrow: 1 }} />
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text3)' }}>
                    <Chip platform={c.platform} size={15} /> {PLATFORMS[c.platform].name} ile yanıtlanır
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="fside">
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <h2 style={{ flexGrow: 1 }}>Verdiğin sözler</h2>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>{!ai ? 'AI kapalı' : aiP.actions ? 'mesajlardan çıkarıldı' : 'aksiyon çıkarma kapalı'}</span>
            </div>
            {actions.length === 0 && <span style={{ fontSize: 13, color: 'var(--text3)' }}>{ai && !aiP.actions ? 'Ayarlar → AI özelliklerinden “Aksiyon çıkarma”yı açınca sözlerin burada listelenir.' : ai ? 'Henüz çıkarılan bir söz yok.' : 'ANTHROPIC_API_KEY ile sözlerin mesajlardan otomatik çıkarılır.'}</span>}
            {actions.map((a, i) => (
              <label key={i} className="todo" style={{ background: 'var(--bg2)', border: 0 }}>
                <input type="checkbox" />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontWeight: 500 }}>{a.text}</span>
                  <span style={{ fontSize: 12, color: 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Chip platform={a.chat.platform} size={14} /> {a.chat.name}
                  </span>
                </span>
              </label>
            ))}
          </div>

          <div className="card">
            <h2>Senin beklediklerin</h2>
            {awaiting.length === 0 && <span style={{ fontSize: 13, color: 'var(--text3)' }}>Cevabını beklediğin bir sohbet yok.</span>}
            {awaiting.map((c) => (
              <button key={c.id} className="wrow" style={{ background: 'transparent', border: 0, padding: 0, textAlign: 'left' }} onClick={() => onOpen(c.id)}>
                <Avatar name={c.name} size={30} url={c.avatarUrl} />
                <span style={{ flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name} · “{c.lastPreview.slice(0, 40)}”</span>
                <span className="d">{ago(c.lastMessageAt)}</span>
              </button>
            ))}
            {awaiting.length > 0 && (
              <button className="btn b b2" style={{ alignSelf: 'flex-start' }} onClick={() => onOpen(awaiting[0].id)}>
                <Icon name="sparkle" size={14} color="#6C47FF" sw={2} /> Nazik hatırlatma yaz
              </button>
            )}
          </div>

          <div className="muted">
            <h2>
              <Icon name="eyeoff" size={17} color="#fff" sw={2} /> {muted.length} sohbet sessize alındı
            </h2>
            <p>Gruplar, kanallar ve “sessiz” etiketliler odağın dışında tutuluyor. Önemli bir şey kaçmadı.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {mutedGroups > 0 && <span className="chip">Gruplar · {mutedGroups}</span>}
              {mutedChannels > 0 && <span className="chip">Kanallar · {mutedChannels}</span>}
              {muted.length - mutedGroups - mutedChannels > 0 && <span className="chip">Sessiz · {muted.length - mutedGroups - mutedChannels}</span>}
            </div>
            <button className="btn b b2" style={{ alignSelf: 'flex-start', color: 'var(--v-txt)' }} onClick={onBack}>
              Gözden geçir
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 22, fontSize: 12.5, color: 'var(--text3)', marginTop: 'auto' }}>
        <span>
          <span className="kbd">Esc</span> gelen kutusu
        </span>
      </div>
    </section>
  );
}
