import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { PLATFORMS, type Chat, type DraftResult } from './types';
import { Avatar, Chip, Icon, ago, agoLong } from './ui';
import { PROFILE_NAME } from './profile';
import { useAiPrefs } from './ai-prefs';

/**
 * Odak modu: yanıt bekleyenler (en yeniden eskiye), her biri için AI taslağı ve tek tıkla gönderme.
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
  onOpen: (id: string, seed?: { text?: string; autoDraft?: boolean }) => void;
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

  // Taslaklar yalnız istenince ("Taslak yaz") üretilir: sohbet içeriği Anthropic'e ancak kullanıcı isteyince gider.
  // Ayarlar → AI → "Odak'ta taslakları kendiliğinden hazırla" açıksa ilk 3 bekleyen için önceden hazırlanır.
  useEffect(() => {
    if (!ai || !aiP.focusAuto || (!aiP.drafts && !aiP.actions)) return;
    for (const c of waiting.slice(0, 3)) {
      if (drafts[c.id]) continue;
      setDrafts((d) => ({ ...d, [c.id]: 'loading' }));
      api
        .draft(c.id)
        .then((r) => setDrafts((d) => ({ ...d, [c.id]: r })))
        .catch(() => setDrafts((d) => ({ ...d, [c.id]: 'error' })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai, aiP.focusAuto, aiP.drafts, aiP.actions, waiting.map((c) => c.id).join(',')]);

  const actions = useMemo(() => {
    const out: Array<{ chat: Chat; text: string }> = [];
    for (const c of waiting) {
      const d = drafts[c.id];
      if (aiP.actions && d && typeof d === 'object') for (const a of d.actions) out.push({ chat: c, text: a });
    }
    return out.slice(0, 5);
  }, [drafts, waiting, aiP.actions]);

  // Satır içi yanıt: sohbeti açmadan buradan yaz ve gönder (yanıt mesajın geldiği uygulamadan gider)
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const openReply = (c: Chat, text = '') => {
    setReplyFor(c.id);
    setReplyText(text);
    requestAnimationFrame(() => {
      const el = replyRef.current;
      if (el) (el.focus(), el.setSelectionRange(el.value.length, el.value.length));
    });
  };
  async function sendReply(c: Chat) {
    const text = replyText.trim();
    if (!text || sending) return;
    setSending(c.id);
    try {
      await api.send(c.id, text);
      await api.markRead(c.id).catch(() => undefined);
      setDone((x) => ({ ...x, [c.id]: true }));
      setReplyFor(null);
      setReplyText('');
      notify(`${PLATFORMS[c.platform].name} ile gönderildi · ${c.name} listeden çıktı`);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setSending(null);
    }
  }

  // Verdiğin sözler: işaretlenenler cihazda hatırlanır
  const [kept, setKept] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('mivelo.promisesDone') || '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggleKept = (key: string) =>
    setKept((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem('mivelo.promisesDone', JSON.stringify([...next].slice(-300)));
      } catch {
        /* yok */
      }
      return next;
    });

  async function sendDraft(c: Chat) {
    const d = drafts[c.id];
    if (!d || typeof d !== 'object' || !d.draft) return;
    setSending(c.id);
    try {
      await api.send(c.id, d.draft);
      await api.markRead(c.id);
      setDone((x) => ({ ...x, [c.id]: true }));
      notify(`${PLATFORMS[c.platform].name} ile gönderildi · ${c.name} listeden çıktı`);
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
            <Icon name="sparkle" size={13} color="var(--v)" sw={2} /> Odak · günlük özet
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
            <span style={{ fontSize: 12.5, color: 'var(--text3)' }}>En yeniden eskiye</span>
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
                    <Chip platform={c.platform} size={17} ring="var(--card)" />
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
                      <Icon name="sparkle" size={13} color="var(--v)" sw={2} /> Taslak · senin tarzında
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

                {replyFor === c.id && (
                  <div className="freply">
                    <textarea
                      ref={replyRef}
                      rows={2}
                      value={replyText}
                      placeholder={`${c.name} için yanıt yaz… (Enter gönderir, Shift+Enter yeni satır)`}
                      onChange={(e) => setReplyText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), void sendReply(c));
                        if (e.key === 'Escape') (e.stopPropagation(), setReplyFor(null));
                      }}
                    />
                    <div className="freply-bar">
                      <button className="btn ghost sm b" onClick={() => onOpen(c.id, replyText.trim() ? { text: replyText } : undefined)}>
                        Sohbette aç
                      </button>
                      <span style={{ flexGrow: 1 }} />
                      <button className="btn ghost sm b" onClick={() => setReplyFor(null)}>
                        Vazgeç
                      </button>
                      <button className="btn lime sm b" onClick={() => sendReply(c)} disabled={!replyText.trim() || sending === c.id}>
                        {sending === c.id ? <span className="spin" /> : <Icon name="send" size={14} sw={1.9} />} Gönder
                      </button>
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {replyFor === c.id ? null : draftOn && draft?.draft ? (
                    <button className="btn lime b" onClick={() => sendDraft(c)} disabled={sending === c.id}>
                      {sending === c.id ? <span className="spin" /> : <Icon name="send" size={15} sw={1.9} />} Taslağı gönder
                    </button>
                  ) : (
                    <button className="btn primary b" onClick={() => openReply(c)}>
                      <Icon name="pen" size={14} sw={2} /> Yanıtla
                    </button>
                  )}
                  {replyFor !== c.id && draftOn && draft?.draft && (
                    <button className="btn b b2" onClick={() => openReply(c, draft.draft)}>
                      <Icon name="pen" size={14} /> Düzenle
                    </button>
                  )}
                  <span style={{ flexGrow: 1 }} />
                  <span className="via" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text3)' }}>
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
            {actions.length === 0 && <span style={{ fontSize: 13, color: 'var(--text3)' }}>{ai && !aiP.actions ? 'Ayarlar → AI özelliklerinden “Aksiyon çıkarma”yı açınca sözlerin burada listelenir.' : ai ? 'Bir sohbet için “Taslak yaz” dediğinde o sohbetteki sözlerin burada listelenir.' : 'Ayarlar → AI özelliklerinden Anthropic anahtarını ekleyince sözlerin mesajlardan çıkarılır.'}</span>}
            {actions.map((a, i) => (
              <label key={i} className={`todo ${kept.has(`${a.chat.id}|${a.text}`) ? 'kept' : ''}`} style={{ background: 'var(--bg2)', border: 0 }}>
                <input type="checkbox" checked={kept.has(`${a.chat.id}|${a.text}`)} onChange={() => toggleKept(`${a.chat.id}|${a.text}`)} />
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
              <button className="btn b b2" style={{ alignSelf: 'flex-start' }} onClick={() => onOpen(awaiting[0].id, { autoDraft: true })} title={`${awaiting[0].name} için hatırlatma taslağı`}>
                <Icon name="sparkle" size={14} color="var(--v)" sw={2} /> Nazik hatırlatma yaz
              </button>
            )}
          </div>

          <div className="muted">
            <h2>
              <Icon name="eyeoff" size={17} color="#fff" sw={2} /> {muted.length} sohbet odak dışında
            </h2>
            <p>Gruplar, kanallar ve “sessiz” etiketliler bu listede yer almıyor; gelen kutusunda duruyorlar.</p>
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
