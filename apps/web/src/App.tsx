import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, connectEvents } from './api';
import { PLATFORMS, type Account, type Chat, type CoreEvent, type Message, type Platform, DEFAULT_TAGS } from './types';
import { Avatar, Chip, Icon, Logo, Resizer, Tag, ago, fmtTime, loadPaneSizes } from './ui';
import { Conversation } from './Conversation';
import { ConnectModal } from './Connect';
import { Focus } from './Focus';
import { isTauri, notify as desktopNotify, onDesktopEvent, playPing, SOUNDS, getSound, setSound, setBadge, windowFocused, coreInfo } from './desktop';

export type View = 'inbox' | 'focus' | 'snoozed';
export type Filter = 'all' | 'unread' | 'waiting';
export type Snoozes = Record<string, number>; // chatId → uyanma zamanı (ms)

const SNOOZE_KEY = 'kavsak.snoozes';

export default function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [chats, setChats] = useState<Map<string, Chat>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [view, setView] = useState<View>('inbox');
  const [filter, setFilter] = useState<Filter>('all');
  const [platformFilter, setPlatformFilter] = useState<Platform | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const smartSort = false; // akıllı sıralama kaldırıldı: her zaman son mesaja göre
  const [listSearch, setListSearch] = useState(false);
  /** iMessage klasörü: Mesajlar uygulamasındaki Bilinmeyen / İstenmeyen / SMS filtresi / Son silinenler */
  const [imFolder, setImFolder] = useState<'unknown' | 'junk' | 'sms' | 'deleted' | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [noMoreOlder, setNoMoreOlder] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [booting, setBooting] = useState(false);
  const [sound, setSoundState] = useState<string>(() => getSound());
  const changeSound = (id: string) => {
    setSound(id);
    setSoundState(id);
    if (id !== 'off') playPing(id, true);
  };
  const [showDetails, setShowDetailsState] = useState<boolean>(() => {
    try {
      return localStorage.getItem('kavsak.details') !== 'off';
    } catch {
      return true;
    }
  });
  const setShowDetails = (v: boolean) => {
    setShowDetailsState(v);
    try {
      localStorage.setItem('kavsak.details', v ? 'on' : 'off');
    } catch {
      /* yok */
    }
  };
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Array<{ message: Message; chat: Chat }>>([]);
  const currentMessages = useMemo(() => messages.filter((m) => m.chatId === selected), [messages, selected]);
  useEffect(() => loadPaneSizes(), []);
  // Tam metin arama (FTS5): 2+ karakterde mesaj içeriklerinde de ara
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return void setHits([]);
    const t = window.setTimeout(() => api.search(q).then(setHits).catch(() => setHits([])), 250);
    return () => clearTimeout(t);
  }, [query]);
  const [connectOpen, setConnectOpen] = useState(false);
  const [qr, setQr] = useState<Record<string, string>>({});
  const [prompts, setPrompts] = useState<Record<string, { prompt: 'phone' | 'code' | 'password'; message: string }>>({});
  const [ai, setAi] = useState(false);
  const [online, setOnline] = useState(false);
  const [toast, setToast] = useState<{ text: string; err?: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; account: Account; confirm?: boolean } | null>(null);
  const [snoozes, setSnoozes] = useState<Snoozes>(() => {
    try {
      return JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? '{}') as Snoozes;
    } catch {
      return {};
    }
  });
  const [, tick] = useState(0);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const searchRef = useRef<HTMLInputElement>(null);

  const notify = useCallback((text: string, err = false) => {
    setToast({ text, err });
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  const refresh = useCallback(async () => {
    const [a, c, h] = await Promise.all([api.accounts(), api.chats(), api.health()]);
    setAccounts(a);
    setQr((q) => {
      const next = { ...q };
      for (const acc of a) if (acc.qrDataUrl) next[acc.id] = acc.qrDataUrl;
      return next;
    });
    setChats(new Map(c.map((x) => [x.id, x])));
    setAi(h.ai);
  }, []);

  // ---- olay akışı ----
  useEffect(() => {
    const onErr = (e: ErrorEvent) => notify(`Arayüz hatası: ${e.message}`, true);
    const onRej = (e: PromiseRejectionEvent) => notify(`Arayüz hatası: ${String((e.reason as Error)?.message ?? e.reason)}`, true);
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    return () => {
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
    };
  }, [notify]);

  useEffect(() => {
    // Paketli uygulamada çekirdek arayüzden 1-3 sn sonra ayağa kalkar: hata göstermeden önce bekle
    let cancelled = false;
    (async () => {
      const t0 = Date.now();
      let lastErr = '';
      while (!cancelled && Date.now() - t0 < 45_000) {
        try {
          await refresh();
          setBooting(false);
          return;
        } catch (e) {
          lastErr = String((e as Error).message);
          setBooting(true);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (cancelled) return;
      setBooting(false);
      const info = isTauri ? await coreInfo() : '';
      notify(lastErr + (info ? '\n' + info : ''), true);
    })();
    // Geçmiş eşitlemesinde saniyede binlerce chat/message olayı gelir; her biri için ayrı render yerine
    // 150 ms'lik pencerede biriktirip tek seferde uygula.
    const pendingChats = new Map<string, Chat>();
    const pendingDeletes = new Set<string>();
    let flushTimer: number | undefined;
    const flushChats = () => {
      flushTimer = undefined;
      if (!pendingChats.size && !pendingDeletes.size) return;
      const upserts = new Map(pendingChats);
      const deletes = new Set(pendingDeletes);
      pendingChats.clear();
      pendingDeletes.clear();
      setChats((prev) => {
        const n = new Map(prev);
        for (const id of deletes) n.delete(id);
        for (const [id, c] of upserts) n.set(id, c);
        return n;
      });
    };
    const queueChat = (chat: Chat) => {
      pendingDeletes.delete(chat.id);
      pendingChats.set(chat.id, chat);
      if (flushTimer === undefined) flushTimer = window.setTimeout(flushChats, 150);
    };
    const onEvent = (ev: CoreEvent) => {
      switch (ev.type) {
        case 'account.status':
          setAccounts((prev) => {
            const i = prev.findIndex((x) => x.id === ev.account.id);
            if (i < 0) return [...prev, ev.account];
            const next = [...prev];
            next[i] = ev.account;
            return next;
          });
          if (ev.account.status === 'connected') setQr((q) => ({ ...q, [ev.account.id]: '' }));
          break;
        case 'account.qr':
          setQr((q) => ({ ...q, [ev.accountId]: ev.qrDataUrl }));
          break;
        case 'account.prompt':
          setPrompts((p) => ({ ...p, [ev.accountId]: { prompt: ev.prompt, message: ev.message } }));
          break;
        case 'chat.upsert':
          queueChat(ev.chat);
          break;
        case 'chat.delete':
          pendingChats.delete(ev.chatId);
          pendingDeletes.add(ev.chatId);
          if (flushTimer === undefined) flushTimer = window.setTimeout(flushChats, 150);
          setSelected((sel) => (sel === ev.chatId ? null : sel));
          break;
        case 'message.delete':
          if (ev.chatId === selectedRef.current) setMessages((prev) => prev.filter((m) => m.id !== ev.messageId));
          break;
        case 'message.upsert':
          queueChat(ev.chat);
          // yalnızca canlı gelen (eşitleme/geçmiş değil) ve yeni mesajlar bildirim çalsın
          if (ev.live && !ev.message.fromMe && Date.now() - ev.message.ts < 120_000) {
            void windowFocused().then((focused) => {
              if (!focused || ev.message.chatId !== selectedRef.current) {
                desktopNotify(ev.chat.name, (ev.message.text || ev.message.attachments?.[0]?.name || 'Yeni mesaj').slice(0, 140));
                playPing();
              }
            });
          }
          if (ev.message.chatId === selectedRef.current) {
            setMessages((prev) => {
              const i = prev.findIndex((m) => m.id === ev.message.id);
              if (i >= 0) {
                const next = [...prev];
                next[i] = ev.message;
                return next;
              }
              return [...prev, ev.message].sort((x, y) => x.ts - y.ts);
            });
            // pencere arka plandaysa okundu sayma (rozet/okunmamış sayacı korunur)
            if (!ev.message.fromMe) void windowFocused().then((f) => f && api.markRead(ev.message.chatId)).catch(() => undefined);
          }
          break;
      }
    };
    const stop = connectEvents(onEvent, (open) => {
      setOnline(open);
      if (open) refresh().catch(() => undefined);
    });
    const t = window.setInterval(() => tick((x) => x + 1), 60_000); // "1 sa" gibi göreli süreler
    return () => {
      cancelled = true;
      stop();
      clearInterval(t);
      if (flushTimer !== undefined) clearTimeout(flushTimer);
    };
  }, [refresh, notify]);

  // ---- seçili sohbetin mesajları ----
  // "Daha eski mesajlar" ile yüklenenler sohbet başına bellekte tutulur; geri dönünce yeniden 100'e düşmez
  const msgCache = useRef(new Map<string, Message[]>());
  /** `messages` dizisinin hangi sohbete ait olduğu: seçim değiştiği anda eski mesajlar yeni kimlikle önbelleğe yazılmasın */
  const msgOwner = useRef<string | null>(null);
  useEffect(() => {
    if (selected && msgOwner.current === selected && messages.length) msgCache.current.set(selected, messages);
  }, [messages, selected]);
  useEffect(() => {
    msgOwner.current = selected;
    if (!selected) return void setMessages([]);
    let alive = true;
    const cached = msgCache.current.get(selected);
    setMessages(cached?.length ? cached : []);
    api
      .messages(selected)
      .then((m) => {
        if (!alive) return;
        // yeni gelenleri önbellekteki daha eski mesajlarla birleştir
        const prev = (msgCache.current.get(selected) ?? []).filter((x) => x.chatId === selected);
        const ids = new Set(m.map((x) => x.id));
        setMessages([...prev.filter((x) => !ids.has(x.id)), ...m].sort((x, y) => x.ts - y.ts));
        // hiç mesaj yoksa (örn. yalnızca sohbet listesinden geldi) platformdan geçmişi iste
        if (m.length === 0) api.loadHistory(selected).then(() => api.messages(selected)).then((m2) => alive && m2.length && setMessages(m2)).catch(() => undefined);
      })
      .catch((e) => notify(String(e.message), true));
    api.markRead(selected).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [selected, notify]);

  // ---- ertele ----
  const snooze = useCallback((chatId: string, hours = 24) => {
    setSnoozes((prev) => {
      const next = { ...prev, [chatId]: Date.now() + hours * 3_600_000 };
      localStorage.setItem(SNOOZE_KEY, JSON.stringify(next));
      return next;
    });
    setSelected((s) => (s === chatId ? null : s));
    notify(hours >= 24 ? 'Yarına ertelendi' : `${hours} saat ertelendi`);
  }, [notify]);
  const unsnooze = useCallback((chatId: string) => {
    setSnoozes((prev) => {
      const next = { ...prev };
      delete next[chatId];
      localStorage.setItem(SNOOZE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const isSnoozed = useCallback((id: string) => (snoozes[id] ?? 0) > Date.now(), [snoozes]);

  const complete = useCallback(
    (chatId: string) => {
      api.markRead(chatId).catch((e) => notify(e.message, true));
      notify('Tamamlandı');
    },
    [notify],
  );

  // ---- türetilmiş listeler ----
  const allChats = useMemo(() => [...chats.values()], [chats]);
  const activeChats = useMemo(() => allChats.filter((c) => !isSnoozed(c.id)), [allChats, isSnoozed]);
  const snoozedChats = useMemo(() => allChats.filter((c) => isSnoozed(c.id)).sort((a, b) => snoozes[a.id] - snoozes[b.id]), [allChats, isSnoozed, snoozes]);
  const waitingChats = useMemo(() => activeChats.filter(isWaiting).sort((a, b) => b.lastMessageAt - a.lastMessageAt), [activeChats]);
  const [storyPlatform, setStoryPlatform] = useState<Platform | null>(null);
  const storyChats = useMemo(() => (storyPlatform ? waitingChats.filter((c) => c.platform === storyPlatform) : waitingChats), [waitingChats, storyPlatform]);
  const storyPlatforms = useMemo(() => [...new Set(waitingChats.map((c) => c.platform))], [waitingChats]);

  const chatList = useMemo(() => {
    let list = [...activeChats];
    if (platformFilter) list = list.filter((c) => c.platform === platformFilter);
    // iMessage klasörleri: filtrelenmiş sohbetler (bilinmeyen/istenmeyen/SMS) gelen kutusunda görünmez; klasör seçilince yalnızca o klasör
    const imActive = platformFilter === 'imessage' ? imFolder : null;
    list = list.filter((c) => {
      if (c.platform !== 'imessage') return true;
      const folder = c.meta?.folder as string | undefined;
      if (imActive === 'deleted') return !!c.meta?.deleted;
      if (imActive === 'junk') return folder === 'junk' || folder === 'sms'; // istenmeyen + filtrelenen SMS
      if (imActive) return folder === imActive;
      return !folder;
    });
    if (tagFilter) list = list.filter((c) => c.tags.includes(tagFilter));
    if (filter === 'unread') list = list.filter((c) => c.unread > 0);
    if (filter === 'waiting') list = list.filter(isWaiting);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(q) || c.lastPreview.toLowerCase().includes(q));
    }
    list.sort((a, b) => (smartSort ? score(b) - score(a) : 0) || b.lastMessageAt - a.lastMessageAt);
    return list;
  }, [activeChats, filter, platformFilter, tagFilter, query, smartSort, imFolder]);

  const totals = useMemo(() => {
    let unread = 0;
    for (const c of activeChats) if (c.kind !== 'channel') unread += c.unread; // kanallardaki binlerce okunmamış rozeti şişirmesin
    return { unread, waiting: waitingChats.length };
  }, [activeChats, waitingChats]);
  /** Başlıktaki "N yeni": yalnızca görüntülenen kapsam (platform/etiket) */
  const scoped = useMemo(() => {
    let unread = 0;
    let waiting = 0;
    for (const c of activeChats) {
      if (platformFilter && c.platform !== platformFilter) continue;
      if (tagFilter && !c.tags.includes(tagFilter)) continue;
      if (c.kind !== 'channel') unread += c.unread;
      if (isWaiting(c)) waiting++;
    }
    return { unread, waiting };
  }, [activeChats, platformFilter, tagFilter]);

  const perPlatform = useMemo(() => {
    const m = new Map<Platform, number>();
    for (const c of activeChats) if (c.kind !== 'channel') m.set(c.platform, (m.get(c.platform) ?? 0) + c.unread);
    return m;
  }, [activeChats]);

  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of allChats) for (const t of c.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [allChats]);

  // ---- masaüstü ----
  useEffect(() => {
    void setBadge(totals.unread);
    if (!isTauri && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => undefined);
  }, [totals.unread]);
  useEffect(() => {
    let un = () => undefined as void;
    void onDesktopEvent('navigate', (to) => {
      if (to === 'focus') setView('focus');
    }).then((u) => (un = u));
    return () => un();
  }, []);

  // ---- klavye kısayolları ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setView('inbox');
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (typing) return;
      if (e.key === 'Escape') {
        if (connectOpen) setConnectOpen(false);
        else if (view !== 'inbox') setView('inbox');
        else setSelected(null);
        return;
      }
      if (view !== 'inbox' || e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = chatList.findIndex((c) => c.id === selected);
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        const n = chatList[Math.min(chatList.length - 1, idx + 1)];
        if (n) setSelected(n.id);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = chatList[Math.max(0, idx - 1)];
        if (n) setSelected(n.id);
      } else if (e.key === 'e' && selected) {
        complete(selected);
      } else if (e.key === 'h' && selected) {
        snooze(selected);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatList, selected, view, connectOpen, complete, snooze]);

  const chatAccounts = accounts.filter((a) => !PLATFORMS[a.platform].category);
  const mailAccounts = accounts.filter((a) => PLATFORMS[a.platform].category === 'mail');
  const shopAccounts = accounts.filter((a) => PLATFORMS[a.platform].category === 'shop');
  const renderChan = (a: Account) => (
        <button
          key={a.id}
          className={`chan b ${platformFilter === a.platform ? 'active' : ''}`}
          onClick={() => (setView('inbox'), setPlatformFilter(platformFilter === a.platform ? null : a.platform), setFilter('all'))}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, account: a });
          }}
          title={`${PLATFORMS[a.platform].name} · ${statusText(a.status)}${a.detail ? ' — ' + a.detail : ''}  (sağ tık: seçenekler)`}
        >
          <Chip platform={a.platform} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {PLATFORMS[a.platform].name}
            {handleOf(a) && <span className="handle"> ({handleOf(a)})</span>}
          </span>
          <span className="count">{perPlatform.get(a.platform) || ''}</span>
          <span className={`dot ${a.status}`} style={{ marginLeft: 8 }} />
        </button>  );

  const current = selected ? chats.get(selected) : undefined;
  const connectedPlatforms = [...new Set(accounts.filter((a) => a.status !== 'disconnected').map((a) => a.platform))];
  const goInbox = (f: Filter = 'all') => {
    setView('inbox');
    setFilter(f);
    setPlatformFilter(null);
    setTagFilter(null);
  };
  const openChat = (id: string) => {
    setView('inbox');
    setSelected(id);
  };

  return (
    <div className={`app ${isTauri ? 'tauri' : ''}`}>
      <nav className="sidebar" aria-label="Ana menü">
        <div className="brand" data-tauri-drag-region>
          <Logo />
          <span className="word">kavşak</span>
          <span title={online ? 'Çekirdek bağlı' : 'Çekirdek bağlantısı yok'} className={`dot ${online ? 'on' : 'error'}`} />
        </div>
        <label className="search">
          <Icon name="search" size={15} />
          <input ref={searchRef} placeholder="Ara veya komut yaz" value={query} onChange={(e) => (setQuery(e.target.value), setView('inbox'))} />
          <span className="kbd faint">⌘K</span>
        </label>
        <div className="nav">
          <NavItem icon="inbox" label="Gelen kutusu" count={totals.unread} active={view === 'inbox' && filter === 'all' && !platformFilter && !tagFilter} onClick={() => goInbox('all')} />
          <NavItem icon="sparkle" label="Odak" badge="AI" count={totals.waiting} active={view === 'focus'} onClick={() => setView('focus')} />
          <NavItem icon="bell" label="Ertelenenler" count={snoozedChats.length} active={view === 'snoozed'} onClick={() => setView('snoozed')} />
          <NavItem icon="archive" label="Okunmamış" count={0} active={view === 'inbox' && filter === 'unread' && !platformFilter && !tagFilter} onClick={() => goInbox('unread')} />
        </div>
        <div>
          <div className="section-head">
            <span className="label">Kanallar</span>
            <button className="btn ghost xs icon b" aria-label="Kanal ekle" onClick={() => setConnectOpen(true)}>
              <Icon name="plus" size={14} sw={2} />
            </button>
          </div>
          {accounts.length === 0 && (
            <button className="chan b" onClick={() => setConnectOpen(true)} style={{ color: 'var(--v-txt)' }}>
              <Icon name="plus" size={15} sw={2} /> İlk kanalını bağla
            </button>
          )}
          {chatAccounts.map((a) => renderChan(a))}
          {mailAccounts.length > 0 && (
            <div className="section-head" style={{ marginTop: 10 }}>
              <span className="label">E-posta</span>
            </div>
          )}
          {mailAccounts.map((a) => renderChan(a))}
          {shopAccounts.length > 0 && (
            <div className="section-head" style={{ marginTop: 10 }}>
              <span className="label">Alışveriş</span>
            </div>
          )}
          {shopAccounts.map((a) => renderChan(a))}
        </div>
        {(
          <div>
            <div className="section-head">
              <span className="label">Etiketler</span>
            </div>
            <div className="tagrow">
              {[...new Set([...DEFAULT_TAGS, ...allTags.map(([t]) => t)])].map((t) => (
                <button key={t} className={`tagbtn b ${tagFilter === t ? 'active' : ''}`} onClick={() => (setView('inbox'), setTagFilter(tagFilter === t ? null : t))}>
                  <span className="dot" style={{ background: tagDot(t) }} />
                  {t}
                  {allTags.find(([x]) => x === t)?.[1] ? <span className="c">{allTags.find(([x]) => x === t)![1]}</span> : null}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="privacy">
          <span style={{ width: 30, height: 30, borderRadius: 9, background: 'rgba(108,71,255,.11)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="lock" size={15} color="#6C47FF" sw={2} />
          </span>
          <span>
            <span className="t">Yerel ve şifreli</span>
            <span className="s">Mesajlar yalnızca bu bilgisayarda</span>
          </span>
        </div>
        <div className="me">
          <Avatar name="Kaan" size={32} />
          <span style={{ flexGrow: 1 }}>
            <span className="n">Kaan</span>
            <span className="s">{accounts.length} kanal · Pro</span>
          </span>
          <button className="btn ghost sm icon b" aria-label="Ayarlar" onClick={() => setSettingsOpen(!settingsOpen)}>
            <Icon name="sliders" size={16} />
          </button>
        </div>
        {settingsOpen && (
          <div className="settings" role="dialog" aria-label="Ayarlar">
            <div className="section-head" style={{ marginBottom: 6 }}>
              <span className="label">Bildirim sesi</span>
              <button className="btn ghost xs icon b" onClick={() => setSettingsOpen(false)} aria-label="Kapat">
                <Icon name="x" size={13} sw={2} />
              </button>
            </div>
            <label className="row-toggle">
              <span>Ses çal</span>
              <input type="checkbox" checked={sound !== 'off'} onChange={(e) => changeSound(e.target.checked ? 'cinlama' : 'off')} />
            </label>
            <div className="sound-list">
              {SOUNDS.map((sn) => (
                <button key={sn.id} className={`b ${sound === sn.id ? 'on' : ''}`} onClick={() => changeSound(sn.id)} disabled={sound === 'off'}>
                  <Icon name="volume" size={13} /> {sn.name}
                  <span
                    className="try"
                    role="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      playPing(sn.id, true);
                    }}
                  >
                    Dene
                  </span>
                </button>
              ))}
            </div>
            <div className="section-head" style={{ margin: '10px 0 6px' }}>
              <span className="label">Görünüm</span>
            </div>
            <label className="row-toggle">
              <span>Sağ ayrıntı paneli</span>
              <input type="checkbox" checked={showDetails} onChange={(e) => setShowDetails(e.target.checked)} />
            </label>
          </div>
        )}
      </nav>
      <Resizer pane="side" />

      {booting && (
        <div className="booting" role="status">
          <span className="spin" /> Çekirdek başlatılıyor…
        </div>
      )}
      <div className="surface">
        {view === 'focus' ? (
          <Focus waiting={waitingChats} chats={activeChats} ai={ai} notify={notify} onOpen={openChat} onSnooze={snooze} onComplete={complete} onBack={() => setView('inbox')} />
        ) : (
          <>
            <section className="list" aria-label="Sohbet listesi">
              <div className="list-head">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {platformFilter && view !== 'snoozed' && <Chip platform={platformFilter} size={26} />}
                  <h1>{view === 'snoozed' ? 'Ertelenenler' : platformFilter ? PLATFORMS[platformFilter].name : tagFilter ? capitalize(tagFilter) : 'Gelen kutusu'}</h1>
                  {view !== 'snoozed' && scoped.unread > 0 && <span className="pill">{scoped.unread} yeni</span>}
                  <span style={{ flexGrow: 1 }} />
                  <button className={`btn icon b b2 ${listSearch || query ? 'soft' : ''}`} aria-label="Sohbetlerde ara" title="Sohbetlerde ara" onClick={() => (setListSearch(!listSearch), listSearch && setQuery(''))}>
                    <Icon name="search" size={15} sw={2} />
                  </button>
                  <button className="btn icon primary b" aria-label="Kanal bağla" onClick={() => setConnectOpen(true)}>
                    <Icon name="plus" size={16} sw={2} />
                  </button>
                </div>

                {listSearch && (
                  <label className="search" style={{ margin: 0 }}>
                    <Icon name="search" size={15} />
                    <input autoFocus placeholder="Sohbetlerde ara (ad, son mesaj)" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), setListSearch(false))} />
                    {query && (
                      <button className="btn ghost xs icon b" aria-label="Temizle" onClick={() => setQuery('')}>
                        <Icon name="x" size={13} sw={2} />
                      </button>
                    )}
                  </label>
                )}
                {view === 'inbox' && (
                  <div className="tabs" role="tablist">
                    {(['all', 'unread', 'waiting'] as Filter[]).map((f) => (
                      <button key={f} role="tab" aria-selected={filter === f && !imFolder} className={filter === f && !imFolder ? 'active' : ''} onClick={() => (setFilter(f), setImFolder(null))}>
                        {f === 'all' ? (platformFilter === 'imessage' ? 'Mesajlar' : 'Tümü') : f === 'unread' ? 'Okunmamış ' : 'Bekleyen '}
                        {f === 'unread' && scoped.unread > 0 && <span className="c">{scoped.unread}</span>}
                        {f === 'waiting' && scoped.waiting > 0 && <span className="c amber">{scoped.waiting}</span>}
                      </button>
                    ))}
                    {platformFilter === 'imessage' &&
                      ([['unknown', 'Bilinmeyen gönderenler'], ['junk', 'İstenmeyen'], ['deleted', 'Son silinenler']] as Array<[typeof imFolder, string]>).map(([fo, label]) => (
                        <button key={String(fo)} role="tab" aria-selected={imFolder === fo} className={imFolder === fo ? 'active' : ''} onClick={() => (setImFolder(fo), setFilter('all'))}>
                          {label}
                        </button>
                      ))}
                  </div>
                )}

                {view === 'inbox' && totals.waiting > 0 && filter !== 'waiting' && (
                  <button className="brief b b2" onClick={() => setView('focus')}>
                    <span className="ico">
                      <Icon name="sparkle" size={17} color="#111016" sw={2} />
                    </span>
                    <span style={{ flexGrow: 1 }}>
                      <span className="t">{totals.waiting} kişi yanıt bekliyor</span>
                      <span className="s">{ai ? 'Taslakların hazır' : 'Odak modunda topluca yanıtla'}</span>
                    </span>
                    <span className="go">
                      Odak <Icon name="arrow" size={14} color="#6C47FF" sw={2} />
                    </span>
                  </button>
                )}
              </div>

              <div className="rows">
                {view === 'snoozed' ? (
                  snoozedChats.length === 0 ? (
                    <div className="empty">
                      Ertelenmiş sohbet yok.
                      <br />
                      Bir sohbeti <span className="kbd">H</span> ile yarına erteleyebilirsin.
                    </div>
                  ) : (
                    snoozedChats.map((c) => (
                      <ChatRow key={c.id} chat={c} selected={c.id === selected} onClick={() => setSelected(c.id)} snoozedUntil={snoozes[c.id]} onUnsnooze={() => unsnooze(c.id)} />
                    ))
                  )
                ) : chatList.length === 0 ? (
                  <div className="empty">
                    {chats.size === 0 ? (
                      <>
                        Henüz sohbet yok.
                        <br />
                        Bir kanal bağlayınca mesajlar burada görünür.
                      </>
                    ) : (
                      'Bu filtreye uyan sohbet yok.'
                    )}
                  </div>
                ) : (
                  groupByDay(chatList).map(([day, items]) => (
                    <div key={day} style={{ display: 'contents' }}>
                      <div className="group-label">
                        <span className="label">{day}</span>
                      </div>
                      {items.map((c) => (
                        <ChatRow key={c.id} chat={c} selected={c.id === selected} onClick={() => setSelected(c.id)} onComplete={() => complete(c.id)} onSnooze={() => snooze(c.id)} />
                      ))}
                    </div>
                  ))
                )}
                {query.trim().length >= 2 && hits.length > 0 && (
                  <div className="group">
                    <div className="label" style={{ padding: '10px 14px 4px' }}>Mesajlarda</div>
                    {hits.slice(0, 40).map(({ message: m, chat: c }) => (
                      <button key={m.id} className="row b" onClick={() => setSelected(c.id)} style={{ textAlign: 'left', width: '100%' }}>
                        <Avatar name={c.name} size={34} url={c.avatarUrl} />
                        <span style={{ minWidth: 0, flexGrow: 1 }}>
                          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                            <Chip platform={c.platform} size={14} />
                            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>{fmtTime(m.ts)}</span>
                          </span>
                          <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.fromMe ? 'Sen: ' : ''}{m.text}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="hints">
                <span>
                  <span className="kbd">J</span>
                  <span className="kbd">K</span> gezin
                </span>
                <span>
                  <span className="kbd">E</span> tamamla
                </span>
                <span>
                  <span className="kbd">H</span> ertele
                </span>
                <span>
                  <span className="kbd">⌘K</span> ara
                </span>
              </div>
            </section>
            <Resizer pane="list" />

            {current ? (
              <Conversation
                key={current.id}
                chat={current}
                messages={currentMessages}
                ai={ai}
                notify={notify}
                onSnooze={() => snooze(current.id)}
                onComplete={() => complete(current.id)}
                onTags={(tags) => api.setTags(current.id, tags).then((c) => setChats((p) => new Map(p).set(c.id, c))).catch((e) => notify(e.message, true))}
                showDetails={showDetails}
                onToggleDetails={() => setShowDetails(!showDetails)}
                olderBusy={olderBusy}
                hasOlder={noMoreOlder !== current.id}
                onLoadOlder={async () => {
                  const oldest = messages[0];
                  if (!oldest || olderBusy) return;
                  setOlderBusy(true);
                  try {
                    // önce depodaki daha eski mesajlar; depoda yoksa platformdan iste (WhatsApp/Telegram/Instagram/…)
                    let more = await api.messages(current.id, 300, oldest.ts);
                    if (more.length === 0) {
                      await api.loadHistory(current.id, oldest.ts, 100);
                      more = await api.messages(current.id, 300, oldest.ts);
                    }
                    if (more.length === 0) {
                      setNoMoreOlder(current.id);
                      notify('Daha eski mesaj yok');
                    }
                    setMessages((prev) => {
                      const ids = new Set(prev.map((m) => m.id));
                      return [...more.filter((m) => !ids.has(m.id)), ...prev];
                    });
                  } catch (e) {
                    notify((e as Error).message, true);
                  } finally {
                    setOlderBusy(false);
                  }
                }}
                onOpenChat={(c) => {
                  setChats((p) => new Map(p).set(c.id, c));
                  setSelected(c.id);
                }}
              />
            ) : (
              <section className="conv">
                <div className="empty" style={{ margin: 'auto', maxWidth: 380 }}>
                  <Logo size={40} />
                  <p style={{ marginTop: 12, fontSize: 15, color: 'var(--text2)' }}>
                    {accounts.length === 0 ? 'Başlamak için bir kanal bağla. WhatsApp için telefonundan QR okutman yeterli.' : 'Soldan bir sohbet seç.'}
                  </p>
                  {accounts.length === 0 && (
                    <button className="btn primary b" onClick={() => setConnectOpen(true)}>
                      <Icon name="plus" size={15} sw={2} /> Kanal bağla
                    </button>
                  )}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {connectOpen && (
        <ConnectModal accounts={accounts} qr={qr} prompts={prompts} connected={connectedPlatforms} onClose={() => setConnectOpen(false)} notify={notify} onChanged={refresh} />
      )}
      {menu && (
        <div className="menu-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => (e.preventDefault(), setMenu(null))}>
          <div className="menu" style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 170) }} onClick={(e) => e.stopPropagation()}>
            <div className="menu-head">
              <Chip platform={menu.account.platform} size={18} />
              <span style={{ fontWeight: 600 }}>{PLATFORMS[menu.account.platform].name}</span>
              <span className={`dot ${menu.account.status}`} style={{ marginLeft: 'auto' }} />
              <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>{statusText(menu.account.status)}</span>
            </div>
            <button onClick={() => (setMenu(null), setConnectOpen(true))}>
              <Icon name="sliders" size={14} /> Ayrıntı ve eşleşme
            </button>
            <button onClick={() => (setMenu(null), api.restartAccount(menu.account.id).then(() => notify('Yeniden bağlanılıyor')).catch((e) => notify(e.message, true)))}>
              <Icon name="refresh" size={14} sw={2} /> Yeniden bağlan
            </button>
            {menu.confirm ? (
              <div className="menu-confirm">
                <div>Bağlantı ve bu kanala ait yerel mesaj kayıtları silinecek.</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn sm b b2" style={{ flex: 1 }} onClick={() => setMenu({ ...menu, confirm: false })}>
                    Vazgeç
                  </button>
                  <button
                    className="btn sm danger-solid b b2"
                    style={{ flex: 1 }}
                    onClick={() => {
                      const acc = menu.account;
                      setMenu(null);
                      api
                        .removeAccount(acc.id)
                        .then(() => {
                          if (platformFilter === acc.platform) setPlatformFilter(null);
                          setSelected((sel) => (sel && chats.get(sel)?.accountId === acc.id ? null : sel));
                          notify('Kanal kaldırıldı');
                          return refresh();
                        })
                        .catch((e) => notify(e.message, true));
                    }}
                  >
                    Kaldır
                  </button>
                </div>
              </div>
            ) : (
              <button className="danger" onClick={() => setMenu({ ...menu, confirm: true })}>
                <Icon name="trash" size={14} /> Kaldır
              </button>
            )}
          </div>
        </div>
      )}
      {toast && <div className={`toast ${toast.err ? 'err' : ''}`}>{toast.text}</div>}
    </div>
  );
}

function statusText(s: Account['status']): string {
  return { connected: 'Bağlı', connecting: 'Bağlanıyor…', pairing: 'Eşleşme bekleniyor', disconnected: 'Bağlı değil', error: 'Hata' }[s];
}

/** Kanal satırında platform adının yanında gösterilecek hesap tanıtıcısı (@kullanıcı, +numara, ad) */
function handleOf(a: Account): string {
  const pn = PLATFORMS[a.platform].name.toLowerCase();
  const label = (a.label ?? '').trim();
  if (label && label.toLowerCase() !== pn && label.toLowerCase() !== a.platform) return label;
  if (a.status === 'connected' && a.detail && /^[+@]/.test(a.detail)) return a.detail;
  return '';
}

/** Son mesaj karşı taraftan geldiyse ve 20 dakikadır cevaplanmadıysa "yanıt bekliyor". */
export function isWaiting(c: Chat): boolean {
  return c.unread > 0 && Date.now() - c.lastMessageAt > 20 * 60_000;
}

/** Akıllı sıralama: yanıt bekleyenler ve etiketli müşteriler önce. */
function score(c: Chat): number {
  let s = 0;
  if (isWaiting(c)) s += 100 + Math.min(50, (Date.now() - c.lastMessageAt) / 3_600_000);
  if (c.unread) s += 20;
  if (c.tags.includes('müşteri')) s += 15;
  if (c.tags.includes('fırsat')) s += 12;
  if (c.kind !== 'direct') s -= 5;
  return s;
}

function tagDot(t: string): string {
  return { müşteri: '#22c55e', fırsat: '#fb923c', ekip: '#a78bfa', kişisel: '#f472b6' }[t] ?? '#b4b2a9';
}

function capitalize(s: string): string {
  return s.charAt(0).toLocaleUpperCase('tr-TR') + s.slice(1);
}

function groupByDay(list: Chat[]): Array<[string, Chat[]]> {
  const out = new Map<string, Chat[]>();
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  for (const c of list) {
    const d = new Date(c.lastMessageAt);
    const key = d.toDateString() === now.toDateString() ? 'Bugün' : d.toDateString() === y.toDateString() ? 'Dün' : 'Daha eski';
    out.set(key, [...(out.get(key) ?? []), c]);
  }
  return [...out.entries()];
}

function NavItem({ icon, label, count, active, onClick, badge, title }: { icon: string; label: string; count: number; active: boolean; onClick: () => void; badge?: string; title?: string }) {
  return (
    <button className={`nav-item b ${active ? 'active' : ''}`} onClick={onClick} title={title}>
      <Icon name={icon} size={17} color={active ? '#6C47FF' : '#6B6878'} />
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
        {label}
        {badge && <span className="pill lime" style={{ fontSize: 10, padding: '1px 5px', borderRadius: 5 }}>{badge}</span>}
      </span>
      {count > 0 && <span className="count">{count}</span>}
    </button>
  );
}

function ChatRow({
  chat,
  selected,
  onClick,
  onComplete,
  onSnooze,
  snoozedUntil,
  onUnsnooze,
}: {
  chat: Chat;
  selected: boolean;
  onClick: () => void;
  onComplete?: () => void;
  onSnooze?: () => void;
  snoozedUntil?: number;
  onUnsnooze?: () => void;
}) {
  const waiting = isWaiting(chat);
  return (
    <div className={`row ${selected ? 'selected' : ''} ${chat.unread ? 'unread' : ''}`} onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <span className="avwrap">
        <Avatar name={chat.name} size={44} url={chat.avatarUrl} />
        <Chip platform={chat.platform} size={17} ring={selected ? '#fff' : '#f7f6fa'} />
      </span>
      <span className="body">
        <span className="top">
          <span className="name">{chat.name}</span>
          <span className="time">{snoozedUntil ? `⏰ ${fmtTime(snoozedUntil)}` : fmtTime(chat.lastMessageAt)}</span>
        </span>
        <span className="top">
          <span className="prev">{chat.lastPreview || '…'}</span>
          {chat.unread > 0 && <span className="badge">{chat.unread}</span>}
        </span>
        {(chat.tags.length > 0 || waiting) && (
          <span className="tags">
            {chat.tags.slice(0, 2).map((t) => (
              <Tag key={t} name={t} />
            ))}
            {waiting && (
              <span className="wait">
                <Icon name="clock" size={12} sw={2} />
                {ago(chat.lastMessageAt)}
              </span>
            )}
          </span>
        )}
      </span>
      <span className="qa" onClick={(e) => e.stopPropagation()}>
        {onUnsnooze ? (
          <button title="Erteleyi kaldır" onClick={onUnsnooze}>
            <Icon name="bell" size={13} sw={2} />
          </button>
        ) : (
          <>
            <button title="Tamamla (E)" onClick={onComplete}>
              <Icon name="check" size={13} sw={2.2} />
            </button>
            <button title="Yarına ertele (H)" onClick={onSnooze}>
              <Icon name="clock" size={13} sw={2} />
            </button>
          </>
        )}
      </span>
    </div>
  );
}
