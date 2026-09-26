import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, connectEvents } from './api';
import { PLATFORMS, type Account, type Chat, type ChatFlags, type CoreEvent, type Message, type Platform, DEFAULT_TAGS } from './types';
import { Avatar, Chip, Icon, Logo, Resizer, SyncBar, Tag, ago, fmtTime, loadPaneSizes, useClosing } from './ui';
import { Conversation, REACT_TEXT, startScheduledSends } from './Conversation';
import { ConnectModal } from './Connect';
import { Focus } from './Focus';
import { MOD_KEY, isTauri, notify as desktopNotify, onDesktopEvent, playPing, SOUNDS, getPlatformSound, getPlatformTone, setPlatformSound, setPlatformTone, setBadge, windowFocused, coreInfo } from './desktop';
import { DEMO_OFFLINE, PROFILE_NAME, STATIC_DEMO } from './profile';
import { leaveDemoPanel } from './demo-session';
import { setAiPrefs, useAiPrefs } from './ai-prefs';

export type View = 'inbox' | 'focus' | 'archived' | 'muted' | 'hidden';
const FLAG_VIEWS: Array<{ view: View; flag: 'archived' | 'muted' | 'hidden'; label: string; icon: string; empty: string }> = [
  { view: 'archived', flag: 'archived', label: 'Arşiv', icon: 'archive', empty: 'Arşivlenmiş sohbet yok. Sağ paneldeki Eylemler’den arşivleyebilirsin.' },
  { view: 'muted', flag: 'muted', label: 'Sessiz', icon: 'mute', empty: 'Sessize alınmış sohbet yok.' },
  { view: 'hidden', flag: 'hidden', label: 'Gizli', icon: 'eyeoff', empty: 'Gizlenmiş sohbet yok.' },
];
export type Filter = 'all' | 'unread' | 'waiting' | 'followup';


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
  /** E-posta hesaplarında Gönderilenler / Gereksiz sekmesi */
  const [mailFolder, setMailFolder] = useState<'sent' | 'junk' | null>(null);
  /** Telegram: üstteki "Arşiv" sekmesi (chat.meta.archived) */
  const [tgArchive, setTgArchive] = useState(false);
  /** Platform seçimi değişince platforma özel sekmeler (iMessage klasörü, Telegram arşivi) sıfırlanır */
  const selectPlatform = useCallback((p: Platform | null) => {
    setMailFolder(null);
    setPlatformFilter(p);
    setImFolder(null);
    setTgArchive(false);
  }, []);
  const [olderBusy, setOlderBusy] = useState(false);
  const [noMoreOlder, setNoMoreOlder] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsP = useClosing(settingsOpen || null);
  const [lan, setLanState] = useState<{ enabled: boolean; urls: string[]; qr?: string } | null>(null);
  useEffect(() => {
    if (settingsOpen) api.lan().then(setLanState).catch(() => setLanState(null));
  }, [settingsOpen]);
  // Dar ekran (telefon): sol menü gizli, liste ↔ sohbet tek sütun
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 820);
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    const on = () => setIsMobile(window.innerWidth < 820);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  useEffect(() => {
    if (!isMobile) setNavOpen(false);
  }, [isMobile]);
  const [booting, setBooting] = useState(false);
  const [bootSince] = useState(() => Date.now());
  const [pSounds, setPSounds] = useState<Record<string, string>>({});
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const appSettingsP = useClosing(appSettingsOpen || null);
  const changePlatformTone = (platform: string, id: string) => {
    setPlatformTone(platform, id);
    const cur = pSounds[platform] ?? getPlatformSound(platform);
    if (cur !== 'off') {
      setPlatformSound(platform, id);
      setPSounds((p) => ({ ...p, [platform]: id }));
    }
    playPing(id, true);
  };
  const changePlatformNotify = (platform: string, on: boolean) => {
    const tone = getPlatformTone(platform);
    const id = on ? tone : 'off';
    setPlatformSound(platform, id);
    setPSounds((p) => ({ ...p, [platform]: id }));
    if (on) playPing(tone, true);
  };
  /** Mobil: sağ panel tam ekran kaydırmalı kart olarak, yalnızca isteyince (avatar/isme dokununca) */
  const [mobileDetails, setMobileDetails] = useState(false);
  useEffect(() => setMobileDetails(false), [selected]);
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
  /** Kenar çubuğunda kanal sırası (hesap kimlikleri) */
  const [chanOrder, setChanOrder] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('kavsak.chanOrder') ?? '[]') as string[];
    } catch {
      return [];
    }
  });
  /** Daha eski sohbet listesi (e-postalar): platform seçiliyken listenin sonuna gelince */
  const [moreBusy, setMoreBusy] = useState(false);
  const moreDone = useRef<Set<string>>(new Set());
  const onRowsScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (!platformFilter || moreBusy || el.scrollHeight - el.scrollTop - el.clientHeight > 140) return;
    const acc = accounts.find((a) => a.platform === platformFilter && a.status === 'connected');
    if (!acc || moreDone.current.has(acc.id)) return;
    setMoreBusy(true);
    api
      .moreChats(acc.id)
      .then((r) => {
        if (!r.supported || r.added === 0) moreDone.current.add(acc.id);
      })
      .catch(() => moreDone.current.add(acc.id))
      .finally(() => setMoreBusy(false));
  };
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
  /** Bağlanma/eşitleme ilerlemesi: hesap → {progress 0-100, since} (0/100 → gizli) */
  const [sync, setSync] = useState<Record<string, { progress: number; since: number; label?: string }>>({});
  /** Karşı taraf yazıyor: sohbet → {ad, düşme zamanı}; 6 sn'de kendiliğinden düşer */
  const [typing, setTyping] = useState<Record<string, { name?: string; until: number }>>({});
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now();
      setTyping((prev) => {
        const next: typeof prev = {};
        let changed = false;
        for (const [id, v] of Object.entries(prev)) {
          if (v.until > now) next[id] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);
  const [prompts, setPrompts] = useState<Record<string, { prompt: 'phone' | 'code' | 'password'; message: string }>>({});
  const [ai, setAi] = useState(false);
  const aiPrefs = useAiPrefs();
  const [online, setOnline] = useState(false);
  const [toast, setToast] = useState<{ text: string; err?: boolean } | null>(null);
  /** Pencere öndeyken başka sohbete gelen mesaj: sağ üstte platform rozetli küçük kart (sistem bildirimi kapalı olabilir) */
  const [inToasts, setInToasts] = useState<Array<{ id: number; chat: Chat; text: string }>>([]);
  const inToastSeq = useRef(0);
  const pushInToast = useCallback((chat: Chat, text: string) => {
    const id = ++inToastSeq.current;
    setInToasts((prev) => [...prev.slice(-2), { id, chat, text }]);
    window.setTimeout(() => setInToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }, []);
  const [menu, setMenu] = useState<{ x: number; y: number; account: Account; confirm?: boolean } | null>(null);
  const menuP = useClosing(menu);
  const connectP = useClosing(connectOpen || null);

  const [, tick] = useState(0);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  /** sohbet → son yeniden 'okundu' işaretleme zamanı */
  const reReadAt = useRef(new Map<string, number>());
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
    // uygulama kapalıyken zamanı geçen zamanlanmış mesajlar sessizce gönderilmez (Conversation.tsx flushScheduled)
    const onMissed = (e: Event) => notify(`${(e as CustomEvent<number>).detail} zamanlanmış mesaj uygulama kapalıyken zamanını kaçırdı; gönderilmedi.`, true);
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    window.addEventListener('mivelo:scheduled-missed', onMissed);
    return () => {
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
      window.removeEventListener('mivelo:scheduled-missed', onMissed);
    };
  }, [notify]);

  useEffect(() => {
    // Paketli uygulamada çekirdek arayüzden 1-3 sn sonra ayağa kalkar: hata göstermeden önce bekle
    let cancelled = false;
    // Açılış eşitlemesi: ilk 60 sn içinde gelen "canlı" mesajlar da bildirim çalmasın (geçmiş yeni gelmiş gibi görünmesin)
    const bootTs = Date.now();
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
          // Açık ve önde olan sohbete platform yoklaması 'okunmamış' geri yazdıysa (platform okunduyu geç işledi) yeniden işaretle;
          // sohbet başına en çok dakikada bir (döngü olmasın)
          if (ev.chat.id === selectedRef.current && ev.chat.unread > 0 && Date.now() - (reReadAt.current.get(ev.chat.id) ?? 0) > 60_000) {
            reReadAt.current.set(ev.chat.id, Date.now());
            void windowFocused().then((f) => f && api.markRead(ev.chat.id)).catch(() => undefined);
          }
          break;
        case 'chat.delete':
          pendingChats.delete(ev.chatId);
          pendingDeletes.add(ev.chatId);
          if (flushTimer === undefined) flushTimer = window.setTimeout(flushChats, 150);
          setSelected((sel) => (sel === ev.chatId ? null : sel));
          break;
        case 'account.sync':
          setSync((prev) => {
            if (ev.progress <= 0 || ev.progress >= 100) {
              if (!(ev.accountId in prev)) return prev;
              const next = { ...prev };
              delete next[ev.accountId];
              return next;
            }
            const cur = prev[ev.accountId];
            return { ...prev, [ev.accountId]: { progress: Math.max(ev.progress, cur?.progress ?? 0), since: cur?.since ?? Date.now(), label: ev.label } };
          });
          break;
        case 'chat.typing':
          setTyping((prev) => {
            if (!ev.typing) {
              if (!(ev.chatId in prev)) return prev;
              const next = { ...prev };
              delete next[ev.chatId];
              return next;
            }
            return { ...prev, [ev.chatId]: { name: ev.name, until: Date.now() + 6000 } };
          });
          break;
        case 'messages.read':
          if (ev.chatId === selectedRef.current) setMessages((prev) => prev.map((m) => (m.fromMe && m.ts <= ev.before && m.status !== 'read' ? { ...m, status: 'read' } : m)));
          break;
        case 'chat.followup': {
          // takip hatırlatıcısı: süre doldu, yanıt gelmedi
          queueChat(ev.chat);
          const body = 'Yanıt gelmedi. Takip etmek ister misin?';
          void windowFocused().then((focused) => {
            if (focused) pushInToast(ev.chat, `⏰ ${body}`);
            else desktopNotify(`Takip: ${ev.chat.name}`, body);
            playPing(getPlatformSound(ev.chat.platform) || undefined);
          });
          break;
        }
        case 'message.delete':
          if (ev.chatId === selectedRef.current) setMessages((prev) => prev.filter((m) => m.id !== ev.messageId));
          break;
        case 'message.upsert':
          queueChat(ev.chat);
          // yalnızca canlı gelen (eşitleme/geçmiş değil) ve yeni mesajlar bildirim çalsın
          if (ev.live && !ev.message.fromMe && !ev.chat.muted && !ev.chat.hidden && !ev.chat.archived && Date.now() - bootTs > 60_000 && Date.now() - ev.message.ts < 120_000) {
            void windowFocused().then((focused) => {
              if (!focused || ev.message.chatId !== selectedRef.current) {
                const body = (ev.message.text || ev.message.attachments?.[0]?.name || 'Yeni mesaj').slice(0, 140);
                // pencere öndeyse sistem bildirimi yerine uygulama içi kart (hangi platformdan geldiği belli olsun)
                if (focused) pushInToast(ev.chat, body);
                else desktopNotify(ev.chat.name, body);
                // uygulama başına ses ('' → genel ayar, 'off' → sessiz)
                const ps = getPlatformSound(ev.chat.platform);
                playPing(ps || undefined);
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


  // ---- türetilmiş listeler ----
  const allChats = useMemo(() => [...chats.values()], [chats]);
  const activeChats = allChats;
  /**
   * Gelen kutusu, sayaçlar ve odak için sohbetler: arşivlenmiş (Telegram) ve klasörlenmiş (iMessage bilinmeyen/istenmeyen/SMS)
   * sohbetler dışarıda kalır; onlar yalnızca kendi sekmelerinde görünür.
   */
  const inboxChats = useMemo(() => activeChats.filter((c) => !c.meta?.archived && !c.archived && !c.muted && !c.hidden && !(c.platform === 'imessage' && c.meta?.folder === 'junk') && !(PLATFORMS[c.platform].category === 'mail' && (c.meta?.folder === 'junk' || c.meta?.folder === 'sent'))), [activeChats]);
  /** Arşiv / Sessiz / Gizli görünümleri (yerel bayraklar) */
  const flagged = useMemo(() => {
    const by = (k: 'archived' | 'muted' | 'hidden') => allChats.filter((c) => c[k]).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return { archived: by('archived'), muted: by('muted'), hidden: by('hidden') };
  }, [allChats]);
  const pinnedChats = useMemo(() => inboxChats.filter((c) => c.pinned).sort((a, b) => b.lastMessageAt - a.lastMessageAt), [inboxChats]);
  const setFlags = useCallback(
    (id: string, f: ChatFlags) => {
      api
        .setFlags(id, f)
        .then((c) => {
          setChats((p) => new Map(p).set(c.id, c));
          const what = f.pinned === true ? 'Sabitlendi' : f.pinned === false ? 'Sabitleme kaldırıldı' : f.archived === true ? 'Arşivlendi' : f.archived === false ? 'Arşivden çıkarıldı' : f.muted === true ? 'Sessize alındı' : f.muted === false ? 'Ses açıldı' : f.hidden === true ? 'Gizlendi' : f.hidden === false ? 'Gizleme kaldırıldı' : 'Güncellendi';
          notify(what);
        })
        .catch((e) => notify((e as Error).message, true));
    },
    [notify],
  );
  /** Yeni sohbet / yeni e-posta bölmesi: açıkken sağ bölmede (popup değil); platform, o anki uygulama filtresinden ya da yazılan tanıtıcıdan */
  const [composeOpen, setComposeOpen] = useState(false);
  useEffect(() => setComposeOpen(false), [selected]);
  const archivedCount = useMemo(() => activeChats.filter((c) => c.platform === platformFilter && !!c.meta?.archived).length, [activeChats, platformFilter]);
  const waitingChats = useMemo(() => inboxChats.filter(isWaiting).sort((a, b) => b.lastMessageAt - a.lastMessageAt), [inboxChats]);
  const [storyPlatform, setStoryPlatform] = useState<Platform | null>(null);
  const storyChats = useMemo(() => (storyPlatform ? waitingChats.filter((c) => c.platform === storyPlatform) : waitingChats), [waitingChats, storyPlatform]);
  const storyPlatforms = useMemo(() => [...new Set(waitingChats.map((c) => c.platform))], [waitingChats]);

  const chatList = useMemo(() => {
    // Telegram "Arşiv" sekmesi yalnızca arşivlenmişleri, iMessage klasör sekmeleri o klasörü; diğer her görünüm gelen kutusunu listeler
    const imActive = platformFilter === 'imessage' ? imFolder : null;
    const mailActive = platformFilter && PLATFORMS[platformFilter].category === 'mail' ? mailFolder : null;
    let list = platformFilter === 'telegram' && tgArchive ? activeChats.filter((c) => c.platform === 'telegram' && !!c.meta?.archived) : imActive ? activeChats : mailActive ? activeChats.filter((c) => c.platform === platformFilter && (mailActive === 'junk' ? c.meta?.folder === 'junk' : c.meta?.folder === 'sent' || (c.meta?.folder !== 'junk' && !!c.lastFromMe))) : [...inboxChats];
    if (platformFilter) list = list.filter((c) => c.platform === platformFilter);
    // iMessage klasörleri: filtrelenmiş sohbetler (bilinmeyen/istenmeyen/SMS) gelen kutusunda görünmez; klasör seçilince yalnızca o klasör
    list = list.filter((c) => {
      if (c.platform !== 'imessage') return true;
      const folder = c.meta?.folder as string | undefined;
      if (imActive === 'deleted') return !!c.meta?.deleted;
      if (imActive === 'junk') return folder === 'junk';
      if (imActive) return folder === imActive;
      // "Mesajlar": tümü (istenmeyen hariç) — son gelenlerin çoğu bilinmeyen gönderenlerden
      return folder !== 'junk';
    });
    if (tagFilter) list = list.filter((c) => c.tags.includes(tagFilter));
    // iMessage'da Okunmamış/Bekleyen sekmeleri yok (Mesajlar uygulamasındaki klasörler var)
    const effFilter = platformFilter === 'imessage' && filter !== 'followup' ? 'all' : filter;
    if (effFilter === 'unread') list = list.filter((c) => c.unread > 0);
    if (effFilter === 'waiting') list = list.filter(isWaiting);
    if (filter === 'followup') list = list.filter((c) => !!c.followUp).sort((a, b) => Number(!!b.followUp?.due) - Number(!!a.followUp?.due) || (a.followUp?.at ?? 0) - (b.followUp?.at ?? 0));
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(q) || c.lastPreview.toLowerCase().includes(q));
    }
    // Takip sekmesi kendi sırasında kalır: süresi dolanlar önce, sonra en yakın hatırlatma
    if (filter !== 'followup') list.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (smartSort ? score(b) - score(a) : 0) || b.lastMessageAt - a.lastMessageAt);
    return list;
  }, [activeChats, inboxChats, filter, platformFilter, tagFilter, query, smartSort, imFolder, tgArchive, mailFolder]);

  /** Boş liste metni: hangi sekme/filtre boşsa ona göre anlamlı bir açıklama */
  const emptyText = filter === 'followup' ? 'Takipte sohbet yok. Sohbetin sağ panelinden "Yanıt gelmezse hatırlat" ile ekle.' : imFolder || tgArchive || mailFolder ? 'Bu klasörde sohbet yok.' : query.trim() ? 'Aramayla eşleşen sohbet yok.' : filter === 'unread' && platformFilter !== 'imessage' ? 'Okunmamış sohbet yok.' : tagFilter ? 'Bu etikette sohbet yok.' : platformFilter ? 'Bu kanalda henüz sohbet yok.' : 'Bu filtreye uyan sohbet yok.';

  const totals = useMemo(() => {
    let unread = 0;
    for (const c of inboxChats) unread += countable(c);
    return { unread, waiting: waitingChats.length };
  }, [inboxChats, waitingChats]);
  /** Başlıktaki "N yeni": yalnızca görüntülenen kapsam (platform/etiket) */
  const scoped = useMemo(() => {
    let unread = 0;
    for (const c of inboxChats) {
      if (platformFilter && c.platform !== platformFilter) continue;
      if (tagFilter && !c.tags.includes(tagFilter)) continue;
      unread += countable(c);
    }
    return { unread };
  }, [inboxChats, platformFilter, tagFilter]);

  const perPlatform = useMemo(() => {
    const m = new Map<Platform, number>();
    for (const c of inboxChats) m.set(c.platform, (m.get(c.platform) ?? 0) + countable(c));
    return m;
  }, [inboxChats]);

  /** Takip hatırlatıcısı kurulu sohbetler (sekme sayacı; süresi dolanlar ayrıca) */
  const follow = useMemo(() => {
    let n = 0, due = 0;
    for (const c of allChats) {
      if (!c.followUp) continue;
      if (platformFilter && c.platform !== platformFilter) continue;
      n++;
      if (c.followUp.due) due++;
    }
    return { n, due };
  }, [allChats, platformFilter]);

  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of allChats) for (const t of c.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [allChats]);

  /** Görünümler (⌘1 Tümü, ⌘2… etiketler): kenar çubuğundaki etiket sırasıyla aynı */
  const viewTags = useMemo(() => [...new Set([...DEFAULT_TAGS, ...allTags.map(([t]) => t)])].slice(0, 8), [allTags]);

  // ---- masaüstü ----
  useEffect(() => {
    startScheduledSends();
  }, []);
  useEffect(() => {
    void setBadge(Math.min(totals.unread, 999));
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
        setListSearch(true);
        requestAnimationFrame(() => {
          searchRef.current?.focus();
          searchRef.current?.select();
        });
        return;
      }
      // ⌘1 Tümü, ⌘2… etiket görünümleri (Windows'ta Ctrl); yazarken de çalışır
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const n = Number(e.key);
        if (n === 1 || viewTags[n - 2]) {
          e.preventDefault();
          setView('inbox');
          setFilter('all');
          setTagFilter(n === 1 ? null : viewTags[n - 2]);
        }
        return;
      }
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return; // bir katman (medya penceresi, açılır menü) Esc'i zaten kullandı
        // önce en üstteki pencere/menü kapanır; sohbet ancak hiçbiri açık değilse
        if (appSettingsOpen) setAppSettingsOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (typing) return;
        else if (connectOpen) setConnectOpen(false);
        else if (view !== 'inbox') setView('inbox');
        else setSelected(null);
        return;
      }
      if (typing) return;
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatList, selected, view, connectOpen, viewTags, settingsOpen, appSettingsOpen]);

  const orderedAccounts = useMemo(() => {
    const idx = new Map(chanOrder.map((id, i) => [id, i]));
    return [...accounts].sort((a, b) => (idx.get(a.id) ?? 1e9) - (idx.get(b.id) ?? 1e9));
  }, [accounts, chanOrder]);
  const chatAccounts = orderedAccounts.filter((a) => !PLATFORMS[a.platform].category);
  const mailAccounts = orderedAccounts.filter((a) => PLATFORMS[a.platform].category === 'mail');
  const shopAccounts = orderedAccounts.filter((a) => PLATFORMS[a.platform].category === 'shop');
  /** Kanalı listede taşı: hedefin önüne (aynı kategori içinde) */
  const moveChan = (id: string, targetId: string, after = false) => {
    if (id === targetId) return;
    const ids = orderedAccounts.map((a) => a.id).filter((x) => x !== id);
    const at = ids.indexOf(targetId);
    ids.splice(after ? at + 1 : at, 0, id);
    setChanOrder(ids);
    try {
      localStorage.setItem('kavsak.chanOrder', JSON.stringify(ids));
    } catch {
      /* yok */
    }
  };
  const [dragId, setDragId] = useState<string | null>(null);
  /** Aynı gruptaki hedef sıra (sürüklenen satırın gideceği indeks) */
  const [dragTo, setDragTo] = useState<number | null>(null);
  /** Sürüklenen satırın sabit konumlu hayaleti: satırı yerinde dönüştürmek kaydırma alanını büyütüp titretiyordu */
  const [ghost, setGhost] = useState<{ top: number; left: number; width: number } | null>(null);
  const dragStart = useRef({ y: 0, top: 0, left: 0, width: 0 });
  const dragRaf = useRef(0);
  /** Sürükleme başındaki sabit yuvalar: kayan satırların dönüşümü ölçümü bozmasın */
  const dragSlots = useRef<{ id: string; top: number }[]>([]);
  const dragPitch = useRef(30);
  const dragToRef = useRef<number | null>(null);
  const dragIdRef = useRef<string | null>(null);
  /** Gruptaki satır, boşalan yuvayı doldurmak için kaç piksel kaysın (0: yerinde) */
  const chanShift = (id: string, group: Account[]) => {
    if (!dragId || dragTo == null) return 0;
    const from = group.findIndex((x) => x.id === dragId);
    if (from < 0) return 0;
    const i = group.findIndex((x) => x.id === id);
    if (i < 0 || i === from) return 0;
    if (dragTo < from && i >= dragTo && i < from) return dragPitch.current;
    if (dragTo > from && i > from && i <= dragTo) return -dragPitch.current;
    return 0;
  };
  const renderChan = (a: Account, group: Account[]) => {
        const shift = chanShift(a.id, group);
        return (
        <button
          key={a.id}
          className={`chan b ${platformFilter === a.platform ? 'active' : ''} ${dragId === a.id ? 'dragging' : ''}`}
          data-acc={a.id}
          style={shift ? { transform: `translateY(${shift}px)` } : undefined}
          onClick={() => (setView('inbox'), selectPlatform(platformFilter === a.platform ? null : a.platform), setFilter('all'))}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, account: a });
          }}
          title={`${PLATFORMS[a.platform].name} · ${statusText(a.status)}${a.detail ? ' — ' + a.detail : ''}  (sağ tık: seçenekler)`}
        >
          <span
            className="grip"
            title="Sürükleyip sırala"
            aria-label="Sırala"
            onClick={(e) => e.stopPropagation()}
            // HTML5 sürükle-bırak WKWebView/Tauri'de güvenilir değil: işaretçi olaylarıyla (pointer capture) sıralama
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              const row = (e.currentTarget as HTMLElement).closest('.chan') as HTMLElement | null;
              const rr = row?.getBoundingClientRect();
              const nodes = group.map((acc) => document.querySelector<HTMLElement>(`.chan[data-acc="${acc.id}"]`));
              const rects = nodes.map((el) => el?.getBoundingClientRect());
              dragSlots.current = group.map((acc, i) => ({ id: acc.id, top: rects[i]?.top ?? 0 }));
              const tops = dragSlots.current.map((s) => s.top);
              dragPitch.current = tops.length > 1 ? tops[1] - tops[0] : (rr?.height ?? 30);
              const from = group.findIndex((x) => x.id === a.id);
              dragToRef.current = from;
              dragIdRef.current = a.id;
              dragStart.current = { y: e.clientY, top: rr?.top ?? e.clientY, left: rr?.left ?? e.clientX, width: rr?.width ?? 200 };
              setGhost({ top: dragStart.current.top, left: dragStart.current.left, width: dragStart.current.width });
              setDragTo(from);
              setDragId(a.id);
            }}
            onPointerMove={(e) => {
              if (dragIdRef.current !== a.id) return;
              const { clientY } = e;
              cancelAnimationFrame(dragRaf.current);
              dragRaf.current = requestAnimationFrame(() => {
                const st = dragStart.current;
                setGhost({ top: st.top + (clientY - st.y), left: st.left, width: st.width });
                const slots = dragSlots.current;
                const pitch = dragPitch.current;
                if (!slots.length) return;
                let to = slots.length - 1;
                for (let i = 0; i < slots.length; i++) {
                  if (clientY < slots[i].top + pitch) {
                    to = i;
                    break;
                  }
                }
                const cur = dragToRef.current;
                if (cur != null && Math.abs(to - cur) === 1) {
                  const boundary = slots[Math.min(to, cur)].top + pitch;
                  if (Math.abs(clientY - boundary) < 5) to = cur;
                }
                if (to !== dragToRef.current) {
                  dragToRef.current = to;
                  setDragTo(to);
                }
              });
            }}
            onPointerUp={(e) => {
              (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
              const slots = dragSlots.current;
              const from = slots.findIndex((s) => s.id === a.id);
              const to = dragToRef.current;
              cancelAnimationFrame(dragRaf.current);
              if (dragIdRef.current === a.id && to != null && from >= 0 && to !== from) {
                document.querySelectorAll<HTMLElement>('.sidebar .chan').forEach((el) => {
                  el.style.transition = 'none';
                });
                moveChan(a.id, slots[to].id, to > from);
                requestAnimationFrame(() => {
                  document.querySelectorAll<HTMLElement>('.sidebar .chan').forEach((el) => {
                    el.style.transition = '';
                  });
                });
              }
              dragIdRef.current = null;
              dragToRef.current = null;
              setDragId(null);
              setDragTo(null);
              setGhost(null);
            }}
            onPointerCancel={() => {
              dragIdRef.current = null;
              dragToRef.current = null;
              setDragId(null);
              setDragTo(null);
              setGhost(null);
            }}
          >
            <Icon name="grip" size={13} sw={2} />
          </span>
          <Chip platform={a.platform} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {PLATFORMS[a.platform].name}
            {handleOf(a) && <span className="handle"> ({handleOf(a)})</span>}
          </span>
          <span className="count">{fmtCount(perPlatform.get(a.platform) ?? 0)}</span>
          <span className={`dot ${a.status}`} style={{ marginLeft: 8 }} />
          {sync[a.id] && <SyncBar compact progress={/%\d+/.test(a.detail ?? '') ? Number((a.detail ?? '').match(/%(\d+)/)?.[1] ?? 0) : sync[a.id].progress} since={sync[a.id].since} />}
        </button>
        );
  };

  const current = selected ? chats.get(selected) : undefined;
  const connectedPlatforms = [...new Set(accounts.filter((a) => a.status !== 'disconnected').map((a) => a.platform))];
  const goInbox = (f: Filter = 'all') => {
    setView('inbox');
    setFilter(f);
    selectPlatform(null);
    setTagFilter(null);
  };
  /** Odak'tan açılışta kompozöre taşınacak taslak/niyet (Düzenle, Nazik hatırlatma yaz) */
  const [seed, setSeed] = useState<{ id: string; text?: string; autoDraft?: boolean } | null>(null);
  const openChat = (id: string, s?: { text?: string; autoDraft?: boolean }) => {
    setSeed(s ? { id, ...s } : null);
    setView('inbox');
    setSelected(id);
  };

  return (
    <div className={`app ${isTauri ? 'tauri' : ''} ${isMobile ? 'mobile' : ''} ${isMobile && selected ? 'm-conv' : ''} ${isMobile && navOpen ? 'nav-open' : ''}`}>
      {isMobile && navOpen && <button className="nav-backdrop" aria-label="Menüyü kapat" onClick={() => setNavOpen(false)} />}
      <nav
        className="sidebar"
        aria-label="Ana menü"
        onClick={(e) => {
          if (!isMobile) return;
          const t = e.target as HTMLElement;
          if (t.closest('.settings, .me, .search, label')) return;
          if (t.closest('button, .chan, .nav-item, .tagbtn')) setNavOpen(false);
        }}
      >
        <div className="brand" data-tauri-drag-region>
          <Logo />
          <span className="word">mivelo</span>
          <span title={online ? 'Çekirdek bağlı' : 'Çekirdek bağlantısı yok'} className={`dot ${online ? 'on' : 'error'}`} />
        </div>
        <button className="btn connect-app" onClick={() => setConnectOpen(true)}>
          Uygulama bağla
        </button>
        <div className="nav">
          <NavItem icon="inbox" label="Gelen kutusu" count={totals.unread} active={view === 'inbox' && filter === 'all' && !platformFilter && !tagFilter} onClick={() => goInbox('all')} />
          <NavItem icon="sparkle" label="Odak" badge="AI" count={totals.waiting} active={view === 'focus'} onClick={() => setView('focus')} />
          <NavItem icon="archive" label="Okunmamış" count={totals.unread} active={view === 'inbox' && filter === 'unread' && !platformFilter && !tagFilter} onClick={() => goInbox('unread')} />
          {FLAG_VIEWS.filter((f) => f.view === 'archived' || flagged[f.flag].length > 0).map((f) => (
            <NavItem key={f.view} icon={f.icon} label={f.label} count={flagged[f.flag].length} active={view === f.view} onClick={() => setView(f.view)} />
          ))}
        </div>
        <div className="side-scroll">
          {(chatAccounts.length > 0 || accounts.length === 0) && (
            <div className="section-head">
              <span className="label">Uygulamalar</span>
            </div>
          )}
          {accounts.length === 0 && (
            <button className="chan b" onClick={() => setConnectOpen(true)} style={{ color: 'var(--v-txt)' }}>
              <Icon name="plus" size={15} sw={2} /> İlk uygulamanı bağla
            </button>
          )}
          {chatAccounts.map((a) => renderChan(a, chatAccounts))}
          {mailAccounts.length > 0 && (
            <div className="section-head" style={{ marginTop: chatAccounts.length > 0 ? 10 : 0 }}>
              <span className="label">E-posta</span>
            </div>
          )}
          {mailAccounts.map((a) => renderChan(a, mailAccounts))}
          {shopAccounts.length > 0 && (
            <div className="section-head" style={{ marginTop: chatAccounts.length > 0 || mailAccounts.length > 0 ? 10 : 0 }}>
              <span className="label">Alışveriş</span>
            </div>
          )}
          {shopAccounts.map((a) => renderChan(a, shopAccounts))}
        </div>
        {(
          <div className="side-tags">
            <div className="section-head">
              <span className="label">Etiketler</span>
            </div>
            <div className="tagrow">
              {[...new Set([...DEFAULT_TAGS, ...allTags.map(([t]) => t)])].map((t) => (
                <button key={t} className={`tagbtn b ${tagFilter === t ? 'active' : ''}`} title={viewTags.indexOf(t) >= 0 ? `${MOD}${viewTags.indexOf(t) + 2}` : undefined} onClick={() => (setView('inbox'), setTagFilter(tagFilter === t ? null : t))}>
                  <span className="dot" style={{ background: tagDot(t) }} />
                  {t}
                  {allTags.find(([x]) => x === t)?.[1] ? <span className="c">{allTags.find(([x]) => x === t)![1]}</span> : null}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="me">
          <Avatar name={PROFILE_NAME} size={32} />
          <span style={{ flexGrow: 1 }}>
            <span className="n">{PROFILE_NAME}</span>
            <span className="s">{accounts.length} uygulama{STATIC_DEMO ? '' : ' · Pro'}</span>
          </span>
          <button className="btn ghost sm icon b" aria-label="Ayarlar" onClick={() => setSettingsOpen(!settingsOpen)}>
            <Icon name="sliders" size={16} />
          </button>
        </div>
        {settingsP.value && (
          <div className={`settings ${settingsP.closing ? 'closing' : ''}`} role="dialog" aria-label="Ayarlar">
            <div className="section-head" style={{ marginBottom: 6 }}>
              <span className="label">Ayarlar</span>
              <button className="btn ghost xs icon b" onClick={() => setSettingsOpen(false)} aria-label="Kapat">
                <Icon name="x" size={13} sw={2} />
              </button>
            </div>
            <button className="row-toggle b psounds-head" onClick={() => setAppSettingsOpen(true)}>
              <span>Uygulama ayarları</span>
              <span style={{ display: 'inline-flex', transform: 'rotate(-90deg)' }}>
                <Icon name="chev" size={14} sw={2} />
              </span>
            </button>
            {/* AI senin kontrolünde: her özellik ayrı açılıp kapanır (cihaza özel) */}
            <span className="set-sub">AI özellikleri{!ai && <em> · anahtar yok</em>}</span>
            <AiKeyRow ai={ai} onChange={(on) => setAi(on)} notify={notify} />
            {(
              [
                ['summary', 'Özetler'],
                ['drafts', 'Taslaklar'],
                ['actions', 'Aksiyon çıkarma'],
              ] as const
            ).map(([k, l]) => (
              <label key={k} className="row-toggle">
                <span>{l}</span>
                <input type="checkbox" checked={aiPrefs[k]} onChange={(e) => setAiPrefs({ [k]: e.target.checked })} />
              </label>
            ))}
            <span className="set-sub">Genel</span>
            <label className="row-toggle">
              <span>Aynı Wi‑Fi'daki telefondan aç{STATIC_DEMO && <em className="set-hint">Masaüstü uygulamasında</em>}</span>
              <input type="checkbox" disabled={STATIC_DEMO} checked={!!lan?.enabled} onChange={(e) => api.setLan(e.target.checked).then(setLanState).catch((err) => notify(err.message, true))} />
            </label>
            {/* tek dosya (çevrimdışı) demoda giriş ekranı yok → çıkış da yok */}
            {STATIC_DEMO && !DEMO_OFFLINE && (
              <button className="row-toggle b psounds-head" onClick={() => leaveDemoPanel()}>
                <span>Çıkış yap</span>
              </button>
            )}
            {lan?.enabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--text2)' }}>
                {lan.qr && <img src={lan.qr} alt="Bağlantı QR kodu" style={{ width: 150, height: 150, borderRadius: 10, border: '1px solid var(--line)', background: '#fff' }} />}
                {lan.urls.map((u) => (
                  <code key={u} style={{ fontSize: 11, wordBreak: 'break-all', userSelect: 'all' }}>
                    {u}
                  </code>
                ))}
                <span style={{ color: 'var(--text3)' }}>Bağlantı gizli bir anahtar içerir; yalnızca kendi cihazlarına ver. Mac uyurken erişim durur.</span>
              </div>
            )}
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
          <Focus waiting={waitingChats} chats={inboxChats} ai={ai} notify={notify} onOpen={openChat} onBack={() => setView('inbox')} onMenu={isMobile ? () => setNavOpen(true) : undefined} />
        ) : (
          <>
            <section className="list" aria-label="Sohbet listesi">
              {(booting || Object.keys(sync).length > 0) && (
                <div className="synctop">
                  <SyncBar progress={booting ? 5 : Math.min(...Object.values(sync).map((s) => s.progress))} since={booting ? bootSince : Math.min(...Object.values(sync).map((s) => s.since))} />
                  <span className="synclbl">{booting ? 'Çekirdek başlatılıyor' : `${Object.keys(sync).length} kanal eşitleniyor`}</span>
                </div>
              )}
              {isMobile && (
                <div className="m-topbar">
                  <button className="btn icon b b2" aria-label="Menü" title="Menü" onClick={() => setNavOpen(true)}>
                    <Icon name="grip" size={16} sw={2} />
                  </button>
                  <span className="m-brand" aria-hidden="true">
                    <Logo size={32} />
                    <span className="word">mivelo</span>
                  </span>
                  <span style={{ flexGrow: 1 }} />
                  <button className={`btn icon b b2 ${listSearch || query ? 'soft' : ''}`} aria-label="Sohbetlerde ara" title="Sohbetlerde ara" onClick={() => (setListSearch(!listSearch), listSearch && setQuery(''))}>
                    <Icon name="search" size={15} sw={2} />
                  </button>
                </div>
              )}
              <div className="list-head">
                <div className="list-top" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="list-title">
                    {platformFilter && view === 'inbox' && <Chip platform={platformFilter} size={26} />}
                    <h1>{FLAG_VIEWS.find((f) => f.view === view)?.label ?? (platformFilter ? PLATFORMS[platformFilter].name : tagFilter ? capitalize(tagFilter) : 'Gelen kutusu')}</h1>
                    {view === 'inbox' && scoped.unread > 0 && <span className="pill">{fmtCount(scoped.unread)} yeni</span>}
                  </div>
                  <span style={{ flexGrow: 1 }} />
                  {view === 'inbox' && accounts.some((a) => a.status === 'connected' && canCompose(a.platform) && (!platformFilter || a.platform === platformFilter)) && (
                    <button className={`btn icon b b2 ${composeOpen ? 'soft' : ''}`} aria-label={PLATFORMS[platformFilter ?? 'demo']?.category === 'mail' ? 'Yeni e-posta' : 'Yeni sohbet'} title={platformFilter && PLATFORMS[platformFilter].category === 'mail' ? 'Yeni e-posta yaz' : 'Yeni sohbet başlat'} onClick={() => setComposeOpen((v) => !v)}>
                      <Icon name="pen" size={15} sw={2} />
                    </button>
                  )}
                  <button className={`btn icon b b2 ${listSearch || query ? 'soft' : ''}`} aria-label="Sohbetlerde ara" title="Sohbetlerde ara" onClick={() => (setListSearch(!listSearch), listSearch && setQuery(''))}>
                    <Icon name="search" size={15} sw={2} />
                  </button>
                </div>

                {listSearch && (
                  <label className="search" style={{ margin: 0 }}>
                    <Icon name="search" size={15} />
                    <input ref={searchRef} autoFocus placeholder="Sohbetlerde ara (ad, son mesaj)" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), setListSearch(false))} />
                    {query && (
                      <button className="btn ghost xs icon b" aria-label="Temizle" onClick={() => setQuery('')}>
                        <Icon name="x" size={13} sw={2} />
                      </button>
                    )}
                  </label>
                )}
                {view === 'inbox' && platformFilter === 'telegram' && (
                  <div className="tabs" role="tablist" aria-label="Telegram klasörleri">
                    <button role="tab" aria-selected={!tgArchive} className={!tgArchive ? 'active' : ''} onClick={() => setTgArchive(false)}>
                      Sohbetler
                    </button>
                    <button role="tab" aria-selected={tgArchive} className={tgArchive ? 'active' : ''} onClick={() => (setTgArchive(true), setFilter('all'))}>
                      Arşiv {archivedCount > 0 && <span className="c">{archivedCount}</span>}
                    </button>
                  </div>
                )}
                {view === 'inbox' && (
                  <div className="tabs" role="tablist" aria-label={platformFilter === 'imessage' ? 'Mesajlar klasörleri' : 'Filtreler'}>
                    {/* iMessage: Okunmamış yerine Mesajlar uygulamasındaki klasörler */}
                    {(platformFilter === 'imessage' ? (['all'] as Filter[]) : (['all', 'unread'] as Filter[])).map((f) => (
                      <button key={f} role="tab" aria-selected={filter === f && !imFolder && !mailFolder} className={filter === f && !imFolder && !mailFolder ? 'active' : ''} onClick={() => (setFilter(f), setImFolder(null), setMailFolder(null))}>
                        {f === 'all' ? (platformFilter === 'imessage' ? 'Mesajlar' : 'Tümü') : 'Okunmamış '}
                        {f === 'unread' && scoped.unread > 0 && <span className="c">{fmtCount(scoped.unread)}</span>}
                      </button>
                    ))}
                    {(follow.n > 0 || filter === 'followup') && !imFolder && !mailFolder && (
                      <button role="tab" aria-selected={filter === 'followup'} className={`fol ${filter === 'followup' ? 'active' : ''} ${follow.due ? 'due' : ''}`} title="Yanıt gelmezse hatırlatılacak sohbetler" onClick={() => (setFilter('followup'), setImFolder(null), setMailFolder(null), setTgArchive(false))}>
                        Takip {follow.n > 0 && <span className="c">{follow.due ? `${follow.due}/${follow.n}` : follow.n}</span>}
                      </button>
                    )}
                    {platformFilter && PLATFORMS[platformFilter].category === 'mail' &&
                      ([['sent', 'Gönderilenler'], ['junk', 'Gereksiz']] as Array<['sent' | 'junk', string]>).map(([fo, label]) => (
                        <button key={fo} role="tab" aria-selected={mailFolder === fo} className={mailFolder === fo ? 'active' : ''} onClick={() => (setMailFolder(fo), setFilter('all'))}>
                          {label}
                        </button>
                      ))}
                    {platformFilter === 'imessage' &&
                      ([['unknown', 'Bilinmeyen', 'Bilinmeyen gönderenler'], ['junk', 'İstenmeyen', 'İstenmeyen'], ['deleted', 'Silinenler', 'Son silinenler']] as Array<[typeof imFolder, string, string]>).map(([fo, label, title]) => (
                        <button key={String(fo)} role="tab" title={title} aria-selected={imFolder === fo} className={imFolder === fo ? 'active' : ''} onClick={() => (setImFolder(fo), setFilter('all'))}>
                          {label}
                        </button>
                      ))}
                  </div>
                )}
              </div>

              {composeOpen && (
                <ComposePane
                  accounts={accounts.filter((a) => a.status === 'connected' && canCompose(a.platform))}
                  preferred={platformFilter}
                  chats={allChats}
                  onClose={() => setComposeOpen(false)}
                  onOpen={(id) => {
                    setComposeOpen(false);
                    openChat(id);
                  }}
                  notify={notify}
                />
              )}
              {!composeOpen && view === 'inbox' && !platformFilter && !tagFilter && !query && pinnedChats.length > 0 && (
                <div className="quick" aria-label="Sabitlenenler">
                  {pinnedChats.slice(0, 8).map((c, i, arr) => (
                    <button key={c.id} className={`qc b ${c.id === selected ? 'on' : ''}`} onClick={() => setSelected(c.id)} title={c.lastPreview}>
                      {c.unread > 0 && arr.findIndex((x) => x.unread > 0) === i && <span className="qc-bub">{c.lastPreview.replace(/^Sen: /, '')}</span>}
                      <span className="avwrap">
                        <Avatar name={c.name} size={46} url={c.avatarUrl} />
                        <Chip platform={c.platform} size={17} ring="#f7f6fa" />
                      </span>
                      <span className="qc-nm">{c.name}</span>
                    </button>
                  ))}
                </div>
              )}
              {/* anahtar: uygulama/sekme/etiket değişince liste yeniden kurulur ve satırlar kademeli belirir */}
              <div className="rows" key={`${view}|${platformFilter ?? ''}|${filter}|${tagFilter ?? ''}`} onScroll={onRowsScroll} style={composeOpen ? { display: 'none' } : undefined}>
                {FLAG_VIEWS.some((f) => f.view === view) ? (
                  (() => {
                    const f = FLAG_VIEWS.find((x) => x.view === view)!;
                    const list = flagged[f.flag];
                    return list.length === 0 ? (
                      <div className="empty">{f.empty}</div>
                    ) : (
                      list.map((c) => <ChatRow key={c.id} chat={c} selected={c.id === selected} onClick={() => setSelected(c.id)} />)
                    );
                  })()
                ) : chatList.length === 0 ? (
                  <div className="empty">
                    {chats.size === 0 ? (
                      <>
                        Henüz sohbet yok.
                        <br />
                        Bir uygulama bağlayınca mesajlar burada görünür.
                      </>
                    ) : (
                      emptyText
                    )}
                  </div>
                ) : (
                  groupByDay(chatList).map(([day, items]) => (
                    <div key={day} style={{ display: 'contents' }}>
                      <div className="group-label">
                        <span className="label">{day}</span>
                      </div>
                      {items.map((c) => (
                        <ChatRow key={c.id} chat={c} selected={c.id === selected} onClick={() => setSelected(c.id)} typing={typing[c.id] ? typing[c.id].name ?? '' : null} />
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
                {moreBusy && <div className="empty" style={{ padding: 10, fontSize: 12 }}>Daha eski sohbetler yükleniyor…</div>}
              </div>
              <div className="hints">
                <span>
                  <span className="kbd">J</span>
                  <span className="kbd">K</span> gezin
                </span>
                <span>
                  <span className="kbd">{MOD}1</span> görünüm
                </span>
                <span>
                  <span className="kbd">{MOD}K</span> ara
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
                onTags={(tags) => api.setTags(current.id, tags).then((c) => setChats((p) => new Map(p).set(c.id, c))).catch((e) => notify(e.message, true))}
                onFlags={(f) => setFlags(current.id, f)}
                seed={seed?.id === current.id ? seed : null}
                onSeedUsed={() => setSeed(null)}
                showDetails={isMobile ? mobileDetails : showDetails}
                onToggleDetails={() => (isMobile ? setMobileDetails((v) => !v) : setShowDetails(!showDetails))}
                onBack={isMobile ? () => setSelected(null) : undefined}
                typing={typing[current.id] ? typing[current.id].name ?? '' : null}
                olderBusy={olderBusy}
                hasOlder={noMoreOlder !== current.id}
                onLoadOlder={async () => {
                  const oldest = currentMessages[0];
                  if (olderBusy) return;
                  setOlderBusy(true);
                  try {
                    if (!oldest) {
                      // hiç mesaj yok: platformdan geçmişi iste ve depodan yeniden oku
                      await api.loadHistory(current.id, undefined, 100);
                      const m = await api.messages(current.id);
                      if (selectedRef.current !== current.id) return; // bu arada başka sohbete geçildi: eski sohbetin mesajları yeni seçime yazılmasın
                      if (m.length === 0) {
                        setNoMoreOlder(current.id);
                        notify('Platform bu sohbet için mesaj vermedi');
                      }
                      setMessages(m);
                      return;
                    }
                    // önce depodaki daha eski mesajlar; depoda yoksa platformdan iste (WhatsApp/Telegram/Instagram/…)
                    let more = await api.messages(current.id, 300, oldest.ts);
                    if (more.length === 0) {
                      await api.loadHistory(current.id, oldest.ts, 100);
                      more = await api.messages(current.id, 300, oldest.ts);
                    }
                    if (selectedRef.current !== current.id) return; // sohbet değişti: eski mesajlar yeni sohbete karışmasın
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
                    {accounts.length === 0 ? 'Başlamak için bir uygulama bağla.' : 'Soldan bir sohbet seç.'}
                  </p>
                  {accounts.length === 0 && (
                    <button className="btn primary b" onClick={() => setConnectOpen(true)}>
                      <Icon name="plus" size={15} sw={2} /> Uygulama bağla
                    </button>
                  )}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {appSettingsP.value && (
        <div className={`overlay app-settings ${appSettingsP.closing ? 'closing' : ''}`} onClick={() => setAppSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Uygulama ayarları">
            <div className="modal-scroll">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h2 style={{ fontSize: 26 }}>Uygulama ayarları</h2>
              <span style={{ flexGrow: 1 }} />
              <button className="btn icon b b2" onClick={() => setAppSettingsOpen(false)} aria-label="Kapat">
                <Icon name="x" size={15} sw={2} />
              </button>
            </div>
            {accounts.length === 0 ? (
              <p style={{ margin: 0, color: 'var(--text2)', fontSize: 14 }}>Bağlı uygulama yok.</p>
            ) : (
              <div className="app-set-list">
                {accounts.map((a) => {
                  const stored = pSounds[a.platform] ?? getPlatformSound(a.platform);
                  const notifyOn = stored !== 'off';
                  const tone = getPlatformTone(a.platform);
                  const handle = handleOf(a);
                  return (
                    <div key={a.id} className="app-set-card">
                      <div className="who">
                        <Chip platform={a.platform} size={36} />
                        <span>
                          <b>{PLATFORMS[a.platform].name}</b>
                          {handle && <span className="sub">{handle}</span>}
                        </span>
                      </div>
                      <div className="pref-block">
                        <span className="k">Zil sesi</span>
                        <div className="tones" role="radiogroup" aria-label={`${PLATFORMS[a.platform].name} zil sesi`}>
                          {SOUNDS.map((sn) => (
                            <button key={sn.id} type="button" className={tone === sn.id ? 'on' : ''} aria-checked={tone === sn.id} role="radio" onClick={() => changePlatformTone(a.platform, sn.id)}>
                              {sn.name}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="pref-block">
                        <span className="k">Bildirim tercihi</span>
                        <div className="tones" role="radiogroup" aria-label={`${PLATFORMS[a.platform].name} bildirim`}>
                          <button type="button" className={notifyOn ? 'on' : ''} aria-checked={notifyOn} role="radio" onClick={() => changePlatformNotify(a.platform, true)}>
                            Açık
                          </button>
                          <button type="button" className={!notifyOn ? 'on' : ''} aria-checked={!notifyOn} role="radio" onClick={() => changePlatformNotify(a.platform, false)}>
                            Kapalı
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            </div>
          </div>
        </div>
      )}
      {connectP.value && (
        <ConnectModal
          closing={connectP.closing}
          sync={sync}
          accounts={accounts} qr={qr} prompts={prompts} connected={connectedPlatforms} onClose={() => setConnectOpen(false)} notify={notify} onChanged={refresh} />
      )}
      {menuP.value && ((menu: NonNullable<typeof menuP.value>) => (
        <div className={`menu-backdrop ${menuP.closing ? 'closing' : ''}`} onClick={() => setMenu(null)} onContextMenu={(e) => (e.preventDefault(), setMenu(null))}>
          <div className={`menu ${menuP.closing ? 'closing' : ''}`} style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 170) }} onClick={(e) => e.stopPropagation()}>
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
                          if (platformFilter === acc.platform) selectPlatform(null);
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
      ))(menuP.value)}
      {toast && (
        <div className={`toast ${toast.err ? 'err' : ''}`} role="status" aria-live="polite">
          {toast.text}
        </div>
      )}
      {ghost && dragId && (() => {
        const acc = accounts.find((x) => x.id === dragId);
        return acc ? (
          <div className="chan chan-ghost" style={{ top: ghost.top, left: ghost.left, width: ghost.width }} aria-hidden>
            <Chip platform={acc.platform} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{PLATFORMS[acc.platform].name}</span>
          </div>
        ) : null;
      })()}
      {inToasts.length > 0 && (
        <div className="msgtoasts" aria-live="polite">
          {inToasts.map((t) => (
            <button
              key={t.id}
              className="msgtoast b"
              onClick={() => {
                setInToasts((prev) => prev.filter((x) => x.id !== t.id));
                setView('inbox');
                setSelected(t.chat.id);
              }}
            >
              <span className="avwrap">
                <Avatar name={t.chat.name} size={34} url={t.chat.avatarUrl} />
                <Chip platform={t.chat.platform} size={16} ring="#fff" />
              </span>
              <span className="body">
                <span className="top">
                  <b>{t.chat.name}</b>
                  <span className="plat">{PLATFORMS[t.chat.platform].name}</span>
                </span>
                <span className="txt">{t.text}</span>
              </span>
              <span
                className="x"
                role="button"
                aria-label="Kapat"
                onClick={(e) => {
                  e.stopPropagation();
                  setInToasts((prev) => prev.filter((x) => x.id !== t.id));
                }}
              >
                <Icon name="x" size={12} sw={2} />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Tanıtıcı (numara / @kullanıcı) yazarak yeni sohbet açılabilen platformlar; e-posta hesaplarında yeni e-posta */
const NEW_CHAT_PLATFORMS = new Set<Platform>(['whatsapp', 'telegram', 'demo']);
function canCompose(p: Platform): boolean {
  return NEW_CHAT_PLATFORMS.has(p) || PLATFORMS[p].category === 'mail';
}

/**
 * Yeni sohbet / yeni e-posta bölmesi (sağ bölmede). Hesap seçilmez: uygulama filtresi açıksa o hesap; değilse yazılan
 * tanıtıcıdan çıkarılır (e-posta adresi → ilk e-posta hesabı, +numara → WhatsApp (yoksa Telegram), @kullanıcı → Telegram).
 */
function ComposePane({ accounts, preferred, chats, onClose, onOpen, notify }: { accounts: Account[]; preferred: Platform | null; chats: Chat[]; onClose: () => void; onOpen: (chatId: string) => void; notify: (t: string, err?: boolean) => void }) {
  const [q, setQ] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const ident = q.trim();
  const isPhone = /^\+?\d[\d\s-]{6,}$/.test(ident);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ident);
  const isUser = /^@[a-z0-9_.]{3,}$/i.test(ident);
  const byPlatform = (p: Platform) => accounts.find((a) => a.platform === p);
  const account: Account | undefined = preferred
    ? byPlatform(preferred)
    : isEmail
      ? accounts.find((a) => PLATFORMS[a.platform].category === 'mail')
      : isPhone
        ? byPlatform('whatsapp') ?? byPlatform('telegram') ?? byPlatform('demo')
        : isUser
          ? byPlatform('telegram') ?? byPlatform('demo')
          : undefined;
  const isMail = !!account && PLATFORMS[account.platform].category === 'mail';
  const s = ident.toLocaleLowerCase('tr-TR');
  const matches = s && !isMail ? chats.filter((c) => (!preferred || c.platform === preferred) && (c.name.toLocaleLowerCase('tr-TR').includes(s) || (c.handle ?? '').toLocaleLowerCase('tr-TR').includes(s))).slice(0, 6) : [];
  const canStart = !!account && (isMail ? isEmail && body.trim().length > 0 : account.platform === 'whatsapp' ? isPhone : account.platform === 'telegram' ? isPhone || isUser : ident.length > 1);
  async function start() {
    if (!account || !canStart || busy) return;
    setBusy(true);
    try {
      if (isMail) {
        const c = await api.compose(account.id, { to: ident, subject: subject.trim(), text: body.trim() });
        notify('E-posta gönderildi');
        onOpen(c.id);
      } else {
        const id = account.platform === 'whatsapp' ? `${ident.replace(/\D/g, '')}@s.whatsapp.net` : ident;
        const c = await api.openChat(account.id, { id, name: ident, handle: ident });
        onOpen(c.id);
      }
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  const title = isMail ? 'Yeni e-posta' : 'Yeni sohbet';
  const hint = preferred
    ? account
      ? isMail
        ? '⌘Enter ile gönder. Gönderilen e-posta bu hesapta yeni bir dizi olarak açılır.'
        : `Sohbet ${PLATFORMS[account.platform].name}’da açılır, ilk mesajı sen yazarsın.${account.platform === 'telegram' ? ' Rehberinde olmayan numaralar bulunamayabilir.' : ''}`
      : 'Bu uygulamada yeni sohbet başlatılamıyor.'
    : 'E-posta adresi yazarsan e-posta, +90 numara yazarsan WhatsApp, @kullanıcı yazarsan Telegram sohbeti açılır.';
  return (
    <section className="compose-box" aria-label={title}>
      <div className="cb-head">
        <span className="cb-title">{title}</span>
        {account ? (
          <span className="cb-acc">
            <Chip platform={account.platform} size={14} />
            {PLATFORMS[account.platform].name}
            {account.label && account.label !== PLATFORMS[account.platform].name ? ` · ${account.label}` : ''}
          </span>
        ) : (
          <span className="cb-acc">tanıtıcıya göre seçilir</span>
        )}
        <button className="btn ghost xs icon b" onClick={onClose} aria-label="Kapat" title="Kapat">
          <Icon name="x" size={13} sw={2} />
        </button>
      </div>
      <div className="body">
        {isMail ? (
          <div className="mailform">
            <label>
              <span>Kime</span>
              <input autoFocus type="email" placeholder="ad@örnek.com" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onClose()} />
            </label>
            <label>
              <span>Konu</span>
              <input placeholder="Konu" value={subject} onChange={(e) => setSubject(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onClose()} />
            </label>
            <textarea placeholder="E-postanı yaz…" value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => (e.key === 'Escape' ? onClose() : e.key === 'Enter' && (e.metaKey || e.ctrlKey) ? void start() : undefined)} />
          </div>
        ) : (
          <>
            <label className="search" style={{ margin: 0 }}>
              <Icon name="search" size={15} />
              <input
                autoFocus
                placeholder={preferred === 'whatsapp' ? 'Ad ya da +90 numara' : preferred === 'telegram' ? 'Ad, +90 numara ya da @kullanıcı' : 'Ad, e-posta, +90 numara ya da @kullanıcı'}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') onClose();
                  if (e.key === 'Enter') (matches[0] && !canStart ? onOpen(matches[0].id) : void start());
                }}
              />
            </label>
            {matches.length > 0 && (
              <div className="nc-list">
                <span className="label">Mevcut sohbetler</span>
                {matches.map((c) => (
                  <button key={c.id} className="nc-row b" onClick={() => onOpen(c.id)}>
                    <span className="avwrap">
                      <Avatar name={c.name} size={32} url={c.avatarUrl} />
                      <Chip platform={c.platform} size={14} ring="#fff" />
                    </span>
                    <span className="nm">
                      {c.name}
                      {c.handle && c.handle !== c.name && <span className="hd">{c.handle}</span>}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <button className="btn primary b nc-start" disabled={!canStart || busy} onClick={() => void start()}>
          {busy ? <span className="spin" /> : <Icon name={isMail ? 'send' : 'pen'} size={14} sw={2} />}
          {isMail ? (canStart ? `Gönder (${ident})` : isEmail ? 'Metni yaz' : 'Alıcı adresini yaz') : canStart && account ? `${PLATFORMS[account.platform].name}’da ${ident} ile sohbet başlat` : preferred === 'whatsapp' ? '+90… numara yaz' : 'Ad, numara, @kullanıcı ya da e-posta yaz'}
        </button>
        <span className="nc-hint">{hint}</span>
      </div>
    </section>
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

/**
 * Toplam sayaçlara (gelen kutusu, "N yeni", kanal satırı, Dock rozeti) bir sohbetin katkısı: sohbetin kendi rozeti gerçek
 * sayıyı gösterir, ama kanallar sayılmaz ve gruplar (Telegram'da yüz binlerce okunmamışlı süper gruplar) en çok 99 sayılır;
 * yoksa tek bir topluluk grubu tüm sayaçları anlamsızlaştırır.
 */
function countable(c: Chat): number {
  if (c.kind === 'channel' || c.unread <= 0) return 0;
  return c.kind === 'group' ? Math.min(c.unread, 99) : c.unread;
}
function fmtCount(n: number): string {
  return n > 999 ? '999+' : n > 0 ? String(n) : '';
}
/** Sohbet rozeti: gerçek sayı; kanallarda 99+, binler "305K" gibi (Telegram'ın gösterimi) */
function fmtBadge(c: Chat): string {
  if (c.kind === 'channel' && c.unread > 99) return '99+';
  return c.unread > 999 ? `${Math.floor(c.unread / 1000)}K` : String(c.unread);
}

/** Son mesaj karşı taraftan geldiyse ve 20 dakikadır cevaplanmadıysa "yanıt bekliyor". */
/** Kısayol öneki: Mac'te "⌘1", diğerlerinde "Ctrl+1" */
const MOD = MOD_KEY === '⌘' ? '⌘' : `${MOD_KEY}+`;

export function isWaiting(c: Chat): boolean {
  // son olay yalnızca bir tepkiyse ("😂 Mert bir mesajı beğendi") yanıt beklemiyor
  return c.unread > 0 && Date.now() - c.lastMessageAt > 20 * 60_000 && !REACT_TEXT.test(c.lastPreview ?? '');
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
      {count > 0 && <span className="count">{fmtCount(count)}</span>}
    </button>
  );
}

function ChatRow({
  chat,
  selected,
  onClick,
  typing,
}: {
  chat: Chat;
  selected: boolean;
  onClick: () => void;
  /** yazıyor: null = hayır, "" = evet, "Ad" = grupta kim */
  typing?: string | null;
}) {
  const waiting = chat.platform !== 'imessage' && isWaiting(chat); // Mesajlar'da "bekleyen" kavramı yok
  const isMail = PLATFORMS[chat.platform].category === 'mail';
  // E-posta: üstte gönderen, ortada konu, altta özet (posta istemcisi düzeni)
  const mailSender = isMail ? (chat.participants?.[0]?.name || chat.handle || '').replace(/<.*>/, '').trim() : '';
  const mailPreview = isMail && mailSender && chat.lastPreview?.startsWith(mailSender + ':') ? chat.lastPreview.slice(mailSender.length + 1).trim() : chat.lastPreview;
  return (
    <div className={`row ${selected ? 'selected' : ''} ${chat.unread > 0 ? 'unread' : ''} ${isMail ? 'mailrow' : ''}`} onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <span className="avwrap">
        <Avatar name={isMail && mailSender ? mailSender : chat.name} size={44} url={chat.avatarUrl} />
        <Chip platform={chat.platform} size={17} ring={selected ? '#fff' : '#f7f6fa'} />
      </span>
      <span className="body">
        <span className="top">
          {chat.pinned && <Icon name="pin" size={12} color="#8c889b" />}
          <span className="name">{isMail && mailSender ? mailSender : chat.name}</span>
          {chat.tags.slice(0, 2).map((t) => (
            <Tag key={t} name={t} mini />
          ))}
          <span className="time">{fmtTime(chat.lastMessageAt)}</span>
        </span>
        {isMail && mailSender && <span className="subj">{chat.name}</span>}
        <span className="top">
          {typing != null ? (
            <span className="prev typing-text">
              {typing ? `${typing.split(' ')[0]} yazıyor` : 'yazıyor'}
              <span className="tdots"><i /><i /><i /></span>
            </span>
          ) : (
            <span className="prev">{(isMail ? mailPreview : chat.lastPreview) || '…'}</span>
          )}
          {chat.unread > 0 && <span className="badge" aria-label={`${chat.unread} okunmamış`}>{fmtBadge(chat)}</span>}
        </span>
      </span>
    </div>
  );
}

/** Ayarlar → AI anahtarı: kullanıcının kendi Anthropic anahtarı; çekirdekte Anahtar Zinciri/DPAPI'de saklanır, geri okunmaz */
function AiKeyRow({ ai, onChange, notify }: { ai: boolean; onChange: (on: boolean) => void; notify: (t: string, err?: boolean) => void }) {
  const [info, setInfo] = useState<{ set: boolean; source: 'settings' | 'env' | null; hint: string | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.aiKey().then(setInfo).catch(() => setInfo(null));
  }, [ai]);
  const save = (key: string | null) => {
    setBusy(true);
    api
      .setAiKey(key)
      .then((r) => {
        onChange(r.ai);
        setEditing(false);
        setVal('');
        notify(key ? 'AI anahtarı kaydedildi' : 'AI anahtarı kaldırıldı');
        return api.aiKey().then(setInfo);
      })
      .catch((e) => notify((e as Error).message, true))
      .finally(() => setBusy(false));
  };
  if (editing)
    return (
      <form className="ai-key-form" onSubmit={(e) => (e.preventDefault(), val.trim() && save(val.trim()))}>
        <input autoFocus type="password" placeholder="sk-ant-…" value={val} onChange={(e) => setVal(e.target.value)} aria-label="Anthropic API anahtarı" autoComplete="off" spellCheck={false} />
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="submit" className="btn primary xs b b2" disabled={busy || !val.trim()}>
            Kaydet
          </button>
          <button type="button" className="btn ghost xs b b2" onClick={() => (setEditing(false), setVal(''))}>
            Vazgeç
          </button>
        </div>
        <span className="ai-key-note">Anahtar bu bilgisayarda güvenli depoda saklanır. AI kullandığında ilgili sohbetin son mesajları Anthropic'e gönderilir.</span>
      </form>
    );
  return (
    <div className="row-toggle ai-key-row">
      <span>
        Anthropic anahtarı
        <em>{info?.set ? (info.source === 'env' ? 'ortam değişkeninden' : info.hint) : 'eklenmedi'}</em>
      </span>
      {info?.source === 'settings' ? (
        <button type="button" className="btn ghost xs b b2" onClick={() => save(null)} disabled={busy}>
          Kaldır
        </button>
      ) : (
        <button type="button" className="btn soft xs b b2" onClick={() => setEditing(true)}>
          {info?.set ? 'Değiştir' : 'Ekle'}
        </button>
      )}
    </div>
  );
}
