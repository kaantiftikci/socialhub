import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { API_BASE, mediaUrl } from './desktop';
import { PLATFORMS, type Attachment, type Chat, type DraftResult, type Message } from './types';
import { useClosing, Avatar, Chip, Icon, Tag, fmtDay, fmtStamp, fmtTime } from './ui';

type Tone = 'default' | 'short' | 'formal' | 'en';

export function Conversation({
  chat,
  messages,
  ai,
  notify,
  onSnooze,
  onComplete,
  onLoadOlder,
  hasOlder = false,
  olderBusy = false,
  onBack,
  typing,
  snoozedUntil,
  onUnsnooze,
}: {
  chat: Chat;
  messages: Message[];
  ai: boolean;
  notify: (t: string, err?: boolean) => void;
  onSnooze: () => void;
  onComplete: () => void;
  /** Ertelenmişse ne zamana kadar; geri alma */
  snoozedUntil?: number;
  onUnsnooze?: () => void;
  /** Depodaki daha eski mesajları (100'er) yükle */
  onLoadOlder?: () => void | Promise<void>;
  hasOlder?: boolean;
  olderBusy?: boolean;
  /** Dar ekranda listeye dön */
  onBack?: () => void;
  /** Karşı taraf yazıyor: null hayır, '' evet, 'Ad' grupta kim */
  typing?: string | null;
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
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const lightboxP = useClosing(lightbox);
  useEffect(() => setLightbox(null), [chat.id]);
  const endRef = useRef<HTMLDivElement>(null);
  const msgsRef = useRef<HTMLDivElement>(null);
  const firstIdRef = useRef<string | undefined>(undefined);
  const lastIdRef = useRef<string | undefined>(undefined);
  const chatRef = useRef<string | undefined>(undefined);
  const heightRef = useRef(0);
  const platform = PLATFORMS[chat.platform];
  /** E-posta kanalları: balon yerine ileti kartları ve e-posta yanıt alanı */
  const isMail = platform.category === 'mail';
  const [uploading, setUploading] = useState<string | null>(null);
  async function sendFile(file: File) {
    if (file.size > 50 * 1024 * 1024) return notify('Dosya 50 MB\'tan büyük', true);
    setUploading(file.name);
    try {
      const data = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1] ?? '');
        r.onerror = () => rej(new Error('Dosya okunamadı'));
        r.readAsDataURL(file);
      });
      await api.sendFile(chat.id, { name: file.name, mime: file.type || 'application/octet-stream', data, caption: text.trim() || undefined });
      setText('');
      notify(`${file.name} gönderildi`);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setUploading(null);
    }
  }

  // Kaydırma: sohbet açılınca en alta; "daha eski mesajlar" başa eklenince okunan yer korunur; yeni mesaj gelince
  // yalnızca zaten alttaysan en alta iner (yukarı kaydırırken sohbet durum/okundu güncellemeleriyle aşağı fırlamaz)
  useEffect(() => {
    const el = msgsRef.current;
    const first = messages[0]?.id;
    const last = messages[messages.length - 1]?.id;
    const chatChanged = chatRef.current !== chat.id;
    chatRef.current = chat.id;
    const prepended = !!el && !!firstIdRef.current && first !== firstIdRef.current && messages.some((m) => m.id === firstIdRef.current);
    if (chatChanged || (lastIdRef.current === undefined && last !== undefined)) {
      stickRef.current = true;
      endRef.current?.scrollIntoView({ block: 'end' });
    } else if (prepended && el) el.scrollTop += el.scrollHeight - heightRef.current;
    else if (el && last !== lastIdRef.current && stickRef.current) endRef.current?.scrollIntoView({ block: 'end' });
    firstIdRef.current = first;
    lastIdRef.current = last;
    heightRef.current = el?.scrollHeight ?? 0;
  }, [messages, chat.id]);

  // Alta yapışma: kullanıcı en alttayken sonradan yüklenen foto/video/önizlemeler içeriği uzatınca görünüm yukarıda
  // kalmasın (Instagram'da sohbet açılınca "yukarı atma" hissi buydu). Kullanıcı yukarı kaydırınca yapışma bırakılır.
  const stickRef = useRef(true);
  /** Yukarı çıkınca görünen "en alta in" oku */
  const [showDown, setShowDown] = useState(false);
  const downP = useClosing(showDown || null, 140);
  useEffect(() => {
    const el = msgsRef.current;
    if (!el) return;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickRef.current = gap < 80;
      setShowDown(gap > 360);
      heightRef.current = el.scrollHeight;
    };
    // medya yüklenmesi (load olayları kabarcıklanmaz; yakalama evresinde dinlenir)
    const onMediaLoad = () => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
      heightRef.current = el.scrollHeight;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('load', onMediaLoad, true);
    el.addEventListener('loadedmetadata', onMediaLoad, true);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('load', onMediaLoad, true);
      el.removeEventListener('loadedmetadata', onMediaLoad, true);
    };
  }, [chat.id]);

  const shown = useMemo(() => {
    const q = (search ?? '').trim().toLocaleLowerCase('tr-TR');
    if (!q) return messages;
    return messages.filter((m) => m.text.toLocaleLowerCase('tr-TR').includes(q) || m.senderName.toLocaleLowerCase('tr-TR').includes(q) || m.attachments?.some((a) => a.name?.toLocaleLowerCase('tr-TR').includes(q)));
  }, [messages, search]);
  const groups = useMemo(() => groupMessages(shown), [shown]);
  const lastIncoming = [...messages].reverse().find((m) => !m.fromMe);
  const needsReply = !!lastIncoming && messages[messages.length - 1]?.id === lastIncoming.id;

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
          {onBack && (
            <button className="btn icon b b2" onClick={onBack} aria-label="Listeye dön" title="Listeye dön" style={{ transform: 'rotate(90deg)' }}>
              <Icon name="chev" size={15} sw={2} />
            </button>
          )}
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
              {typing != null ? <span className="typing-text"> · {typing ? `${typing.split(' ')[0]} yazıyor` : 'yazıyor'}<span className="tdots"><i /><i /><i /></span></span> : chat.kind !== 'direct' ? ` · ${chat.kind === 'group' ? 'grup' : 'kanal'}` : ' · sohbet'}
            </span>
          </div>
          <button className={`btn icon b b2 ${search !== null ? 'on' : ''}`} onClick={() => setSearch(search === null ? '' : null)} title="Sohbette ara" aria-label="Ara">
            <Icon name="search" size={15} />
          </button>
          {snoozedUntil && onUnsnooze ? (
            <button className="btn b b2 on" onClick={onUnsnooze} title={`${fmtStamp(snoozedUntil)} tarihine ertelendi — geri al`}>
              <Icon name="bell" size={15} /> <span className="lbl">Ertelendi · geri al</span>
            </button>
          ) : (
            <button className="btn b b2" onClick={onSnooze} title="Yarına ertele">
              <Icon name="clock" size={15} /> <span className="lbl">Ertele</span> <span className="kbd lbl">H</span>
            </button>
          )}
          <button className="btn soft b b2" onClick={onComplete} title="Okundu olarak işaretle">
            <Icon name="check" size={15} sw={2} /> <span className="lbl">Tamamla</span> <span className="kbd lbl">E</span>
          </button>
        </header>
        {snoozedUntil && onUnsnooze && (
          <div className="snooze-banner" role="status">
            <Icon name="bell" size={14} sw={2} />
            <span>
              Bu sohbet <b>{fmtStamp(snoozedUntil)}</b> tarihine ertelendi; o zamana kadar gelen kutusunda görünmez.
            </span>
            <button className="btn xs b b2" onClick={onUnsnooze}>
              Ertelemeyi kaldır
            </button>
          </div>
        )}
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

        <div className={`msgs ${isMail ? 'mail' : ''}`} ref={msgsRef}>
          {isMail && (
            <div className="mail-thread">
              <h3 className="mail-subject">{chat.name}</h3>
              {shown.map((m) => {
                const email = m.senderId.includes('@') ? m.senderId : chat.handle ?? '';
                return (
                  <article key={m.id} className={`mail-card ${m.fromMe ? 'me' : ''}`}>
                    <header>
                      <Avatar name={m.fromMe ? 'Ben' : m.senderName} size={34} url={m.senderAvatarUrl} />
                      <div style={{ minWidth: 0, flexGrow: 1 }}>
                        <div className="who">
                          <b>{m.fromMe ? 'Ben' : m.senderName}</b>
                          {!m.fromMe && email && <span className="addr">{email}</span>}
                        </div>
                        <div className="to">{m.fromMe ? `Alıcı: ${chat.handle ?? chat.participants?.[0]?.name ?? ''}` : 'Alıcı: ben'}</div>
                      </div>
                      <time>{fmtStamp(m.ts)}</time>
                    </header>
                    <div className="mail-body">{m.text}</div>
                    {m.attachments?.length ? (
                      <div className="mail-atts">
                        {m.attachments.map((a, i) => (
                          <a key={i} className="mail-att" href={abs(a.link ?? a.url) ?? '#'} target="_blank" rel="noreferrer" onClick={(e) => (a.link || a.url ? (a.kind === 'image' ? (e.preventDefault(), setLightbox(a)) : undefined) : e.preventDefault())}>
                            <Icon name={a.kind === 'image' ? 'image' : a.kind === 'video' ? 'play' : 'file'} size={14} /> {a.name ?? attLabel(a.kind)}
                            {a.size ? <span className="sz"> · {fmtSize(a.size)}</span> : null}
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
          {!search && hasOlder && onLoadOlder && (
            <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0 6px' }}>
              <button className="btn xs b b2" disabled={olderBusy} onClick={() => void onLoadOlder()} aria-busy={olderBusy}>
                {olderBusy ? <span className="spin" style={{ width: 12, height: 12 }} /> : <Icon name="history" size={13} />}{' '}
                {olderBusy ? 'Yükleniyor…' : messages.length > 0 ? 'Daha eski mesajlar' : 'Geçmişi platformdan yükle'}
              </button>
            </div>
          )}
          {messages.length === 0 && (
            <div className="empty">
              {olderBusy ? 'Mesajlar yükleniyor…' : 'Bu sohbette henüz mesaj yok.'}
              {!olderBusy && chat.unread > 0 && (
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
                      {m.attachments?.map((a, j) => (
                        <AttachmentView key={j} a={a} onOpen={setLightbox} />
                      ))}
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
          {typing != null && (
            <div className="grp typing-grp">
              <Avatar name={typing || chat.name} size={28} url={typing ? undefined : chat.kind === 'direct' ? chat.avatarUrl : undefined} />
              <div className="col">
                <div className="bub typing-bub" aria-label="yazıyor">
                  <span className="tdots"><i /><i /><i /></span>
                </div>
              </div>
            </div>
          )}
          <div ref={endRef} />
          {downP.value && (
            <div className={`downwrap ${downP.closing ? 'closing' : ''}`}>
              <button
                className="downbtn b"
                aria-label="En alta in"
                title="En alta in"
                onClick={() => {
                  const el = msgsRef.current;
                  if (!el) return;
                  stickRef.current = true;
                  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
                }}
              >
                <Icon name="chev" size={18} sw={2.2} />
                {chat.unread > 0 && <span className="badge">{chat.unread > 99 ? '99+' : chat.unread}</span>}
              </button>
            </div>
          )}
        </div>

        <div className={`composer ${draft ? 'ai' : ''} ${isMail ? 'mail' : ''}`}>
          {isMail && (
            <div className="mail-reply-head">
              <span>
                <span className="k">Alıcı</span> {chat.handle ?? chat.participants?.map((p) => p.handle ?? p.name).join(', ') ?? '—'}
              </span>
              <span>
                <span className="k">Konu</span> {/^(re|ynt):/i.test(chat.name) ? chat.name : `Re: ${chat.name}`}
              </span>
            </div>
          )}
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
            placeholder={draft ? 'Taslağı kabul etmek için Tab, düzenlemek için yazmaya başla' : chat.platform === 'shopier' ? 'Siparişe yerel not ekle (Shopier alıcıya mesaj ucu sunmuyor)…' : isMail ? 'Yanıtını yaz… (Enter gönderir, Shift+Enter yeni satır)' : `${chat.name.length > 40 ? chat.name.slice(0, 38) + '…' : chat.name} için mesaj yaz…`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            style={draft && !text.trim() ? { minHeight: 28, paddingTop: 0 } : undefined}
          />
          <div className="comp-bottom">
            <label className="btn ghost sm icon b" aria-label="Fotoğraf, video veya dosya ekle" title="Fotoğraf / video / dosya gönder" style={{ cursor: uploading ? 'progress' : 'pointer' }}>
              <Icon name="link" size={16} />
              <input type="file" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.txt" style={{ display: 'none' }} disabled={!!uploading} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void sendFile(f); }} />
            </label>
            {uploading && <span className="hint">{uploading} gönderiliyor…</span>}
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
              {sending ? <span className="spin" /> : <Icon name="send" size={15} sw={1.9} />} Gönder
            </button>
          </div>
        </div>
      </section>


      {lightboxP.value && <Lightbox att={lightboxP.value} closing={lightboxP.closing} onClose={() => setLightbox(null)} />}
    </>
  );
}


/** Medya penceresi: görsel/video doğrudan, Instagram/X gönderileri gömülü (embed) sayfayla, diğerleri bağlantıyla. */
function Lightbox({ att, onClose, closing }: { att: Attachment; onClose: () => void; closing?: boolean }) {
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
    <div className={`lightbox ${closing ? 'closing' : ''}`} onClick={onClose} role="dialog" aria-label={att.name ?? 'Medya'}>
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
        ) : att.url || (att.kind === 'image' && link && isFile) ? (
          <img src={att.kind === 'image' && link && (isImageFile(att.link) || !att.url) ? link : abs(att.url)} alt={att.name ?? ''} referrerPolicy="no-referrer" />
        ) : link ? (
          <div style={{ padding: 28, color: '#fff', fontSize: 13 }}>Önizleme yok — dosyayı aşağıdan indir.</div>
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
        · Görüldü <Icon name="checks" size={14} color="#6C47FF" sw={2} />
      </>
    );
  if (s === 'delivered') return <> · İletildi</>;
  if (s === 'pending') return <> · Gönderiliyor</>;
  if (s === 'failed') return <span style={{ color: '#a32d2d' }}> · Gönderilemedi</span>;
  return null;
}

/** Çekirdeğin vekil yolları (/api/media/…) Tauri'de mutlak adrese çevrilir */
function abs(u?: string): string | undefined {
  return mediaUrl(u);
}
/** Doğrudan oynatılabilir/indirilebilir dosya mı (vekil yolu ya da bilinen uzantı) — sayfa bağlantısı değil */
function isMediaFile(u?: string): boolean {
  // X/Twitter CDN'i uzantı yerine "?format=jpg" kullanır; o da dosya sayılır
  return !!u && (u.startsWith('/api/media/') || /\.(mp4|webm|mov|m4v|jpe?g|png|gif|webp|mp3|m4a|ogg|opus|wav|pdf)(\?|$)/i.test(u) || /[?&]format=(jpe?g|png|webp|gif|mp4)(&|$)/i.test(u));
}
function isImageFile(u?: string): boolean {
  return !!u && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(u);
}
/** http(s) sayfa bağlantısı (Instagram/X/LinkedIn gönderisi gibi): yeni sekmede açılır, medya değil */
function isPageLink(u?: string): boolean {
  return !!u && /^https?:\/\//i.test(u) && !isMediaFile(u);
}

/**
 * Mesaj balonundaki ek:
 * - audio → <audio controls> (link)
 * - video (dosya) → <video controls> (link, url poster)
 * - sayfa bağlantısı (Instagram gönderisi vb.) → önizleme görseli + yeni sekmede aç
 * - image → <img> (url), tıklayınca büyük pencere
 * - file/other → indirme bağlantısı (yeni sekme)
 */
function AttachmentView({ a, onOpen }: { a: Attachment; onOpen: (a: Attachment) => void }) {
  const link = abs(a.link);
  const url = abs(a.url);
  const hideOnError = (e: React.SyntheticEvent<HTMLImageElement>) => (e.currentTarget.style.display = 'none');
  if (a.kind === 'audio' && link) {
    return (
      <span className="att-audio">
        <Icon name="mic" size={14} />
        <audio src={link} controls preload="metadata" />
      </span>
    );
  }
  if (a.kind === 'video' && link && isMediaFile(a.link)) {
    return (
      <span className="att-card att-video">
        <video src={link} poster={url} controls preload="metadata" playsInline />
        <span className="att-cap">
          <Icon name="play" size={13} />
          {a.name ?? attLabel(a.kind)}
          <a href={link} target="_blank" rel="noreferrer" download={a.name ?? true} title="İndir" aria-label="Videoyu indir" style={{ marginLeft: 'auto', display: 'inline-flex', color: 'inherit' }}>
            <Icon name="external" size={12} />
          </a>
        </span>
      </span>
    );
  }
  const page = a.page ?? (isPageLink(a.link) ? a.link : undefined);
  if (page) {
    return (
      <a className="att-card b" href={page} target="_blank" rel="noreferrer" title="Gönderiyi tarayıcıda aç">
        {url ? (
          <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={hideOnError} />
        ) : (
          <span className="att-blank">
            <Icon name={a.kind === 'video' ? 'play' : 'link'} size={28} color="#fff" />
          </span>
        )}
        <span className="att-cap">
          <Icon name={a.kind === 'video' ? 'play' : a.kind === 'image' ? 'image' : 'link'} size={13} />
          {a.name ?? attLabel(a.kind)}
          <Icon name="external" size={12} />
        </span>
      </a>
    );
  }
  if (url) {
    return (
      <button type="button" className="att-card b" onClick={() => onOpen(a)} title="Büyüt">
        <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={hideOnError} />
        <span className="att-cap">
          <Icon name={a.kind === 'video' ? 'play' : 'image'} size={13} />
          {a.name ?? attLabel(a.kind)}
        </span>
      </button>
    );
  }
  return (
    <a className="att" href={link} target={link ? '_blank' : undefined} rel="noreferrer" download={link && isMediaFile(a.link) ? a.name ?? true : undefined} style={{ textDecoration: 'none' }} title={link ? 'İndir' : undefined}>
      <Icon name={a.kind === 'image' ? 'image' : a.kind === 'audio' ? 'mic' : a.kind === 'video' ? 'play' : 'file'} size={14} />
      {a.name ?? attLabel(a.kind)}
      {a.size ? <span style={{ opacity: 0.7 }}> · {fmtSize(a.size)}</span> : null}
      {link ? <Icon name="external" size={12} /> : null}
    </a>
  );
}

function attLabel(k: string) {
  return { image: 'Görsel', file: 'Dosya', audio: 'Ses', video: 'Video', other: 'Ek' }[k] ?? 'Ek';
}

function fmtSize(n: number) {
  if (n > 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' MB';
  if (n > 1e3) return Math.round(n / 1e3) + ' KB';
  return n + ' B';
}
