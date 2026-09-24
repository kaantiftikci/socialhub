import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { API_BASE } from './desktop';
import { DEFAULT_TAGS, PLATFORMS, type Attachment, type Chat, type DraftResult, type Message, type Participant } from './types';
import { Avatar, Chip, Icon, Resizer, Tag, fmtDay, fmtStamp, fmtTime } from './ui';

type Tone = 'default' | 'short' | 'formal' | 'en';

export function Conversation({
  chat,
  messages,
  ai,
  notify,
  onTags,
  onSnooze,
  onComplete,
  showDetails = true,
  onToggleDetails,
  onOpenChat,
  onLoadOlder,
  hasOlder = false,
  olderBusy = false,
}: {
  chat: Chat;
  messages: Message[];
  ai: boolean;
  notify: (t: string, err?: boolean) => void;
  onTags: (tags: string[]) => void;
  onSnooze: () => void;
  onComplete: () => void;
  showDetails?: boolean;
  onToggleDetails?: () => void;
  onOpenChat?: (c: Chat) => void;
  /** Depodaki daha eski mesajları (100'er) yükle */
  onLoadOlder?: () => void | Promise<void>;
  hasOlder?: boolean;
  olderBusy?: boolean;
}) {
  const [search, setSearch] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (search !== null) searchRef.current?.focus();
  }, [search]);
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [tone, setTone] = useState<Tone>('default');
  const [tagInput, setTagInput] = useState('');
  const [remind, setRemind] = useState(true);
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  useEffect(() => setLightbox(null), [chat.id]);
  const endRef = useRef<HTMLDivElement>(null);
  const msgsRef = useRef<HTMLDivElement>(null);
  const firstIdRef = useRef<string | undefined>(undefined);
  const lastIdRef = useRef<string | undefined>(undefined);
  const chatRef = useRef<string | undefined>(undefined);
  const heightRef = useRef(0);
  const platform = PLATFORMS[chat.platform];

  // Kaydırma: sohbet açılınca en alta; "daha eski mesajlar" başa eklenince okunan yer korunur; yeni mesaj gelince
  // yalnızca zaten alttaysan en alta iner (yukarı kaydırırken sohbet durum/okundu güncellemeleriyle aşağı fırlamaz)
  useEffect(() => {
    const el = msgsRef.current;
    const first = messages[0]?.id;
    const last = messages[messages.length - 1]?.id;
    const chatChanged = chatRef.current !== chat.id;
    chatRef.current = chat.id;
    const prepended = !!el && !!firstIdRef.current && first !== firstIdRef.current && messages.some((m) => m.id === firstIdRef.current);
    if (chatChanged || (lastIdRef.current === undefined && last !== undefined)) endRef.current?.scrollIntoView({ block: 'end' });
    else if (prepended && el) el.scrollTop += el.scrollHeight - heightRef.current;
    else if (el && last !== lastIdRef.current) {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
      if (nearBottom) endRef.current?.scrollIntoView({ block: 'end' });
    }
    firstIdRef.current = first;
    lastIdRef.current = last;
    heightRef.current = el?.scrollHeight ?? 0;
  }, [messages, chat.id]);

  const shown = useMemo(() => {
    const q = (search ?? '').trim().toLocaleLowerCase('tr-TR');
    if (!q) return messages;
    return messages.filter((m) => m.text.toLocaleLowerCase('tr-TR').includes(q) || m.senderName.toLocaleLowerCase('tr-TR').includes(q) || m.attachments?.some((a) => a.name?.toLocaleLowerCase('tr-TR').includes(q)));
  }, [messages, search]);
  const groups = useMemo(() => groupMessages(shown), [shown]);
  const lastIncoming = [...messages].reverse().find((m) => !m.fromMe);
  const needsReply = !!lastIncoming && messages[messages.length - 1]?.id === lastIncoming.id;
  const [mediaOpen, setMediaOpen] = useState(false);
  useEffect(() => setMediaOpen(false), [chat.id]);
  const allShared = useMemo(() => {
    const out: Array<{ att: Attachment; m: Message }> = [];
    for (const m of [...messages].reverse()) for (const att of m.attachments ?? []) out.push({ att, m });
    return out;
  }, [messages]);
  const files = useMemo(() => allShared.slice(0, 4), [allShared]);

  async function makeDraft(t: Tone = tone) {
    setTone(t);
    setDrafting(true);
    try {
      setDraft(await api.draft(chat.id, t));
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setDrafting(false);
    }
  }

  async function send() {
    const body = (text || draft?.draft || '').trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await api.send(chat.id, body);
      setText('');
      setDraft(null);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setSending(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Tab' && draft && !text.trim()) {
      e.preventDefault();
      setText(draft.draft);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <>
      <section className="conv" aria-label="Konuşma">
        <header className="conv-head">
          <span className="avwrap">
            <Avatar name={chat.name} size={40} url={chat.avatarUrl} />
          </span>
          <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <h2 title={chat.name}>{chat.name}</h2>
              {chat.tags.slice(0, 1).map((t) => (
                <Tag key={t} name={t} />
              ))}
            </div>
            <span className="sub">
              <Chip platform={chat.platform} size={15} />
              {platform.name}
              {chat.kind !== 'direct' ? ` · ${chat.kind === 'group' ? 'grup' : 'kanal'}` : ' · sohbet'}
            </span>
          </div>
          <button className={`btn icon b b2 ${search !== null ? 'on' : ''}`} onClick={() => setSearch(search === null ? '' : null)} title="Sohbette ara" aria-label="Ara">
            <Icon name="search" size={15} />
          </button>
          <button className="btn b b2" onClick={onSnooze} title="Yarına ertele">
            <Icon name="clock" size={15} /> <span className="lbl">Ertele</span> <span className="kbd lbl">H</span>
          </button>
          <button className="btn soft b b2" onClick={onComplete} title="Okundu olarak işaretle">
            <Icon name="check" size={15} sw={2} /> <span className="lbl">Tamamla</span> <span className="kbd lbl">E</span>
          </button>
          {onToggleDetails && !showDetails && (
            <button className="btn icon b b2" onClick={onToggleDetails} title="Ayrıntı panelini göster" aria-label="Ayrıntı paneli">
              <Icon name="panel" size={15} />
            </button>
          )}
        </header>
        {search !== null && (
          <div className="chat-search">
            <Icon name="search" size={14} />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setSearch(null)}
              placeholder={`${chat.name} içinde ara…`}
            />
            <span className="cnt">{search.trim() ? `${shown.length} / ${messages.length}` : `${messages.length} mesaj`}</span>
            <button className="btn ghost xs icon b" onClick={() => setSearch(null)} aria-label="Kapat">
              <Icon name="x" size={13} sw={2} />
            </button>
          </div>
        )}

        <div className="msgs" ref={msgsRef}>
          {messages.length > 0 && !search && hasOlder && (
            <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0 6px' }}>
              <button
                className="btn xs b b2"
                disabled={olderBusy}
                onClick={() => void onLoadOlder?.()}
              >
                <Icon name="history" size={13} /> {olderBusy ? 'Yükleniyor…' : 'Daha eski mesajlar'}
              </button>
            </div>
          )}
          {messages.length === 0 && (
            <div className="empty">
              Bu sohbette henüz mesaj yok.
              {chat.unread > 0 && (
                <>
                  <br />
                  <span style={{ fontSize: 12 }}>Platform mesajları vermedi (X’te şifreli sohbetler bu uçlardan okunamaz).</span>
                </>
              )}
            </div>
          )}
          {messages.length > 0 && shown.length === 0 && <div className="empty">Aramayla eşleşen mesaj yok.</div>}
          {groups.map((g) =>
            g.kind === 'day' ? (
              <div key={g.key} className="datepill">
                {g.label}
              </div>
            ) : (
              <div key={g.key} className={`grp ${g.fromMe ? 'me' : ''}`}>
                {!g.fromMe && <Avatar name={g.senderName} size={28} url={g.items.find((m) => m.senderAvatarUrl)?.senderAvatarUrl ?? (chat.kind === 'direct' ? chat.avatarUrl : undefined)} />}
                <div className="col">
                  {!g.fromMe && chat.kind !== 'direct' && <span className="sender">{g.senderName}</span>}
                  {g.items.map((m, i) => (
                    <div key={m.id} className={`bub ${g.items.length === 1 ? 'first last' : i === 0 ? 'first' : i === g.items.length - 1 ? 'last' : 'mid'}`}>
                      {m.text}
                      {m.attachments?.map((a, j) =>
                        a.kind === 'audio' && a.link ? (
                          <span key={j} className="att-audio">
                            <Icon name="mic" size={14} />
                            <audio src={abs(a.link)} controls preload="metadata" />
                          </span>
                        ) : a.url || (a.kind === 'video' && a.link) ? (
                          <button key={j} className="att-card b" onClick={() => setLightbox(a)} title="Aç">
                            {a.url ? (
                              <img src={abs(a.url)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} />
                            ) : (
                              <span className="att-blank">
                                <Icon name="play" size={28} color="#fff" />
                              </span>
                            )}
                            <span className="att-cap">
                              <Icon name={a.kind === 'video' ? 'play' : a.kind === 'image' ? 'image' : 'link'} size={13} />
                              {a.name ?? attLabel(a.kind)}
                              {a.link && !isMediaFile(a.link) ? <Icon name="external" size={12} /> : null}
                            </span>
                          </button>
                        ) : (
                          <a key={j} className="att" href={abs(a.link)} target={a.link ? '_blank' : undefined} rel="noreferrer" download={a.kind === 'file' && isMediaFile(a.link) ? a.name ?? true : undefined} style={{ textDecoration: 'none' }}>
                            <Icon name={a.kind === 'image' ? 'image' : a.kind === 'audio' ? 'mic' : 'file'} size={14} />
                            {a.name ?? attLabel(a.kind)}
                            {a.size ? <span style={{ opacity: 0.7 }}> · {fmtSize(a.size)}</span> : null}
                          </a>
                        ),
                      )}
                    </div>
                  ))}
                  <span className="meta">
                    {fmtStamp(g.items[g.items.length - 1].ts)}
                    {g.fromMe && statusLabel(g.items[g.items.length - 1].status)}
                  </span>
                </div>
              </div>
            ),
          )}
          {draft && draft.actions.length > 0 && (
            <div className="actions">
              <div className="h">
                <span className="ico">
                  <Icon name="sparkle" size={13} color="#fff" sw={2} />
                </span>
                {draft.actions.length} aksiyon algılandı
              </div>
              {draft.actions.map((a, i) => (
                <div key={i} className="it">
                  <Icon name="calendar" size={15} color="#4A4757" />
                  <span style={{ flexGrow: 1 }}>{a}</span>
                  <button className="btn soft xs b b2" disabled title="Yakında">Göreve ekle</button>
                </div>
              ))}
            </div>
          )}
          <div ref={endRef} />
        </div>

        <div className={`composer ${draft ? 'ai' : ''}`}>
          {ai && (
            <div className="comp-top">
              {draft ? (
                <span className="aipill on">
                  <Icon name="sparkle" size={13} color="#D4FF3F" sw={2} /> Senin tarzında taslak
                </span>
              ) : (
                <button className="aipill b b2" onClick={() => makeDraft()} disabled={drafting || !needsReply} title={needsReply ? 'Son mesaja taslak yanıt üret' : 'Yanıtlanacak yeni mesaj yok'}>
                  {drafting ? <span className="spin" /> : <Icon name="sparkle" size={13} color="#6C47FF" sw={2} />} Taslak yaz
                </button>
              )}
              <span style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>· {Math.min(messages.length, 30)} mesaj bağlamı</span>
              <span style={{ flexGrow: 1 }} />
              {(
                [
                  ['short', 'Kısa'],
                  ['formal', 'Resmi'],
                  ['en', 'EN'],
                ] as Array<[Tone, string]>
              ).map(([t, l]) => (
                <button key={t} className={`btn xs b b2 ${tone === t && draft ? 'soft' : ''}`} onClick={() => makeDraft(t)} disabled={drafting}>
                  {l}
                </button>
              ))}
              <button className="btn xs icon b b2" onClick={() => makeDraft(tone)} disabled={drafting} aria-label="Yeniden yaz">
                <Icon name="refresh" size={13} sw={2} />
              </button>
            </div>
          )}
          {draft && !text.trim() && <div className="ghost-draft">{draft.draft}</div>}
          <textarea
            rows={2}
            value={text}
            placeholder={draft ? 'Taslağı kabul etmek için Tab, düzenlemek için yazmaya başla' : chat.platform === 'shopier' ? 'Siparişe yerel not ekle (Shopier alıcıya mesaj ucu sunmuyor)…' : `${chat.name.length > 40 ? chat.name.slice(0, 38) + '…' : chat.name} için mesaj yaz…`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            style={draft && !text.trim() ? { minHeight: 28, paddingTop: 0 } : undefined}
          />
          <div className="comp-bottom">
            <button className="btn ghost sm icon b" aria-label="Dosya ekle" title="Yakında">
              <Icon name="link" size={16} />
            </button>
            <button className="btn ghost sm icon b" aria-label="Zamanla gönder" title="Yakında">
              <Icon name="calendar" size={16} />
            </button>
            <span style={{ flexGrow: 1 }} />
            {draft && !text.trim() && (
              <span className="hint">
                <span className="kbd">Tab</span> kabul et
              </span>
            )}
            <span className="btn sm" style={{ gap: 6 }}>
              <Chip platform={chat.platform} size={14} /> {platform.name}
            </span>
            <button className="btn primary b" onClick={send} disabled={sending || !(text.trim() || draft?.draft)} style={{ marginLeft: 6 }}>
              {sending ? <span className="spin" /> : <Icon name="send" size={15} sw={1.9} />} Gönder <span className="kbd onprimary">↵</span>
            </button>
          </div>
        </div>
      </section>

      {showDetails && (
      <>
      <Resizer pane="ctx" sign={-1} />
      <aside className="ctx" aria-label="Kişi ayrıntıları">
        {onToggleDetails && (
          <button className="btn ghost xs icon b ctx-close" onClick={onToggleDetails} title="Ayrıntı panelini gizle" aria-label="Paneli kapat">
            <Icon name="panel" size={15} />
          </button>
        )}
        <div className="profile">
          <span className="avwrap">
            <Avatar name={chat.name} size={72} url={chat.avatarUrl} />
            <Chip platform={chat.platform} size={22} ring="#fbfafd" />
          </span>
          <span className="name">{chat.name}</span>
          <span className="sub">
            {platform.name} · {chat.kind === 'group' ? `grup · ${chat.participants?.length ?? '?'} üye` : chat.kind === 'channel' ? 'kanal' : 'sohbet'}
          </span>
          <PlatformFacts chat={chat} />
        </div>
        {chat.platform === 'shopier' && chat.meta?.order ? <OrderPanel chat={chat} notify={notify} /> : null}

        <div className="qacts">
          <button className="b b2" onClick={() => notify('Notlar yakında')}>
            <Icon name="pen" size={16} /> Not ekle
          </button>
          <button className="b b2" onClick={onSnooze}>
            <Icon name="bell" size={16} /> Hatırlat
          </button>
          <button className="b b2" onClick={onComplete}>
            <Icon name="check" size={16} sw={2} /> Tamamla
          </button>
        </div>

        <div>
          <span className="label">Etiketler</span>
          <div className="tagedit" style={{ marginTop: 8 }}>
            {chat.tags.map((t) => (
              <Tag key={t} name={t} onRemove={() => onTags(chat.tags.filter((x) => x !== t))} />
            ))}
            <input
              placeholder="+ etiket"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && tagInput.trim()) {
                  onTags([...new Set([...chat.tags, tagInput.trim().toLowerCase()])]);
                  setTagInput('');
                }
              }}
            />
            {DEFAULT_TAGS.filter((t) => !chat.tags.includes(t)).map((t) => (
              <button key={t} className="tag-suggest b" onClick={() => onTags([...chat.tags, t])} title={`${t} etiketini ekle`}>
                + {t}
              </button>
            ))}
          </div>
        </div>

        {draft && draft.summary.length > 0 ? (
          <div className="card violet">
            <span className="h">
              <Icon name="sparkle" size={14} color="#6C47FF" sw={2} /> Özet
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)', fontWeight: 400 }}>{fmtTime(Date.now())}</span>
            </span>
            <ul>
              {draft.summary.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="card">
            <span className="h">
              <Icon name="sparkle" size={14} color="#6C47FF" sw={2} /> {ai ? 'Özet' : 'AI taslak kapalı'}
            </span>
            <span style={{ fontSize: 12.5, color: 'var(--text3)', lineHeight: 1.45 }}>
              {ai ? '“Taslak yaz” deyince sohbetin özeti ve aksiyonları burada görünür.' : (
                <>
                  Çekirdeği <code>ANTHROPIC_API_KEY</code> ile başlatırsan özet, aksiyon ve senin tarzında taslak açılır.
                </>
              )}
            </span>
          </div>
        )}

        {draft && draft.actions.length > 0 && (
          <div>
            <span className="label">Aksiyonlar</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {draft.actions.map((a, i) => (
                <label key={i} className="todo">
                  <input type="checkbox" /> <span>{a}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="card" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Icon name="bell" size={16} color="#4A4757" />
          <span style={{ flexGrow: 1, fontSize: 12.5, lineHeight: 1.35 }}>2 gün yanıt yoksa hatırlat</span>
          <button type="button" role="switch" aria-checked={remind} aria-label="Takip hatırlatıcısı" className={`sw ${remind ? 'on' : ''}`} onClick={() => setRemind(!remind)} disabled title="Yakında">
            <span />
          </button>
        </div>

        {chat.kind === 'group' && (chat.participants?.length ?? 0) > 0 && (
          <div>
            <span className="label">Üyeler · {chat.participants!.length}</span>
            <div className="members">
              {chat.participants!.map((p) => (
                <button
                  key={p.id}
                  className="member b"
                  title={onOpenChat && PLATFORMS[chat.platform].mode !== 'mail' ? 'Özelden yaz' : p.handle ?? p.name}
                  onClick={() => {
                    if (!onOpenChat) return;
                    api
                      .openChat(chat.accountId, p)
                      .then((c) => onOpenChat(c))
                      .catch((e) => notify((e as Error).message, true));
                  }}
                >
                  <Avatar name={p.name} size={28} url={p.avatarUrl} />
                  <span style={{ minWidth: 0 }}>
                    <span className="nm">
                      {p.name}
                      {p.admin && <span className="adm">yönetici</span>}
                    </span>
                    {p.handle && p.handle !== p.name && <span className="hd">{p.handle}</span>}
                  </span>
                  <Icon name="arrow" size={13} />
                </button>
              ))}
            </div>
          </div>
        )}
        {chat.kind === 'direct' && chat.participants && chat.participants.length > 1 && PLATFORMS[chat.platform].mode === 'mail' && (
          <div>
            <span className="label">Katılımcılar</span>
            <div className="members">
              {chat.participants.map((p) => (
                <div key={p.id} className="member">
                  <Avatar name={p.name} size={28} url={p.avatarUrl} />
                  <span style={{ minWidth: 0 }}>
                    <span className="nm">{p.name}</span>
                    {p.handle && p.handle !== p.name && <span className="hd">{p.handle}</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {files.length > 0 && (
          <div>
            <span className="label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              Paylaşılanlar
              <span style={{ color: 'var(--text3)', fontWeight: 400 }}>{allShared.length}</span>
              {allShared.length > 4 && (
                <button className="btn ghost xs icon b" style={{ marginLeft: 'auto', transform: 'rotate(-90deg)' }} onClick={() => setMediaOpen(true)} title={`Tümünü büyük göster (${allShared.length})`} aria-label="Tüm paylaşılanlar">
                  <Icon name="chev" size={13} sw={2} />
                </button>
              )}
            </span>
            <div className="files" style={{ marginTop: 8 }}>
              {files.map(({ att, m }, i) => (
                <div
                  key={i}
                  className="file"
                  title={att.name}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (att.url || att.link) setLightbox(att);
                    else notify('Bu ek indirilemedi (medya kaydı yok)', true);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()}
                >
                  <span className="ic" style={att.kind === 'image' || att.kind === 'video' ? { background: 'var(--v-soft)', color: 'var(--v-txt)' } : { background: '#fdecea', color: '#c2261a' }}>
                    {att.url ? (
                      <img src={abs(att.url)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} />
                    ) : att.kind === 'image' ? (
                      <Icon name="image" size={15} color="#4526C9" />
                    ) : att.kind === 'video' ? (
                      <Icon name="play" size={15} color="#4526C9" />
                    ) : att.mime?.includes('pdf') ? (
                      'PDF'
                    ) : (
                      <Icon name="file" size={15} color="#C2261A" />
                    )}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span className="nm">{att.name ?? attLabel(att.kind)}</span>
                    <span className="sz">{att.size ? fmtSize(att.size) : fmtTime(m.ts)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>
      </>
      )}
      {mediaOpen && (
        <div className="overlay" onClick={() => setMediaOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Paylaşılanlar" style={{ gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h2 style={{ fontSize: 22 }}>Paylaşılanlar</h2>
              <span className="pill">{allShared.length}</span>
              <span style={{ fontSize: 12.5, color: 'var(--text3)' }}>Şu ana kadar yüklenen mesajlardaki ekler · {chat.name}</span>
              <span style={{ flexGrow: 1 }} />
              <button className="btn icon b b2" onClick={() => setMediaOpen(false)} aria-label="Kapat">
                <Icon name="x" size={15} sw={2} />
              </button>
            </div>
            <div className="media-grid">
              {allShared.map(({ att, m }, i) => (
                <div
                  key={i}
                  className="tile"
                  role="button"
                  tabIndex={0}
                  title={att.name}
                  onClick={() => {
                    if (att.url || att.link) setLightbox(att);
                    else notify('Bu ek indirilemedi (medya kaydı yok)', true);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()}
                >
                  {att.url ? (
                    <img src={abs(att.url)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} />
                  ) : (
                    <span className="big">{att.kind === 'video' ? <Icon name="play" size={28} /> : att.mime?.includes('pdf') ? 'PDF' : <Icon name="file" size={28} />}</span>
                  )}
                  <span className="cap">
                    <span className="nm">{att.name ?? attLabel(att.kind)}</span>
                    <span className="sz">{fmtStamp(m.ts)}{att.size ? ` · ${fmtSize(att.size)}` : ''}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {lightbox && <Lightbox att={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}

interface OrderMeta {
  id: string;
  status: string;
  paymentStatus?: string;
  dateCreated?: string;
  currency: string;
  totals?: { subtotal?: string; shipping?: string; discount?: string; total?: string };
  note?: string;
  items: Array<{ title: string; quantity: number; total: string; type?: string; selection?: string[] }>;
  shipping: { name: string; phone?: string; email?: string; address?: string };
  fulfillments: Array<{ status: string; company?: string; trackingNumber?: string; trackingUrl?: string; date?: string }>;
  refunds: Array<{ type: string; status: string; total: string; date?: string }>;
}
const CARRIERS: Array<[string, string]> = [
  ['yurtici', 'Yurtiçi'], ['aras', 'Aras'], ['mng', 'MNG'], ['ptt', 'PTT'], ['surat', 'Sürat'], ['hepsijet', 'HepsiJET'], ['ups', 'UPS'], ['dhl', 'DHL'], ['fedex', 'FedEx'], ['tnt', 'TNT'], ['pts', 'PTS'], ['aramex', 'Aramex'], ['interGlobal', 'InterGlobal'], ['other', 'Diğer'],
];

/** Shopier sipariş kartı: durum, ürünler, tutar, adres, kargo; kapatma/kargo formu */
function OrderPanel({ chat, notify }: { chat: Chat; notify: (t: string, err?: boolean) => void }) {
  const o = chat.meta!.order as OrderMeta;
  const [company, setCompany] = useState('yurtici');
  const [tracking, setTracking] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const open = o.status !== 'fulfilled';
  const digital = o.items.every((i) => i.type === 'digital');
  const cur = o.currency === 'TRY' ? '₺' : o.currency;
  const fmt = (v?: string) => (v ? `${String(v).replace('.', ',')} ${cur}` : '—');
  const submit = () => {
    setBusy(true);
    api
      .action(chat.id, { kind: 'fulfill', productType: digital ? 'digital' : 'physical', shippingCompany: digital ? undefined : company, trackingNumber: digital ? undefined : tracking.trim() || undefined, note: note.trim() || (digital ? 'Dijital teslimat yapıldı' : undefined) })
      .then(() => notify('Sipariş kapatıldı'))
      .catch((e) => notify((e as Error).message, true))
      .finally(() => setBusy(false));
  };
  return (
    <div className="order">
      <div className="order-head">
        <span className={`order-status ${open ? 'open' : 'done'}`}>{open ? 'Açık sipariş' : 'Kapatıldı'}</span>
        <span className="order-total">{fmt(o.totals?.total)}</span>
      </div>
      <div className="order-items">
        {o.items.map((it, i) => (
          <div key={i} className="order-item">
            <span className="q">{it.quantity}×</span>
            <span className="t">
              {it.title}
              {it.selection?.length ? <span className="sel"> · {it.selection.join(' / ')}</span> : null}
            </span>
            <span className="p">{fmt(it.total)}</span>
          </div>
        ))}
      </div>
      <div className="order-rows">
        {o.totals?.shipping && o.totals.shipping !== '0' && o.totals.shipping !== '0.00' ? <Row k="Kargo" v={fmt(o.totals.shipping)} /> : null}
        {o.totals?.discount && o.totals.discount !== '0' && o.totals.discount !== '0.00' ? <Row k="İndirim" v={'−' + fmt(o.totals.discount)} /> : null}
        <Row k="Tarih" v={o.dateCreated ? new Date(o.dateCreated).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }) : '—'} />
        <Row k="Alıcı" v={o.shipping.name} />
        {o.shipping.phone ? <Row k="Telefon" v={o.shipping.phone} href={`tel:${o.shipping.phone}`} /> : null}
        {o.shipping.email ? <Row k="E-posta" v={o.shipping.email} href={`mailto:${o.shipping.email}`} /> : null}
        {o.shipping.address ? <Row k="Adres" v={o.shipping.address} /> : null}
        {o.note ? <Row k="Not" v={o.note} /> : null}
        {o.fulfillments.map((f, i) => (
          <Row key={i} k={f.status === 'shipped' ? 'Kargo' : 'Gönderi'} v={`${f.company ?? ''}${f.trackingNumber ? ' · ' + f.trackingNumber : ''}`.trim() || (f.status === 'shipped' ? 'gönderildi' : 'hazırlanıyor')} href={f.trackingUrl} />
        ))}
        {o.refunds.map((r, i) => (
          <Row key={'r' + i} k="İade" v={`${r.type === 'full' ? 'tam' : 'kısmi'} ${fmt(r.total)} · ${r.status === 'succeeded' ? 'tamamlandı' : r.status === 'failed' ? 'başarısız' : 'bekliyor'}`} />
        ))}
      </div>
      {open && (
        <div className="order-form">
          <span className="label">{digital ? 'Teslim edildi olarak kapat' : 'Kargoya ver ve kapat'}</span>
          {!digital && (
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={company} onChange={(e) => setCompany(e.target.value)}>
                {CARRIERS.map(([k, n]) => (
                  <option key={k} value={k}>
                    {n}
                  </option>
                ))}
              </select>
              <input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="takip no" />
            </div>
          )}
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={digital ? 'Teslimat notu (zorunlu)' : 'Not (isteğe bağlı)'} />
          <button className="btn primary sm b b2" disabled={busy || (digital && !note.trim())} onClick={submit}>
            <Icon name="check" size={14} sw={2} color="#fff" /> {digital ? 'Teslim edildi' : 'Kargoya verildi'}
          </button>
        </div>
      )}
    </div>
  );
}
function Row({ k, v, href }: { k: string; v: string; href?: string }) {
  return (
    <div className="order-row">
      <span className="k">{k}</span>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {v}
        </a>
      ) : (
        <span>{v}</span>
      )}
    </div>
  );
}

/** Platforma özel kimlik satırı: numara, @kullanıcı, profil bağlantısı, e-posta */
function PlatformFacts({ chat }: { chat: Chat }) {
  const p = chat.platform;
  const items: Array<{ label: string; value: string; href?: string; copy?: boolean }> = [];
  const other = chat.kind === 'direct' ? chat.participants?.find((x) => x.id !== 'me') : undefined;
  if (p === 'whatsapp') {
    if (chat.kind === 'direct') {
      const num = chat.handle ?? (chat.remoteId.endsWith('@s.whatsapp.net') ? '+' + chat.remoteId.split('@')[0] : undefined);
      if (num) items.push({ label: 'Numara', value: num, href: `https://wa.me/${num.replace(/\D/g, '')}`, copy: true });
    }
  } else if (p === 'instagram' || p === 'x' || p === 'linkedin' || p === 'slack') {
    if (chat.handle) items.push({ label: 'Kullanıcı', value: chat.handle, href: chat.link });
    else if (other?.handle) items.push({ label: 'Kullanıcı', value: other.handle });
  } else if (p === 'telegram') {
    if (chat.handle) items.push({ label: 'Kullanıcı', value: chat.handle, href: chat.handle.startsWith('@') ? `https://t.me/${chat.handle.slice(1)}` : undefined });
  } else if (p === 'imessage') {
    items.push({ label: 'Kimlik', value: chat.remoteId, copy: true });
  } else if (PLATFORMS[p].mode === 'mail') {
    if (chat.handle) items.push({ label: 'Gönderen', value: chat.handle, href: `mailto:${chat.handle}`, copy: true });
  }
  if (!items.length) return null;
  return (
    <div className="facts">
      {items.map((it) => (
        <span key={it.label} className="fact">
          <span className="k">{it.label}</span>
          {it.href ? (
            <a href={it.href} target="_blank" rel="noreferrer" title="Aç">
              {it.value}
            </a>
          ) : (
            <span>{it.value}</span>
          )}
          {it.copy && (
            <button className="b" title="Kopyala" onClick={() => void navigator.clipboard?.writeText(it.value)}>
              <Icon name="copy" size={12} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

/** Medya penceresi: görsel/video doğrudan, Instagram/X gönderileri gömülü (embed) sayfayla, diğerleri bağlantıyla. */
function Lightbox({ att, onClose }: { att: Attachment; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const link = att.link ? abs(att.link) : undefined;
  const page = att.page ?? (att.link && !isMediaFile(att.link) ? att.link : undefined);
  const embed = page ? embedUrl(page) : undefined;
  const isFile = isMediaFile(att.link);
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-label={att.name ?? 'Medya'}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        {att.kind === 'video' && isFile && link ? (
          <video src={link} poster={abs(att.url)} controls autoPlay playsInline />
        ) : att.kind === 'audio' && link ? (
          <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
            <Icon name="mic" size={28} color="#fff" />
            <audio src={link} controls autoPlay />
          </div>
        ) : embed ? (
          <iframe src={embed} title={att.name ?? 'Gönderi'} allow="autoplay; encrypted-media; picture-in-picture" />
        ) : att.url ? (
          <img src={abs(att.url)} alt={att.name ?? ''} referrerPolicy="no-referrer" />
        ) : null}
        <div className="bar">
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexGrow: 1 }}>{att.name ?? attLabel(att.kind)}</span>
          {page && (
            <a href={page} target="_blank" rel="noreferrer">
              <Icon name="external" size={13} /> Tarayıcıda aç
            </a>
          )}
          {link && isFile && (
            <a href={link} target="_blank" rel="noreferrer" download={att.name ?? true}>
              <Icon name="external" size={13} /> İndir
            </a>
          )}
        </div>
        <button className="close b" onClick={onClose} aria-label="Kapat">
          <Icon name="x" size={14} sw={2} />
        </button>
      </div>
    </div>
  );
}

/** Instagram ve X gönderilerinin iframe'de açılabilen gömülü sürümleri */
function embedUrl(link: string): string | undefined {
  let m = link.match(/^https?:\/\/(?:www\.)?instagram\.com\/(p|reel|reels)\/([A-Za-z0-9_-]+)/);
  if (m) return `https://www.instagram.com/${m[1] === 'p' ? 'p' : 'reel'}/${m[2]}/embed/`;
  m = link.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/);
  if (m) return `https://platform.twitter.com/embed/Tweet.html?dnt=true&embedId=twitter-widget-0&frame=false&hideCard=false&hideThread=false&id=${m[1]}&lang=tr&theme=light&widgetsVersion=2615f7e52b7e0%3A1702314776716`;
  return undefined;
}

type Group = { kind: 'day'; key: string; label: string } | { kind: 'msgs'; key: string; fromMe: boolean; senderName: string; items: Message[] };

function groupMessages(msgs: Message[]): Group[] {
  const out: Group[] = [];
  let lastDay = '';
  let cur: Extract<Group, { kind: 'msgs' }> | null = null;
  for (const m of msgs) {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) {
      out.push({ kind: 'day', key: 'd' + m.ts, label: fmtDay(m.ts) });
      lastDay = day;
      cur = null;
    }
    if (cur && cur.fromMe === m.fromMe && cur.senderName === m.senderName && m.ts - cur.items[cur.items.length - 1].ts < 5 * 60_000) {
      cur.items.push(m);
    } else {
      cur = { kind: 'msgs', key: m.id, fromMe: m.fromMe, senderName: m.senderName, items: [m] };
      out.push(cur);
    }
  }
  return out;
}

function statusLabel(s: Message['status']) {
  if (s === 'read')
    return (
      <>
        · Okundu <Icon name="checks" size={14} color="#6C47FF" sw={2} />
      </>
    );
  if (s === 'delivered') return <> · İletildi</>;
  if (s === 'pending') return <> · Gönderiliyor</>;
  if (s === 'failed') return <span style={{ color: '#a32d2d' }}> · Gönderilemedi</span>;
  return null;
}

/** Çekirdeğin vekil yolları (/api/media/…) Tauri'de mutlak adrese çevrilir */
function abs(u?: string): string | undefined {
  return u && u.startsWith('/') ? API_BASE + u : u;
}
function isMediaFile(u?: string): boolean {
  return !!u && (u.startsWith('/api/media/') || /\.(mp4|webm|mov)(\?|$)/i.test(u));
}

function attLabel(k: string) {
  return { image: 'Görsel', file: 'Dosya', audio: 'Ses', video: 'Video', other: 'Ek' }[k] ?? 'Ek';
}

function fmtSize(n: number) {
  if (n > 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' MB';
  if (n > 1e3) return Math.round(n / 1e3) + ' KB';
  return n + ' B';
}
