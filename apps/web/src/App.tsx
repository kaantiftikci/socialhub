import { FeedbackButton } from './Feedback';
import { LoginView, pushLoginEvent } from './LoginView';
import { UpdateBanner } from './UpdateBanner';
import { clearOpening as clearOpeningFor, markOpening, useLoginOpening } from './login-opening';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, connectEvents } from './api';
import { PLATFORMS, ORDER_Q_PLATFORMS, isOrderPage, questionOrderRef, shopKind, shopPending, shopTabOf, type Account, type Chat, type ChatFlags, type CoreEvent, type Message, type Platform, type ShopTab, DEFAULT_TAGS } from './types';
import { Avatar, Chip, Icon, IconText, stripLeadIcon, Logo, Resizer, SyncBar, Tag, ago, fmtTime, loadPaneSizes, useClosing } from './ui';
import { Conversation, REACT_TEXT, refreshScheduled, startScheduledSends } from './Conversation';
import { ConnectModal } from './Connect';
import { Focus } from './Focus';
import { onThemeChange, resolvedTheme, setThemePref } from './theme';
import { SettingsModal } from './Settings';
import { SearchPalette } from './SearchPalette';
import { CalendarView, ymd } from './CalendarView';
import { MOD_KEY, isTauri, notify as desktopNotify, requestWebNotify, onDesktopEvent, playPing, setBadge, windowFocused, coreInfo, playNotifySound, platformNotifyOn, soundsEnabled, bannersEnabled, groupsNotify, unlockAudio } from './desktop';
import { PROFILE_NAME, STATIC_DEMO } from './profile';

export type View = 'inbox' | 'focus' | 'calendar' | 'archived' | 'muted' | 'hidden';
const FLAG_VIEWS: Array<{ view: View; flag: 'archived' | 'muted' | 'hidden'; label: string; icon: string; empty: string }> = [
  { view: 'archived', flag: 'archived', label: 'Arşiv', icon: 'archive', empty: 'Arşivlenmiş sohbet yok. Sağ paneldeki Eylemler’den arşivleyebilirsin.' },
  { view: 'muted', flag: 'muted', label: 'Sessiz', icon: 'mute', empty: 'Sessize alınmış sohbet yok.' },
  { view: 'hidden', flag: 'hidden', label: 'Gizli', icon: 'eyeoff', empty: 'Gizlenmiş sohbet yok.' },
];
export type Filter = 'all' | 'unread' | 'waiting' | 'followup';

/** Gezinme durumu (sayfa yenilenince aynı görünüm/sohbet açılsın). sessionStorage: sekmeye özel, sekme kapanınca silinir. */
type NavState = {
  view?: View;
  filter?: Filter;
  platformFilter?: Platform | null;
  tagFilter?: string | null;
  imFolder?: 'unknown' | 'junk' | 'sms' | 'deleted' | null;
  mailFolder?: 'sent' | 'junk' | null;
  tgArchive?: boolean;
  shopTab?: ShopTab | null;
  selected?: string | null;
};
const NAV_KEY = 'mivelo.nav';
const NAV0: NavState = (() => {
  try {
    const v = JSON.parse(sessionStorage.getItem(NAV_KEY) ?? 'null');
    return v && typeof v === 'object' ? (v as NavState) : {};
  } catch {
    return {};
  }
})();
function saveNav(n: NavState): void {
  try {
    sessionStorage.setItem(NAV_KEY, JSON.stringify(n));
  } catch {
    /* gizli mod vb. */
  }
}


export default function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const openingTexts = useLoginOpening(accounts);
  const [chats, setChats] = useState<Map<string, Chat>>(new Map());
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const [selected, setSelected] = useState<string | null>(NAV0.selected ?? null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [view, setView] = useState<View>(NAV0.view ?? 'inbox');
  const [filter, setFilter] = useState<Filter>(NAV0.filter ?? 'all');
  const [platformFilter, setPlatformFilter] = useState<Platform | null>(NAV0.platformFilter && PLATFORMS[NAV0.platformFilter] ? NAV0.platformFilter : null);
  const [tagFilter, setTagFilter] = useState<string | null>(NAV0.tagFilter ?? null);
  const smartSort = false; // akıllı sıralama kaldırıldı: her zaman son mesaja göre
  const [listSearch, setListSearch] = useState(false);
  /** iMessage klasörü: Mesajlar uygulamasındaki Bilinmeyen / İstenmeyen / SMS filtresi / Son silinenler */
  const [imFolder, setImFolder] = useState<'unknown' | 'junk' | 'sms' | 'deleted' | null>(NAV0.imFolder ?? null);
  /** E-posta hesaplarında Gönderilenler / Gereksiz sekmesi */
  const [mailFolder, setMailFolder] = useState<'sent' | 'junk' | null>(NAV0.mailFolder ?? null);
  /** Telegram: üstteki "Arşiv" sekmesi (chat.meta.archived) */
  const [tgArchive, setTgArchive] = useState(!!NAV0.tgArchive);
  /** Pazaryeri kanalları: Tümü · Siparişler · Sorular sekmesi */
  const [shopTab, setShopTab] = useState<ShopTab | null>(NAV0.shopTab ?? null);
  // yenilemede aynı yerde kalınsın: görünüm/kanal/sekme/açık sohbet bu tarayıcı sekmesine yazılır
  useEffect(() => {
    saveNav({ view, filter, platformFilter, tagFilter, imFolder, mailFolder, tgArchive, shopTab, selected });
  }, [view, filter, platformFilter, tagFilter, imFolder, mailFolder, tgArchive, shopTab, selected]);
  /** Platform seçimi değişince platforma özel sekmeler (iMessage klasörü, Telegram arşivi) sıfırlanır */
  const selectPlatform = useCallback((p: Platform | null) => {
    setMailFolder(null);
    setPlatformFilter(p);
    setImFolder(null);
    setTgArchive(false);
    setShopTab(null);
    // pazaryerinde "Okunmamış" sekmesi yok (Tümü · Siparişler · Sorular): başka kanaldan kalan filtre Tümü'ye döner
    if (p && PLATFORMS[p].category === 'shop') setFilter((f) => (f === 'unread' ? 'all' : f));
  }, []);
  const [olderBusy, setOlderBusy] = useState(false);
  const [noMoreOlder, setNoMoreOlder] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsP = useClosing(settingsOpen || null);
  const [lan, setLanState] = useState<{ enabled: boolean; urls: string[]; qr?: string } | null>(null);
  useEffect(() => {
    if (settingsOpen) api.lan().then(setLanState).catch(() => setLanState(null));
  }, [settingsOpen]);
  // Etkinlik sinyali: pencere açık ve odaktayken çekirdek bazı kanalları (Instagram) sık, boştayken seyrek yoklar.
  // Odak/görünürlük değişince hemen, odaktayken dakikada bir bildirilir; değişmeyen "boşta" durumu yinelenmez.
  useEffect(() => {
    let last: boolean | null = null;
    let lastSent = 0;
    const report = () =>
      void windowFocused()
        .catch(() => true)
        .then((f) => {
          const active = f && document.visibilityState === 'visible';
          if (active === last && (!active || Date.now() - lastSent < 55_000)) return;
          last = active;
          lastSent = Date.now();
          void api.activity(active);
        });
    report();
    const t = setInterval(report, 60_000);
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
    document.addEventListener('visibilitychange', report);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', report);
      window.removeEventListener('blur', report);
      document.removeEventListener('visibilitychange', report);
    };
  }, []);
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
  // gece/gündüz düğmesi: görünen tema (sistem teması değişince de güncellenir)
  const [theme, setThemeState] = useState<'light' | 'dark'>(() => resolvedTheme());
  useEffect(() => onThemeChange(setThemeState), []);
  useEffect(() => unlockAudio(), []);
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
  /** Bağlan penceresinde açık gelecek hesap (uyarıdaki "QR'ı göster") */
  const [connectFocus, setConnectFocus] = useState<string | null>(null);
  // Kanal uyarı kartı (yanıp sönen kırmızı işaretin üzerine gelince / dokununca): hangi hesap, işaretin konumu
  const [alertPop, setAlertPop] = useState<{ id: string; x: number; y: number } | null>(null);
  const alertTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const openAlert = (id: string, el: HTMLElement) => {
    clearTimeout(alertTimer.current);
    const r = el.getBoundingClientRect();
    setAlertPop({ id, x: r.right, y: r.top + r.height / 2 });
  };
  const closeAlertSoon = () => {
    clearTimeout(alertTimer.current);
    alertTimer.current = setTimeout(() => setAlertPop(null), 250);
  };
  useEffect(() => {
    if (!alertPop) return;
    const close = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('.alert-pop, .alert-ic')) return;
      setAlertPop(null);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setAlertPop(null);
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', esc);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('resize', close);
    };
  }, [alertPop]);
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
  /** Ekranda gerçekten açık sohbet: Takvim/Odak görünümünde seçim korunur ama sohbet görünmez (okundu/bildirim için) */
  const visibleChatRef = useRef<string | null>(null);
  visibleChatRef.current = view === 'inbox' ? selected : null;
  /** sohbet → son yeniden 'okundu' işaretleme zamanı */
  const reReadAt = useRef(new Map<string, number>());
  const searchRef = useRef<HTMLInputElement>(null);

  const toastTimer = useRef<number | undefined>(undefined);
  const notify = useCallback((text: string, err = false) => {
    setToast({ text, err });
    // önceki bildirimin zamanlayıcısı yenisini erken kapatmasın
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
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
    // "ResizeObserver loop …" tarayıcının zararsız uyarısı (gözlemci aynı karede yeniden tetiklendi); hata sayılmaz
    const onErr = (e: ErrorEvent) => {
      if (/ResizeObserver loop/i.test(e.message ?? '')) return;
      notify(`Arayüz hatası: ${e.message}`, true);
    };
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
      if (pushLoginEvent(ev)) return; // Mivelo içi giriş ekranı kareleri App durumundan geçmez
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
          if (ev.chat.id === visibleChatRef.current && ev.chat.unread > 0 && Date.now() - (reReadAt.current.get(ev.chat.id) ?? 0) > 60_000) {
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
        case 'messages.read': {
          if (ev.chatId === selectedRef.current) setMessages((prev) => prev.map((m) => (m.fromMe && m.ts <= ev.before && m.status !== 'read' ? { ...m, status: 'read' } : m)));
          // listedeki son mesaj tiki (çekirdek de chat.upsert gönderir; eski olay sırası için yerelde de işlenir)
          const c = chatsRef.current.get(ev.chatId);
          if (c?.lastFromMe && c.lastMessageAt <= ev.before && c.lastStatus !== 'read') queueChat({ ...c, lastStatus: 'read' });
          break;
        }
        case 'messages.refetch':
          // geçmiş eşitlemesinde çok sayıda mesaj yazıldı (tek tek gönderilmedi): açık sohbetse depodan yeniden oku
          if (selectedRef.current && ev.chatIds.includes(selectedRef.current)) {
            const sel = selectedRef.current;
            void api
              .messages(sel)
              .then((m) => {
                if (selectedRef.current !== sel) return;
                setMessages((prev) => {
                  const ids = new Set(m.map((x) => x.id));
                  return [...prev.filter((x) => x.chatId === sel && !ids.has(x.id)), ...m].sort((x, y) => x.ts - y.ts);
                });
              })
              .catch(() => undefined);
          }
          break;
        case 'account.removed':
          setAccounts((prev) => prev.filter((a) => a.id !== ev.accountId));
          setChats((prev) => {
            if (![...prev.values()].some((c) => c.accountId === ev.accountId)) return prev;
            return new Map([...prev].filter(([, c]) => c.accountId !== ev.accountId));
          });
          setQr((q) => {
            if (!(ev.accountId in q)) return q;
            const next = { ...q };
            delete next[ev.accountId];
            return next;
          });
          break;
        case 'events.update':
          setCalTick((x) => x + 1);
          break;
        case 'event.reminder': {
          const e = ev.event;
          const when = e.start.includes('T') ? e.start.slice(11, 16) : 'bugün';
          const chatName = e.chatId ? chatsRef.current.get(e.chatId)?.name : undefined;
          const body = `${when}${e.location ? ' · ' + e.location : ''}${chatName ? ' · ' + chatName : ''}`;
          void windowFocused().then((focused) => {
            if (focused) notify(`Takvim: ${e.title} — ${body}`);
            else if (bannersEnabled()) desktopNotify(`Takvim: ${e.title}`, body);
            if (soundsEnabled()) playPing(undefined, true);
          });
          break;
        }
        case 'scheduled.update':
          refreshScheduled();
          break;
        case 'scheduled.missed':
          notify(`Zamanlanmış mesaj gönderilmedi (${ev.chatName || 'sohbet'}): ${ev.item.missed?.reason ?? ''} — “${ev.item.text.slice(0, 60)}”`, true);
          break;
        case 'chat.followup': {
          // takip hatırlatıcısı: süre doldu, yanıt gelmedi
          queueChat(ev.chat);
          const body = 'Yanıt gelmedi. Takip etmek ister misin?';
          void windowFocused().then((focused) => {
            if (!platformNotifyOn(ev.chat.platform)) return;
            if (focused) pushInToast(ev.chat, `⏰ ${body}`);
            else if (bannersEnabled()) desktopNotify(`Takip: ${ev.chat.name}`, body);
            playNotifySound(ev.chat.platform);
          });
          break;
        }
        case 'message.delete':
          if (ev.chatId === selectedRef.current) setMessages((prev) => prev.filter((m) => m.id !== ev.messageId));
          break;
        case 'message.upsert': {
          // demette sohbet aynı çerçevede gelir; sohbet bu arada silindiyse (birleştirme) listedeki kopyası kullanılır
          const chat = ev.chat ?? chatsRef.current.get(ev.message.chatId);
          if (ev.chat) queueChat(ev.chat);
          // yalnızca canlı gelen (eşitleme/geçmiş değil) ve yeni mesajlar bildirim çalsın
          if (chat && ev.live && !ev.message.fromMe && !chat.muted && !chat.hidden && !chat.archived && Date.now() - bootTs > 60_000 && Date.now() - ev.message.ts < 120_000) {
            void windowFocused().then((focused) => {
              // uygulamanın bildirimi kapalıysa ne kart ne ses
              if ((!focused || ev.message.chatId !== visibleChatRef.current) && platformNotifyOn(chat.platform) && (chat.kind === 'direct' || groupsNotify())) {
                const body = (ev.message.text || ev.message.attachments?.[0]?.name || 'Yeni mesaj').slice(0, 140);
                // pencere öndeyse sistem bildirimi yerine uygulama içi kart (hangi platformdan geldiği belli olsun)
                if (focused) pushInToast(chat, body);
                else if (bannersEnabled()) desktopNotify(chat.name, stripLeadIcon(body));
                // genel anahtar + uygulama zil sesi + ses düzeyleri
                playNotifySound(chat.platform);
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
            if (!ev.message.fromMe && ev.message.chatId === visibleChatRef.current) void windowFocused().then((f) => f && api.markRead(ev.message.chatId)).catch(() => undefined);
          }
          break;
        }
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


  // Takvim/Odak'tan gelen kutusuna dönünce, arada okunmamış mesaj almış açık sohbeti okundu işaretle
  useEffect(() => {
    if (view !== 'inbox' || !selected) return;
    if ((chatsRef.current.get(selected)?.unread ?? 0) > 0) api.markRead(selected).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // ---- türetilmiş listeler ----
  const allChats = useMemo(() => [...chats.values()], [chats]);
  // Mivelo takvimi: bugünkü etkinlik sayısı (kenar çubuğu) ve değişince görünümü tazeleme sayacı
  const [calTick, setCalTick] = useState(0);
  const [todayEvents, setTodayEvents] = useState(0);
  useEffect(() => {
    const d = new Date();
    const t = ymd(d);
    const n = ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
    api
      .events(t, n)
      .then((l) => setTodayEvents(l.length))
      .catch(() => undefined);
  }, [calTick]);
  // gün dönünce sayaç tazelensin
  useEffect(() => {
    const id = window.setInterval(() => setCalTick((x) => x + 1), 15 * 60_000);
    return () => clearInterval(id);
  }, []);
  // Genel arama (⌘K) ve arama sonucundan açılan mesaj: sohbet açılınca o mesaja gidilip vurgulanır
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focusMsg, setFocusMsg] = useState<{ chatId: string; id: string; ts: number } | null>(null);
  useEffect(() => {
    if (!focusMsg || selected !== focusMsg.chatId) return;
    if (currentMessages.some((m) => m.id === focusMsg.id)) return;
    // hedef mesaj yüklenen pencerede yoksa: o ana kadarki mesajları depodan getir (en çok 1000)
    let alive = true;
    api
      .messages(focusMsg.chatId, 1000, focusMsg.ts + 1)
      .then((older) => {
        if (!alive || selectedRef.current !== focusMsg.chatId) return;
        setMessages((prev) => {
          const ids = new Set(prev.map((m) => m.id));
          return [...older.filter((m) => !ids.has(m.id)), ...prev].sort((a, b) => a.ts - b.ts);
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMsg, selected]);
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
  /** Odak yalnız birebir sohbetleri listeler (gruplar/kanallar "odak dışında" kartında sayılır) */
  const focusWaiting = useMemo(() => waitingChats.filter((c) => c.kind === 'direct'), [waitingChats]);
  const [storyPlatform, setStoryPlatform] = useState<Platform | null>(null);
  const storyChats = useMemo(() => (storyPlatform ? waitingChats.filter((c) => c.platform === storyPlatform) : waitingChats), [waitingChats, storyPlatform]);
  const storyPlatforms = useMemo(() => [...new Set(waitingChats.map((c) => c.platform))], [waitingChats]);

  const isShop = !!platformFilter && PLATFORMS[platformFilter].category === 'shop';
  /** Sipariş sayfası: aynı hesapta bu siparişe bağlı müşteri sorusu (meta.question.orderNumber) */
  const relatedQuestion = useMemo(() => {
    const cur = selected ? chats.get(selected) : undefined;
    if (!cur || !isOrderPage(cur)) return null;
    const no = String((cur.meta?.order as { id?: string } | undefined)?.id ?? '');
    if (!no) return null;
    for (const c of chats.values()) if (c.accountId === cur.accountId && String((c.meta?.question as { orderNumber?: string } | undefined)?.orderNumber ?? '') === no) return c;
    return null;
  }, [chats, selected]);
  /** Pazaryeri sekmelerindeki sayılar: açık sipariş ve yanıt bekleyen soru */
  const shopCounts = useMemo(() => {
    // total: sekmedeki tüm sohbetler (sipariş soruları sekmesini boşken gizlemek için)
    const n: Record<ShopTab, number> = { order: 0, productQ: 0, orderQ: 0 };
    const total: Record<ShopTab, number> = { order: 0, productQ: 0, orderQ: 0 };
    if (!isShop) return { n, total };
    for (const c of inboxChats) {
      if (c.platform !== platformFilter) continue;
      const t = shopTabOf(c)!;
      total[t] += 1;
      if (shopPending(c)) n[t] += 1;
    }
    return { n, total };
  }, [inboxChats, platformFilter, isShop]);
  /**
   * Görüntülenen küme (platform, arşiv/klasör sekmesi, etiket, pazaryeri sekmesi uygulanmış; okunmamış/bekleyen/arama DEĞİL).
   * Liste ve başlıktaki "N yeni" + Okunmamış/Bekleyen sayıları aynı kümeden: eskiden sayılar her zaman gelen kutusundan geliyordu
   * (WhatsApp Arşiv'de 3 okunmuş sohbet varken "233 yeni" görünüyordu; iMessage klasörleri ve e-posta klasörlerinde de aynı).
   */
  const baseList = useMemo(() => {
    const imActive = platformFilter === 'imessage' ? imFolder : null;
    const mailActive = platformFilter && PLATFORMS[platformFilter].category === 'mail' ? mailFolder : null;
    let list = platformFilter && ARCHIVE_TABS.has(platformFilter) && tgArchive ? activeChats.filter((c) => c.platform === platformFilter && !!c.meta?.archived) : imActive ? activeChats : mailActive ? activeChats.filter((c) => c.platform === platformFilter && (mailActive === 'junk' ? c.meta?.folder === 'junk' : c.meta?.folder === 'sent' || (c.meta?.folder !== 'junk' && !!c.lastFromMe))) : [...inboxChats];
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
    if (shopTab && isShop) list = list.filter((c) => shopTabOf(c) === shopTab);
    return list;
  }, [activeChats, inboxChats, platformFilter, tagFilter, imFolder, tgArchive, mailFolder, shopTab, isShop]);
  const chatList = useMemo(() => {
    let list = [...baseList];
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
    // Bekleyen sekmesi: birebir sohbetler önde, gruplar/kanallar arkada (yanıt bekleyenler öne çıkar)
    if (effFilter === 'waiting') list.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || Number(a.kind !== 'direct') - Number(b.kind !== 'direct') || b.lastMessageAt - a.lastMessageAt);
    else if (filter !== 'followup') list.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (smartSort ? score(b) - score(a) : 0) || b.lastMessageAt - a.lastMessageAt);
    return list;
  }, [baseList, filter, platformFilter, query, smartSort]);
  // Liste parça parça çizilir (binlerce sohbet tek seferde DOM'a girince kaydırma/yazma takılıyordu): ilk 300, sona yaklaşınca +300
  const [rowLimit, setRowLimit] = useState(300);
  useEffect(() => setRowLimit(300), [view, filter, platformFilter, tagFilter, imFolder, mailFolder, tgArchive, shopTab, query]);
  const moreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = moreRef.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setRowLimit((n) => n + 300), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [rowLimit, chatList.length > rowLimit]);
  // seçili sohbet (yenileme sonrası geri yüklenen ya da klavyeyle gidilen) çizilen parçanın dışındaysa parçayı büyüt
  useEffect(() => {
    if (!selected) return;
    const idx = chatList.findIndex((c) => c.id === selected);
    if (idx >= rowLimit) setRowLimit(idx + 50);
  }, [selected, chatList, rowLimit]);

  /** Boş liste metni: hangi sekme/filtre boşsa ona göre anlamlı bir açıklama */
  const emptyText = shopTab && isShop && filter === 'all' && !query.trim() ? (shopTab === 'order' ? 'Bu kanalda sipariş yok.' : shopTab === 'orderQ' ? 'Bu kanalda sipariş sorusu yok.' : 'Bu kanalda ürün sorusu yok.') : filter === 'followup' ? 'Takipte sohbet yok. Sohbetin sağ panelinden "Yanıt gelmezse hatırlat" ile ekle.' : imFolder || tgArchive || mailFolder ? 'Bu klasörde sohbet yok.' : query.trim() ? 'Aramayla eşleşen sohbet yok.' : filter === 'unread' && platformFilter !== 'imessage' ? 'Okunmamış sohbet yok.' : filter === 'waiting' && platformFilter !== 'imessage' ? 'Yanıt bekleyen sohbet yok.' : tagFilter ? 'Bu etikette sohbet yok.' : platformFilter ? 'Bu kanalda henüz sohbet yok.' : 'Bu filtreye uyan sohbet yok.';

  const totals = useMemo(() => {
    let unread = 0;
    for (const c of inboxChats) unread += countable(c);
    return { unread, waiting: waitingChats.length };
  }, [inboxChats, waitingChats]);
  /** Başlıktaki "N yeni" ve Okunmamış/Bekleyen sayıları: yalnızca görüntülenen küme (arşiv/klasör sekmesi dahil) */
  const scoped = useMemo(() => {
    let unread = 0;
    let waiting = 0;
    for (const c of baseList) {
      unread += countable(c);
      if (isWaiting(c)) waiting++;
    }
    return { unread, waiting };
  }, [baseList]);

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
  }, [totals.unread]);
  // Web: bildirim izni ilk tıklamada istenir (tarayıcılar kullanıcı hareketi olmadan istenen izni gösterme/engelliyor)
  useEffect(() => {
    if (isTauri || !('Notification' in window) || Notification.permission !== 'default') return;
    const ask = () => void requestWebNotify();
    window.addEventListener('pointerdown', ask, { once: true });
    return () => window.removeEventListener('pointerdown', ask);
  }, []);
  useEffect(() => {
    let un = () => undefined as void;
    let cancelled = false;
    void onDesktopEvent('navigate', (to) => {
      if (to === 'focus') setView('focus');
    }).then((u) => {
      // temizlik dinleyici kurulmadan çalıştıysa hemen kaldır (sızıntı olmasın)
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un();
    };
  }, []);

  // ---- klavye kısayolları ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        // genel arama penceresi: tüm uygulamalar, görünüm/filtreden bağımsız
        e.preventDefault();
        setPaletteOpen((o) => !o);
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
        if (settingsOpen) setSettingsOpen(false);
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
  }, [chatList, selected, view, connectOpen, viewTags, settingsOpen]);

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
          {accountIssue(a) ? (
            <span
              className="alert-ic"
              role="button"
              tabIndex={0}
              aria-label={`${PLATFORMS[a.platform].name}: ${accountIssue(a)!.title}`}
              onMouseEnter={(e) => openAlert(a.id, e.currentTarget)}
              onMouseLeave={closeAlertSoon}
              onClick={(e) => (e.stopPropagation(), openAlert(a.id, e.currentTarget))}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), e.stopPropagation(), openAlert(a.id, e.currentTarget))}
            >
              <Icon name="alert" size={14} sw={2.2} />
            </span>
          ) : (
            <span className={`dot ${a.status}`} style={{ marginLeft: 8 }} />
          )}
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
          <NavItem icon="sparkle" label="Odak" badge="AI" count={focusWaiting.length} active={view === 'focus'} onClick={() => setView('focus')} />
          <NavItem icon="archive" label="Okunmamış" count={totals.unread} active={view === 'inbox' && filter === 'unread' && !platformFilter && !tagFilter} onClick={() => goInbox('unread')} />
          <NavItem icon="calendar" label="Takvim" title="Mivelo takvimi: mesajlardan eklenenler ve kendi etkinliklerin" count={todayEvents} active={view === 'calendar'} onClick={() => setView('calendar')} />
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
          <button
            className="btn ghost sm icon b theme-tg"
            aria-label={theme === 'dark' ? 'Gündüz moduna geç' : 'Gece moduna geç'}
            title={theme === 'dark' ? 'Gündüz moduna geç' : 'Gece moduna geç'}
            onClick={() => setThemePref(theme === 'dark' ? 'light' : 'dark')}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
          </button>
          <button className="btn ghost sm icon b" aria-label="Ayarlar" title="Ayarlar" onClick={() => setSettingsOpen(!settingsOpen)}>
            <Icon name="sliders" size={16} />
          </button>
        </div>
      </nav>
      <Resizer pane="side" />

      {booting && (
        <div className="booting" role="status">
          <span className="spin" /> Çekirdek başlatılıyor…
        </div>
      )}
      <div className="surface">
        {view === 'calendar' ? (
          <CalendarView
            chats={chats}
            notify={notify}
            refreshKey={calTick}
            onMenu={isMobile ? () => setNavOpen(true) : undefined}
            onOpenChat={(chatId, messageId) => (setView('inbox'), setSelected(chatId), setFocusMsg(messageId ? { chatId, id: messageId, ts: Date.now() } : null))}
          />
        ) : view === 'focus' ? (
          <Focus waiting={focusWaiting}chats={inboxChats} ai={ai} notify={notify} onOpen={openChat} onBack={() => setView('inbox')} onMenu={isMobile ? () => setNavOpen(true) : undefined} />
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
                {view === 'inbox' && platformFilter && ARCHIVE_TABS.has(platformFilter) && (
                  <div className="tabs" role="tablist" aria-label={`${PLATFORMS[platformFilter].name} klasörleri`}>
                    <button role="tab" aria-selected={!tgArchive} className={!tgArchive ? 'active' : ''} onClick={() => setTgArchive(false)}>
                      Sohbetler
                    </button>
                    <button role="tab" aria-selected={tgArchive} className={tgArchive ? 'active' : ''} onClick={() => (setTgArchive(true), setFilter('all'))}>
                      Arşiv {archivedCount > 0 && <span className="c">{archivedCount}</span>}
                    </button>
                  </div>
                )}
                {view === 'inbox' && (
                  <div className={`tabs ${isShop ? `shop n${ORDER_Q_PLATFORMS.has(platformFilter!) || shopCounts.total.orderQ > 0 ? 4 : 3}` : ''}`} role="tablist" aria-label={platformFilter === 'imessage' ? 'Mesajlar klasörleri' : 'Filtreler'}>
                    {/* iMessage: Okunmamış yerine Mesajlar uygulamasındaki klasörler */}
                    {isShop ? (
                      <>
                        <button role="tab" aria-selected={filter === 'all' && !shopTab} className={filter === 'all' && !shopTab ? 'active' : ''} onClick={() => (setFilter('all'), setShopTab(null))}>
                          Tümü
                        </button>
                        {(
                          [
                            ['order', 'Siparişler', 'Açık (kargolanmamış) siparişler'],
                            ['productQ', 'Ürün soruları', 'Yanıt bekleyen ürün soruları'],
                            ['orderQ', 'Sipariş soruları', 'Yanıt bekleyen, bir siparişe bağlı müşteri soruları'],
                          ] as Array<[ShopTab, string, string]>
                        )
                          .filter(([k]) => k !== 'orderQ' || ORDER_Q_PLATFORMS.has(platformFilter!) || shopCounts.total.orderQ > 0)
                          .map(([k, label, title]) => (
                            <button key={k} role="tab" title={`${label} · sayı: ${title.toLowerCase()}`} aria-selected={shopTab === k && filter === 'all'} className={shopTab === k && filter === 'all' ? 'active' : ''} onClick={() => (setFilter('all'), setShopTab(k))}>
                              {label} {shopCounts.n[k] > 0 && <span className="c">{fmtCount(shopCounts.n[k])}</span>}
                            </button>
                          ))}
                      </>
                    ) : (platformFilter === 'imessage' ? (['all'] as Filter[]) : (['all', 'unread', 'waiting'] as Filter[])).map((f) => (
                      <button key={f} role="tab" title={f === 'waiting' ? 'Yanıt bekleyenler: birebir sohbetler önce, gruplar sonra' : undefined} aria-selected={filter === f && !imFolder && !mailFolder} className={filter === f && !imFolder && !mailFolder ? 'active' : ''} onClick={() => (setFilter(f), setImFolder(null), setMailFolder(null))}>
                        {f === 'all' ? (platformFilter === 'imessage' ? 'Mesajlar' : 'Tümü') : f === 'unread' ? 'Okunmamış ' : 'Bekleyen '}
                        {f === 'unread' && scoped.unread > 0 && <span className="c">{fmtCount(scoped.unread)}</span>}
                        {f === 'waiting' && scoped.waiting > 0 && <span className="c">{fmtCount(scoped.waiting)}</span>}
                      </button>
                    ))}
                    {(follow.n > 0 || filter === 'followup') && !imFolder && !mailFolder && (
                      <button role="tab" aria-selected={filter === 'followup'} className={`fol ${filter === 'followup' ? 'active' : ''} ${follow.due ? 'due' : ''}`} title="Yanıt gelmezse hatırlatılacak sohbetler" onClick={() => (setFilter('followup'), setImFolder(null), setMailFolder(null), setTgArchive(false), setShopTab(null))}>
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
                    <button key={c.id} className={`qc b ${c.id === selected ? 'on' : ''}`} onClick={() => setSelected(c.id)} title={stripLeadIcon(c.lastPreview)}>
                      {c.unread > 0 && arr.findIndex((x) => x.unread > 0) === i && <span className="qc-bub">{stripLeadIcon(c.lastPreview.replace(/^Sen: /, ''))}</span>}
                      <span className="avwrap">
                        <Avatar name={c.name} size={46} url={c.avatarUrl} />
                        <Chip platform={c.platform} size={17} ring="var(--bg)" />
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
                  groupByDay(chatList.slice(0, rowLimit)).map(([day, items]) => (
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
                {chatList.length > rowLimit && (
                  <div ref={moreRef} className="list-more" aria-hidden="true">
                    <span className="spin" />
                  </div>
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
                relatedQuestion={relatedQuestion}
                onSeedUsed={() => setSeed(null)}
                showDetails={isMobile ? mobileDetails : showDetails}
                onToggleDetails={() => (isMobile ? setMobileDetails((v) => !v) : setShowDetails(!showDetails))}
                onBack={isMobile ? () => setSelected(null) : undefined}
                typing={typing[current.id] ? typing[current.id].name ?? '' : null}
                focusMessageId={focusMsg?.chatId === current.id ? focusMsg.id : undefined}
                onFocusDone={() => setFocusMsg(null)}
                olderBusy={olderBusy}
                hasOlder={noMoreOlder !== current.id}
                onLoadOlder={async () => {
                  const oldest = currentMessages[0];
                  if (olderBusy) return;
                  setOlderBusy(true);
                  try {
                    // platform yanıt vermediyse / bağlı değilse "daha eski yok" denmez: kullanıcı yeniden deneyebilsin
                    const why = (r: { timedOut?: boolean; unavailable?: string } | undefined) =>
                      r?.unavailable ?? (r?.timedOut ? `${PLATFORMS[current.platform]?.name ?? 'Platform'} zamanında yanıt vermedi${current.platform === 'whatsapp' ? ' — telefonda WhatsApp açıkken tekrar dene' : '; biraz sonra tekrar dene'}` : undefined);
                    if (!oldest) {
                      // hiç mesaj yok: platformdan geçmişi iste ve depodan yeniden oku
                      const r = await api.loadHistory(current.id, undefined, 100);
                      const m = await api.messages(current.id);
                      if (selectedRef.current !== current.id) return; // bu arada başka sohbete geçildi: eski sohbetin mesajları yeni seçime yazılmasın
                      if (m.length === 0) {
                        const w = why(r);
                        if (w) notify(w, true);
                        else {
                          setNoMoreOlder(current.id);
                          notify('Platform bu sohbet için mesaj vermedi');
                        }
                      }
                      setMessages(m);
                      return;
                    }
                    // önce depodaki daha eski mesajlar; depoda yoksa platformdan iste (WhatsApp/Telegram/Instagram/…)
                    let more = await api.messages(current.id, 300, oldest.ts);
                    let r: { timedOut?: boolean; unavailable?: string } | undefined;
                    if (more.length === 0) {
                      r = await api.loadHistory(current.id, oldest.ts, 100);
                      more = await api.messages(current.id, 300, oldest.ts);
                    }
                    if (selectedRef.current !== current.id) return; // sohbet değişti: eski mesajlar yeni sohbete karışmasın
                    if (more.length === 0) {
                      const w = why(r);
                      if (w) notify(w, true);
                      else {
                        setNoMoreOlder(current.id);
                        notify('Daha eski mesaj yok');
                      }
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

      <LoginView accounts={accounts} />
      <UpdateBanner />
      <FeedbackButton />

      {settingsP.value && (
        <SettingsModal
          closing={settingsP.closing}
          onClose={() => setSettingsOpen(false)}
          accounts={accounts}
          handleOf={handleOf}
          ai={ai}
          setAi={setAi}
          notify={notify}
          lan={lan}
          setLan={setLanState}
        />
      )}
      {alertPop &&
        (() => {
          const a = accounts.find((x) => x.id === alertPop.id);
          const is = a && accountIssue(a);
          if (!a || !is) return null;
          const left = Math.min(alertPop.x + 12, window.innerWidth - 300);
          const top = Math.max(12, Math.min(alertPop.y - 28, window.innerHeight - 190));
          return (
            <div className="alert-pop" role="dialog" aria-label={`${PLATFORMS[a.platform].name} uyarısı`} style={{ left, top }} onMouseEnter={() => clearTimeout(alertTimer.current)} onMouseLeave={closeAlertSoon}>
              <div className="ap-head">
                <Icon name="alert" size={14} sw={2.2} />
                <b>{PLATFORMS[a.platform].name}</b>
              </div>
              <div className="ap-title">{is.title}</div>
              <p>{is.how}</p>
              <button
                className="btn sm primary b"
                onClick={() => {
                  setAlertPop(null);
                  if (is.action === 'credentials') {
                    // Bağlan: bu hesabın formu, e-posta adresi dolu gelir; kaydedince var olan hesap güncellenip yeniden bağlanır
                    setConnectFocus(`edit:${a.id}`);
                    setConnectOpen(true);
                  } else if (is.action === 'panelOnly') {
                    setConnectFocus(a.id);
                    setConnectOpen(true);
                  } else if (is.action === 'panel') {
                    setConnectFocus(a.id);
                    setConnectOpen(true);
                    notify(is.done);
                    api.restartAccount(a.id).catch((e) => notify(e.message, true));
                  } else if (is.action === 'connect') {
                    setConnectFocus(a.id);
                    setConnectOpen(true);
                    // QR süresi dolmuşsa (ekranda kod yok) yenisini iste
                    if (!qr[a.id]) api.restartAccount(a.id).catch((e) => notify(e.message, true));
                  }
                  else {
                    // pencere açılana (ya da oturum doğrulanana) dek ekranda kalan gösterge; hata olursa kalkar
                    markOpening(a.id, is.done || 'Yeniden bağlanılıyor');
                    api.restartAccount(a.id).catch((e) => (clearOpeningFor(a.id), notify(e.message, true)));
                  }
                }}
              >
                {is.label}
              </button>
            </div>
          );
        })()}
      {paletteOpen && (
        <SearchPalette
          chats={allChats}
          onClose={() => setPaletteOpen(false)}
          onOpenChat={(id) => (setView('inbox'), setSelected(id), setFocusMsg(null))}
          onOpenMessage={(chatId, id, ts) => (setView('inbox'), setSelected(chatId), setFocusMsg({ chatId, id, ts }))}
        />
      )}
      {connectP.value && (
        <ConnectModal
          closing={connectP.closing}
          sync={sync}
          focus={connectFocus} accounts={accounts} qr={qr} prompts={prompts} connected={connectedPlatforms} onClose={() => (setConnectOpen(false), setConnectFocus(null))} notify={notify} onChanged={refresh} />
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
      {openingTexts.length > 0 && (
        <div className="login-opening" role="status" aria-live="polite">
          <span className="spin" /> {openingTexts[openingTexts.length - 1]}…
        </div>
      )}
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
                <Chip platform={t.chat.platform} size={16} ring="var(--card)" />
              </span>
              <span className="body">
                <span className="top">
                  <b>{t.chat.name}</b>
                  <span className="plat">{PLATFORMS[t.chat.platform].name}</span>
                </span>
                <span className="txt">
                  <IconText text={t.text} size={12} />
                </span>
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
                      <Chip platform={c.platform} size={14} ring="var(--card)" />
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

/**
 * Kullanıcı eylemi gereken kanal durumu → yanıp sönen kırmızı işaret + açılır kart (başlık, ne yapmalı, düğme).
 * Geçici 'connecting' uyarı sayılmaz. attention (bağlı ama PIN vb. bekliyor) önce gelir.
 */
/** Giriş bilgisi reddi (yanlış/süresi dolmuş şifre, geçersiz API anahtarı): aynı bilgiyle yeniden denemek işe yaramaz */
const AUTH_FAIL = /giriş reddedildi|uygulama şifresi|şifre|parola|kimlik doğrulama|yetkisiz|unauthori[sz]ed|invalid (credentials|api ?key|token)|authenticationfailed|login failed|auth(entication)? failed|\b40[13]\b|api anahtar/i;
/** Bilgileri Bağlan formundan yeniden girilebilen (şifre/API anahtarıyla bağlanan) kanallar */
const credentialForm = (a: Account) => {
  const p = PLATFORMS[a.platform];
  return p.mode === 'mail' || p.category === 'shop' || ((a.platform === 'gmail' || a.platform === 'icloud' || a.platform === 'yahoo') && /uygulama şifresi|giriş reddedildi/i.test(a.detail ?? ''));
};

function accountIssue(a: Account): { title: string; how: string; label: string; action: 'reconnect' | 'connect' | 'credentials' | 'panel' | 'panelOnly'; done: string } | null {
  const name = PLATFORMS[a.platform].name;
  const browser = PLATFORMS[a.platform].mode === 'browser';
  const detail = (a.detail ?? '').replace(/\s+/g, ' ').trim();
  // Şifre/anahtar reddedildiyse "Yeniden bağlan" aynı bilgiyle tekrar dener ve sessizce yine düşer → bilgileri güncelleme formunu aç
  // Yahoo: uygulama şifresi reddedildi (Yahoo birçok hesapta kapattı) → tarayıcı girişi. Aynı şifreyle yeniden deneme yok (kilitlenme riski)
  // Yandex: aynı — uygulama şifresi yerine normal şifreyle tarayıcı girişi
  if ((a.platform === 'yahoo' || a.platform === 'yandex') && (a.status === 'error' || a.status === 'disconnected') && AUTH_FAIL.test(detail))
    return {
      title: `${a.platform === 'yahoo' ? 'Yahoo' : 'Yandex'} uygulama şifresini kabul etmedi`,
      how: `Uygulama şifresine gerek yok: açılan panelde “${a.platform === 'yahoo' ? 'Yahoo' : 'Yandex'} ile giriş yap” de; normal şifrenle bir kez giriş yapman yeterli.`,
      label: `${a.platform === 'yahoo' ? 'Yahoo' : 'Yandex'} ile giriş yap`,
      action: 'panelOnly',
      done: '',
    };
  if ((a.status === 'error' || a.status === 'pairing' || a.status === 'disconnected') && credentialForm(a) && AUTH_FAIL.test(detail))
    return {
      title: 'Giriş bilgileri reddedildi',
      how: PLATFORMS[a.platform].category === 'shop' ? `${name} API bilgilerini kontrol edip yeniden gir.` : `${name} şifreyi kabul etmedi. Yeni bir uygulama şifresi oluşturup gir (normal hesap şifresi çoğu zaman kabul edilmez).`,
      label: PLATFORMS[a.platform].category === 'shop' ? 'Bilgileri güncelle' : 'Şifreyi güncelle',
      action: 'credentials',
      done: '',
    };
  if (a.attention && a.status === 'connected')
    return {
      title: a.attention,
      how: `Aşağıdaki düğmeye bas; açılan ${name} penceresinde PIN kodunu gir. PIN kabul edilince pencere kendiliğinden kapanır ve bu uyarı kalkar.`,
      label: "PIN'i gir",
      action: 'reconnect',
      done: `${name} penceresi açılıyor — PIN'ini gir`,
    };
  // iMessage bağlı ama Mac'e günlerdir mesaj düşmüyor (Apple eşitlemesi durmuş): kanal satırında uyar, panelde ne yapılacağı yazar
  if (a.status === 'connected' && a.platform === 'imessage' && /yeni mesaj düşmüyor/.test(detail))
    return { title: detail.split(' — ')[0], how: detail.split(' — ').slice(1).join(' — ') || 'Mac’te Mesajlar uygulamasını açıp eşzamanla.', label: 'Ayrıntı', action: 'panel', done: 'Kontrol ediliyor' };
  if (a.status === 'pairing') {
    if (a.platform === 'whatsapp' || a.platform === 'telegram')
      return { title: 'Telefonla eşleştirme bekleniyor', how: `"Uygulama bağla"da ${name} kanalını aç ve ekrandaki QR kodu telefonundaki ${name} ile okut.`, label: "QR'ı göster", action: 'connect', done: '' };
    return {
      // çekirdeğin ayrıntısı talimat içeriyorsa ("… Yeniden bağlan ile …") başlık sade: talimat açıklamada ve düğmede
      title: detail && !/^[+@]/.test(detail) && !/yeniden bağlan/i.test(detail) ? detail : 'Oturum düşmüş, yeniden giriş gerekli',
      how: browser ? `Aşağıdaki düğmeye bas; açılan ${name} penceresinde hesabına giriş yap (doğrulama isterse tamamla). Giriş algılanınca pencere kendiliğinden kapanır.` : `Aşağıdaki düğmeyle yeniden bağlan.`,
      label: 'Yeniden bağlan',
      action: 'reconnect',
      done: `${name} giriş penceresi açılıyor`,
    };
  }
  // Şifre/API anahtarıyla bağlanan kanallarda (e-posta, pazaryeri) sessiz yeniden deneme yetmez: hata ne olursa olsun hesabın
  // Bağlan paneli açılır (tam hata metni + "Şifreyi güncelle" + "Yeniden dene"), yeniden deneme de arka planda başlar
  if ((a.status === 'error' || a.status === 'disconnected') && credentialForm(a))
    return { title: detail || (a.status === 'error' ? 'Bağlantı hatası' : 'Bağlantı kesildi'), how: 'Yeniden deneniyor; açılan panelde hatanın ayrıntısını görürsün. Şifre/anahtar değiştiyse oradan güncelle.', label: 'Yeniden bağlan', action: 'panel', done: 'Yeniden bağlanılıyor' };
  if (a.status === 'error')
    return { title: detail || 'Bağlantı hatası', how: 'Yeniden bağlanmayı dene. Sorun sürerse kanalın ayrıntısına (Uygulama bağla) bak.', label: 'Yeniden bağlan', action: 'reconnect', done: 'Yeniden bağlanılıyor' };
  if (a.status === 'disconnected')
    return { title: detail || 'Bağlantı kesildi', how: `${name} şu an bağlı değil; yeni mesajlar gelmiyor.`, label: 'Yeniden bağlan', action: 'reconnect', done: 'Yeniden bağlanılıyor' };
  return null;
}

/** Kanal satırında platform adının yanında gösterilecek hesap tanıtıcısı (@kullanıcı, +numara, ad) */
function handleOf(a: Account): string {
  const pn = PLATFORMS[a.platform].name.toLowerCase();
  // "Trendyol · 12345" → "12345" (platform adı zaten satırda yazıyor)
  const label = (a.label ?? '').trim().replace(new RegExp(`^${PLATFORMS[a.platform].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*·\\s*`, 'i'), '');
  if (label && !/^(error|hata)$|^olk-|pivot/i.test(label) && label.toLowerCase() !== pn && label.toLowerCase() !== a.platform) return label;
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

/** Platformun kendi arşivi olan kanallar: arşivdekiler "Tümü"de görünmez, ayrı "Arşiv" sekmesinde (Telegram klasörü, WhatsApp Arşivlenmiş) */
const ARCHIVE_TABS = new Set<Platform>(['telegram', 'whatsapp']);

export function isWaiting(c: Chat): boolean {
  // son olay yalnızca bir tepkiyse ("😂 Mert bir mesajı beğendi") yanıt beklemiyor
  // sipariş sayfaları (Trendyol/HB/n11/Shopier) yanıtlanamaz: yanıt bekleyen sayılmaz
  return c.unread > 0 && Date.now() - c.lastMessageAt > 20 * 60_000 && !REACT_TEXT.test(c.lastPreview ?? '') && !isOrderPage(c);
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
      <Icon name={icon} size={17} color={active ? 'var(--v)' : 'var(--text3)'} />
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
  const kind = shopKind(chat);
  // E-posta: üstte gönderen, ortada konu, altta özet (posta istemcisi düzeni)
  const mailSender = isMail ? (chat.participants?.[0]?.name || chat.handle || '').replace(/<.*>/, '').trim() : '';
  const mailPreview = isMail && mailSender && chat.lastPreview?.startsWith(mailSender + ':') ? chat.lastPreview.slice(mailSender.length + 1).trim() : chat.lastPreview;
  return (
    <div className={`row ${selected ? 'selected' : ''} ${chat.unread > 0 ? 'unread' : ''} ${isMail ? 'mailrow' : ''}`} onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <span className="avwrap">
        <Avatar name={isMail && mailSender ? mailSender : chat.name} size={44} url={chat.avatarUrl} />
        <Chip platform={chat.platform} size={17} ring={selected ? 'var(--surface)' : 'var(--bg)'} />
      </span>
      <span className="body">
        <span className="top">
          {chat.pinned && <Icon name="pin" size={12} color="var(--text3)" />}
          {kind && (
            <span className={`skind k-${kind}`} title={kind === 'order' ? 'Sipariş' : questionOrderRef(chat) ? 'Sipariş sorusu' : 'Ürün sorusu'} aria-label={kind === 'order' ? 'Sipariş' : questionOrderRef(chat) ? 'Sipariş sorusu' : 'Ürün sorusu'}>
              <Icon name={kind === 'order' ? 'box' : 'help'} size={12} sw={2} />
            </span>
          )}
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
            <span className="prev">{(isMail ? mailPreview : chat.lastPreview) ? <IconText text={(isMail ? mailPreview : chat.lastPreview)!} size={12} /> : '…'}</span>
          )}
          {chat.unread > 0 && <span className="badge" aria-label={`${chat.unread} okunmamış`}>{fmtBadge(chat)}</span>}
        </span>
      </span>
    </div>
  );
}

/** Ayarlar → AI anahtarı: kullanıcının kendi Anthropic anahtarı; çekirdekte Anahtar Zinciri/DPAPI'de saklanır, geri okunmaz */
