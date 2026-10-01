import { MailFrame } from './MailFrame';
import { trReactionText } from './reaction-text';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EmojiPicker } from './emoji';
import { api, USE_STATIC } from './api';
import { requireAiConsent } from './consent-store';
import { EventEditor } from './CalendarView';
import { API_BASE, isTauri, mediaUrl, openExternal } from './desktop';
import { DEFAULT_TAGS, EDIT_LIMIT_MS, QUOTE_TEXT_PLATFORMS, parseQuoteLine, quoteLine, EDIT_PLATFORMS, PLATFORMS, REPLY_PLATFORMS, UNSEND_LIMIT_MS, UNSEND_PLATFORMS, isOrderPage, questionOrderRef, shopKind, QUICK_REACTIONS, REACT_PLATFORMS, TAG_COLORS, openInAppLink, type Attachment, type CalendarDraft, type Chat, type ChatFlags, type DraftResult, type LinkPreview, type Message, type Platform, type Reaction } from './types';
import { guessWhen } from './when';
import { useAiPrefs } from './ai-prefs';
import { QuestionDraftBar, isShopQuestion } from './QuestionDraft';
import { PersonPanel } from './PersonPanel';
import { VoiceTranscript } from './MlBubble';
import { loadChatTranscripts } from './ml-client';
import { getPrefs, usePrefs } from './prefs';
import { useClosing, Avatar, Chip, Icon, IconText, Resizer, Tag, ago, fmtDay, fmtStamp, fmtTime, leadIcon } from './ui';
import { DUR, EASE, animate, reducedMotion } from './motion/motion';

/** Bağlayıcıların yazdığı sistem mesajı baş emojileri (kullanıcıların nadiren mesaja başladığı): balonda ikon olarak çizilir */
const SYSTEM_LEAD = new Set(['🔒', '🚫', '⏳', '⌛', '🗑', '⚠']);

/** Balon metni: sistem mesajıysa baştaki emoji ikon ("🔒 Tek seferlik fotoğraf…"), değilse olduğu gibi (bağlantılar tıklanır) */
/** Yalnız 1-2 emojiden oluşan metin (ten rengi, ZWJ birleşimleri dahil) */
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}]|\u200D\p{Extended_Pictographic})*\s?){1,2}$/u;
const normQuote = (t: string) => t.replace(/\s+/g, ' ').replace(/[”]/g, '"').trim();
/**
 * Yerel tepkisi olmayan uygulamalarda (TikTok, X, Messenger, iMessage) Mivelo tepkisi alıntı satırlı emoji mesajı olarak gider
 * ("↪ Ayşe: “…”\n❤️"). Sohbette ayrı balon yerine alıntılanan mesajın altında tepki çipi olarak gösterilir; hedef bulunamazsa
 * mesaj olduğu gibi kalır.
 */
function foldTextReactions(list: Message[]): Message[] {
  if (!list.some((m) => m.text.startsWith('↪ '))) return list;
  const out = [...list];
  const drop = new Set<number>();
  for (let i = 0; i < out.length; i++) {
    const q = parseQuoteLine(out[i].text);
    if (!q || !EMOJI_ONLY.test(q.rest.trim())) continue;
    const key = q.text.replace(/…$/, '');
    for (let j = i - 1; j >= 0; j--) {
      if (drop.has(j)) continue;
      const t = out[j];
      if (!normQuote(parseQuoteLine(t.text)?.rest ?? t.text).startsWith(key)) continue;
      const r = { emoji: q.rest.trim(), senderId: out[i].senderId, senderName: out[i].senderName, fromMe: out[i].fromMe };
      out[j] = { ...t, reactions: [...(t.reactions ?? []), r] };
      drop.add(i);
      break;
    }
  }
  return drop.size ? out.filter((_, i) => !drop.has(i)) : out;
}

function bubbleText(raw: string) {
  const text = trReactionText(raw);
  const first = Array.from(text)[0] ?? '';
  const lead = SYSTEM_LEAD.has(first) ? leadIcon(text) : undefined;
  if (!lead?.icon || lead.prefix) return linkify(text);
  return (
    <>
      <span className="lead-ic" aria-hidden="true">
        <Icon name={lead.icon} size={14} />
      </span>
      {linkify(lead.rest)}
    </>
  );
}

type Tone = 'default' | 'short' | 'formal' | 'en';

interface ScheduledSend {
  id: string;
  chatId: string;
  text: string;
  at: number;
  /** çekirdek gönderemedi / zamanı kaçtı (neden) */
  missed?: string;
}

const SCHED_KEY = 'kavsak.scheduled';
const MISSED_KEY = 'kavsak.scheduled.missed';
let schedTimer = 0;
const schedListeners = new Set<() => void>();

/**
 * Zamanlanmış gönderim: gerçek uygulamada çekirdekte tutulur ve gönderilir (arayüz kapalıyken de; /api/scheduled).
 * Arayüz yalnız listeyi önbellekler (scheduled.update olayıyla tazelenir). Statik demoda çekirdek yok → tarayıcı kuyruğu.
 */
const CORE_SCHED = !USE_STATIC;
let coreSched: ScheduledSend[] = [];
/** Gönderilen balonun kalkış süresi (yazma alanından yerine) */
const SEND_MS = 420;

export function refreshScheduled(): void {
  if (!CORE_SCHED) return;
  api
    .scheduled()
    .then((list) => {
      coreSched = list.map((s) => ({ id: s.id, chatId: s.chatId, text: s.text, at: s.at, missed: s.missed?.reason }));
      emitScheduled();
    })
    .catch(() => undefined);
}

function readScheduled(): ScheduledSend[] {
  if (CORE_SCHED) return coreSched;
  try {
    const raw = JSON.parse(localStorage.getItem(SCHED_KEY) || '[]') as ScheduledSend[];
    return Array.isArray(raw) ? raw.filter((x) => x && typeof x.at === 'number' && typeof x.text === 'string' && typeof x.chatId === 'string') : [];
  } catch {
    return [];
  }
}

function emitScheduled(): void {
  for (const fn of schedListeners) fn();
}

/** Bekleyen zamanlanmış gönderileri kurar. Uygulama açıkken süresi gelenin mesajını yollar. */
export function startScheduledSends(): void {
  if (CORE_SCHED) {
    // eski sürümden tarayıcıda kalan bekleyenler çekirdeğe taşınır (bir kez)
    let local: ScheduledSend[] = [];
    try {
      local = (JSON.parse(localStorage.getItem(SCHED_KEY) || '[]') as ScheduledSend[]).filter((x) => x && typeof x.at === 'number' && x.at > Date.now());
      localStorage.removeItem(SCHED_KEY);
    } catch {
      /* yok */
    }
    void Promise.all(local.map((x) => api.schedule(x.chatId, x.text, x.at).catch(() => undefined))).then(refreshScheduled);
    return;
  }
  window.clearTimeout(schedTimer);
  const next = readScheduled().sort((a, b) => a.at - b.at)[0];
  if (!next) return;
  const wait = Math.max(0, next.at - Date.now());
  schedTimer = window.setTimeout(() => void flushScheduled(), Math.min(wait, 2_000_000_000));
}

async function flushScheduled(): Promise<void> {
  const now = Date.now();
  const all = readScheduled();
  // 15 dakikadan fazla gecikmiş olanlar (uygulama kapalıydı) gönderilmez: gece yarısı sürpriz mesaj gitmesin.
  // Kullanıcıya bildirilir ve kompozöre geri konması için "kaçırıldı" listesinde kalır.
  const late = all.filter((s) => s.at <= now - 15 * 60_000);
  const due = all.filter((s) => s.at <= now && s.at > now - 15 * 60_000);
  let rest = all.filter((s) => s.at > now);
  if (late.length) {
    try {
      const missed = JSON.parse(localStorage.getItem(MISSED_KEY) || '[]') as ScheduledSend[];
      localStorage.setItem(MISSED_KEY, JSON.stringify([...missed, ...late].slice(-50)));
    } catch {
      /* yok */
    }
    window.dispatchEvent(new CustomEvent('mivelo:scheduled-missed', { detail: late.length }));
  }
  for (const s of due) {
    try {
      await api.send(s.chatId, s.text);
    } catch {
      rest = [...rest, { ...s, at: Date.now() + 60_000 }];
    }
  }
  try {
    localStorage.setItem(SCHED_KEY, JSON.stringify(rest));
  } catch {
    /* yok */
  }
  emitScheduled();
  startScheduledSends();
}

async function queueScheduled(item: ScheduledSend): Promise<void> {
  if (CORE_SCHED) {
    await api.schedule(item.chatId, item.text, item.at);
    refreshScheduled();
    return;
  }
  try {
    localStorage.setItem(SCHED_KEY, JSON.stringify([...readScheduled(), item]));
  } catch {
    /* yok */
  }
  emitScheduled();
  startScheduledSends();
}

async function cancelScheduled(id: string): Promise<void> {
  if (CORE_SCHED) {
    await api.unschedule(id);
    refreshScheduled();
    return;
  }
  try {
    localStorage.setItem(SCHED_KEY, JSON.stringify(readScheduled().filter((s) => s.id !== id)));
  } catch {
    /* yok */
  }
  emitScheduled();
  startScheduledSends();
}

/**
 * Sohbet başına gönderim zinciri ve gönderilemeyen metinler modül düzeyinde: Conversation her sohbette yeniden kurulur
 * (key=chat.id), bileşen durumu sohbet değişince kaybolurdu. Zincir art arda gönderimlerin sırasını sohbet değişse de korur;
 * başarısız metin açık kompozöre döner, sohbet açık değilse bekler ve sohbet yeniden açılınca kompozöre konur.
 */
const sendChains = new Map<string, Promise<unknown>>();
const failedDrafts = new Map<string, string>();
/** Açık (takılı) kompozörlerin metin ayarlayıcısı, sohbet kimliğine göre */
const composers = new Map<string, (fn: (t: string) => string) => void>();
function restoreFailed(chatId: string, body: string): void {
  const set = composers.get(chatId);
  if (set) set((t) => (t.trim() ? t : body));
  else {
    const prev = failedDrafts.get(chatId);
    failedDrafts.set(chatId, prev ? `${prev}\n${body}` : body);
  }
}

function tomorrowAt(hour: number): number {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

export function Conversation({
  chat,
  messages: stored,
  ai,
  notify,
  onTags,
  showDetails = true,
  onToggleDetails,
  onOpenChat,
  onLoadOlder,
  focusMessageId,
  onFocusDone,
  hasOlder = false,
  olderBusy = false,
  onBack,
  typing,
  onFlags,
  seed,
  onSeedUsed,
  relatedQuestion,
  timeline,
  headerExtra,
  composerExtra,
  onSelectChat,
}: {
  chat: Chat;
  messages: Message[];
  ai: boolean;
  notify: (t: string, err?: boolean) => void;
  onTags: (tags: string[]) => void;
  showDetails?: boolean;
  onToggleDetails?: () => void;
  onOpenChat?: (c: Chat) => void;
  /** Depodaki daha eski mesajları (100'er) yükle */
  /** Genel aramadan gelindi: bu mesaja kaydır ve kısa süre vurgula */
  focusMessageId?: string;
  onFocusDone?: () => void;
  onLoadOlder?: () => void | Promise<void>;
  hasOlder?: boolean;
  olderBusy?: boolean;
  /** Dar ekranda listeye dön */
  onBack?: () => void;
  /** Karşı taraf yazıyor: null hayır, '' evet, 'Ad' grupta kim */
  typing?: string | null;
  /** Yerel bayraklar: sabitle/sessize al/gizle */
  onFlags?: (f: ChatFlags) => void;
  /** Başka ekrandan (Odak) açılırken kompozöre konacak metin ya da kendiliğinden üretilecek taslak */
  seed?: { text?: string; autoDraft?: boolean } | null;
  onSeedUsed?: () => void;
  /** Sipariş sayfası: aynı siparişe bağlı müşteri sorusu sohbeti (varsa) */
  relatedQuestion?: Chat | null;
  /** Kişi birleştirme: birleşik zaman çizelgesi (mesajlar birden çok sohbetten; balonda platform logosu, `chat` = gönderim kanalı) */
  timeline?: { platformOf: (chatId: string) => Platform | undefined };
  /** Başlık altı şerit (kişinin kanalları) ve yazma alanı üstü (gönderim kanalı seçimi) */
  headerExtra?: React.ReactNode;
  composerExtra?: React.ReactNode;
  /** Kimlikle sohbete geç (Kişi paneli) */
  onSelectChat?: (id: string) => void;
}) {
  // Anında görünen giden mesajlar: Enter'a basınca "Gönderiliyor" balonu hemen çıkar, platform onaylayınca gerçek kayıt
  // (WS message.upsert) aynı metinle gelir ve bu kopya gizlenir. Hata olursa balon kalkar, metin kutuya geri döner.
  // realId: platformun verdiği kimlik (onaydan sonra); metin sonradan düzenlense/silinse de kopya kimlikle eşleşir
  const prefs = usePrefs();
  const [outbox, setOutbox] = useState<Array<Message & { realId?: string; retry?: OutSend }>>([]);
  const messages = useMemo(() => {
    // bire bir eşleşme: aynı metin art arda gönderilince ilk gerçek kayıt iki balonu birden gizlemesin
    const used = new Set<string>();
    const mine = outbox.filter((o) => {
      if (o.chatId !== chat.id) return false;
      const hit = stored.find((m) => m.fromMe && !used.has(m.id) && ((o.realId && m.remoteId === o.realId) || (m.text.trim() === o.text && m.ts >= o.ts - 10_000)));
      if (!hit) return true;
      used.add(hit.id);
      return false;
    });
    return mine.length ? [...stored, ...mine] : stored;
  }, [stored, outbox, chat.id]);
  // aramadan gelinen mesaj: yüklenince ortala ve 2,4 sn vurgula (otomatik "en alta kaydır"dan sonra)
  const focusDoneRef = useRef(onFocusDone);
  focusDoneRef.current = onFocusDone;
  useEffect(() => {
    if (!focusMessageId || !stored.some((m) => m.id === focusMessageId)) return;
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-mid="${CSS.escape(focusMessageId)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
      window.setTimeout(() => el.classList.remove('flash'), 2400);
      focusDoneRef.current?.();
    }, 80);
    return () => clearTimeout(t);
  }, [focusMessageId, stored]);
  // ---- yerel AI: sesli mesaj metinleri + otomatik çeviri (MlBubble.tsx / ml-client.ts) ----
  const voiceChats = useMemo(() => [...new Set(messages.filter((m) => m.attachments?.some((a) => a.kind === 'audio')).map((m) => m.chatId))].join('|'), [messages]);
  useEffect(() => {
    if (voiceChats) for (const id of voiceChats.split('|')) loadChatTranscripts(id);
  }, [voiceChats]);
  const [search, setSearch] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (search !== null) searchRef.current?.focus();
  }, [search]);
  // gönderilemeyip bu sohbet kapalıyken bekleyen metin varsa kompozöre geri gelir
  const [text, setText] = useState(() => {
    const t = failedDrafts.get(chat.id) ?? '';
    failedDrafts.delete(chat.id);
    return t;
  });
  useEffect(() => {
    const id = chat.id;
    composers.set(id, setText);
    return () => {
      if (composers.get(id) === setText) composers.delete(id);
    };
  }, [chat.id]);
  // bileşen kalkınca (sohbet değişti) bekleyen mikrofon isteği sonuçlanırsa akış hemen kapatılsın
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const [drafting, setDrafting] = useState(false);
  // Ayarlar → AI: kapalı özellikler gizlenir; taslak kapalıyken üretilen sonuçtan yalnızca özet/aksiyonlar kullanılır
  const aiP = useAiPrefs();
  const draftOn = ai && aiP.drafts;
  const draftShown = draftOn && draft?.draft ? draft : null;
  const [tone, setTone] = useState<Tone>('default');
  const [tagInput, setTagInput] = useState('');
  const [addingTag, setAddingTag] = useState(false);
  // Medya penceresi galeri olarak: sohbetteki tüm görsel/videolar arasında ←/→ ile gezinilir
  const [lightbox, setLightboxState] = useState<LightboxState | null>(null);
  const lightboxP = useClosing(lightbox, 300); // küçük resme geri dönüş (≈280 ms) bitmeden kaldırılmasın
  /** Son tıklanan küçük resim (medya penceresi oradan büyüyerek açılır, kapanınca oraya döner) */
  const thumbRef = useRef<{ el: HTMLElement; at: number } | null>(null);
  useEffect(() => setLightboxState(null), [chat.id]);
  const endRef = useRef<HTMLDivElement>(null);
  const msgsRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  /** Yanıtlanan mesaj (sağa kaydır / Yanıtla): yazma alanının üstünde çubuk, gönderimde alıntılı yanıt */
  const [replyTarget, setReplyTarget] = useState<Message | null>(null);
  useEffect(() => setReplyTarget(null), [chat.id]);
  const canReplyChat = REPLY_PLATFORMS.has(chat.platform) || QUOTE_TEXT_PLATFORMS.has(chat.platform);
  const startReply = useCallback((m: Message) => {
    // düzenleme sürüyorsa bırakılır: yazma alanı düzenleme öncesi metnine döner
    setEditTarget((cur) => {
      if (cur) setText(editSaved.current);
      return null;
    });
    setReplyTarget(m);
    requestAnimationFrame(() => taRef.current?.focus());
  }, []);
  /** Kendi mesajını düzenleme: yazma alanı düzenleme kipinde (üstte çubuk), Enter kaydeder, Esc iptal; önceki taslak saklanır */
  const [editTarget, setEditTarget] = useState<Message | null>(null);
  // yanıt/düzenleme çubuğu kapanırken kısa süre kalır (aşağı kayarak kapanır)
  const replyP = useClosing(replyTarget, 150);
  const editP = useClosing(editTarget, 150);
  const editSaved = useRef('');
  /** Kendi mesajındaki "Düzenle / Herkesten sil" menüsü ve silme onayı (Tauri'de confirm() yok: ikinci tık onaylar) */
  const [ownFor, setOwnFor] = useState<string | null>(null);
  const [delAsk, setDelAsk] = useState<string | null>(null);
  useEffect(() => (setEditTarget(null), setOwnFor(null), setDelAsk(null)), [chat.id]);
  const canEditChat = EDIT_PLATFORMS.has(chat.platform);
  const canUnsendChat = UNSEND_PLATFORMS.has(chat.platform);
  function startEdit(m: Message) {
    setReplyTarget(null);
    setOwnFor(null);
    setDelAsk(null);
    if (!editTarget) editSaved.current = text;
    setEditTarget(m);
    setText(m.text);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }
  function cancelEdit() {
    setEditTarget(null);
    setText(editSaved.current);
    editSaved.current = '';
  }
  async function saveEdit() {
    const m = editTarget;
    if (!m) return;
    const body = text.trim();
    if (!body) return notify('Mesaj boş olamaz; silmek için "Herkesten sil"i kullan', true);
    if (body === m.text) return cancelEdit();
    const saved = editSaved.current;
    cancelEdit();
    try {
      await api.editMessage(m.id, body);
    } catch (e) {
      // başarısızsa düzenleme kipine geri dön (yazılan kaybolmasın)
      editSaved.current = saved;
      setEditTarget(m);
      setText(body);
      notify(`Düzenlenemedi: ${(e as Error).message}`, true);
    }
  }
  async function unsend(m: Message) {
    setOwnFor(null);
    setDelAsk(null);
    if (editTarget?.id === m.id) cancelEdit();
    startDeleteFx(m.id); // görsel: metin bulanıklaşır (API beklemez)
    try {
      await api.deleteMessage(m.id);
      notify('Mesaj herkesten silindi');
    } catch (e) {
      cancelDeleteFx(m.id);
      notify(`Silinemedi: ${(e as Error).message}`, true);
    }
  }
  /** Sağa kaydırarak yanıt: dokunmatik/fare sürükleme ya da trackpad yatay kaydırması; 64 px'i geçince yanıt modu */
  /** Sağa kaydırarak yanıt. Ham hareket (dx) → yumuşatılmış görsel konum (cur, her karede hedefe yaklaşır) →
   *  CSS değişkeni --sw (px, sayı). 60 px sonrası lastik direnci; bırakınca yaylı dönüş (.swipe-back geçişi). */
  const swipe = useRef<{ id: string; x0: number; y0: number; dx: number; cur: number; el: HTMLElement | null; ready: boolean; raf: number; wheelT?: number; wheel?: boolean; cool: number }>(
    { id: '', x0: 0, y0: 0, dx: 0, cur: 0, el: null, ready: false, raf: 0, cool: 0 },
  );
  const SWIPE_READY = 56;
  const rubber = (dx: number) => (dx <= 0 ? 0 : dx < 60 ? dx : Math.min(100, 60 + (dx - 60) * 0.35));
  const swipeFrame = () => {
    const s = swipe.current;
    s.raf = 0;
    if (!s.el) return;
    const target = rubber(s.dx);
    s.cur += (target - s.cur) * 0.42;
    if (Math.abs(target - s.cur) < 0.3) s.cur = target;
    s.el.style.setProperty('--sw', s.cur.toFixed(2));
    s.el.classList.toggle('swiping', s.cur > 0.5);
    const ready = s.cur >= SWIPE_READY;
    if (ready !== s.ready) {
      s.ready = ready;
      s.el.classList.toggle('swipe-ready', ready);
      if (ready) navigator.vibrate?.(8);
    }
    if (s.cur !== target) s.raf = requestAnimationFrame(swipeFrame);
  };
  const swipeTick = () => {
    const s = swipe.current;
    if (!s.raf) s.raf = requestAnimationFrame(swipeFrame);
  };
  /** Trackpad hareketi sürerken tekerlek olaylarını pencereden dinle: balon kayınca imlecin altından çıkıyor, olaylar artık
   *  balona gelmiyordu → hareket yarıda sıfırlanıp yeniden başlıyordu (titreme gibi görünen sıçrama) */
  const wheelFeed = useRef<((e: WheelEvent) => void) | null>(null);
  const swipeReset = () => {
    const s = swipe.current;
    if (s.raf) cancelAnimationFrame(s.raf);
    window.clearTimeout(s.wheelT);
    if (wheelFeed.current) window.removeEventListener('wheel', wheelFeed.current, true);
    wheelFeed.current = null;
    swipe.current = { id: '', x0: 0, y0: 0, dx: 0, cur: 0, el: null, ready: false, raf: 0, cool: s.cool };
  };
  const swipeBegin = (m: Message, el: HTMLElement, x: number, y: number, wheel = false) => {
    swipeReset();
    el.classList.remove('swipe-back');
    swipe.current = { ...swipe.current, id: m.id, x0: x, y0: y, el, wheel };
  };
  const swipeProps = (m: Message) => {
    const done = () => {
      const s = swipe.current;
      const el = s.el;
      const fire = s.ready;
      swipeReset();
      if (!el) return;
      // yaylı dönüş: --sw @property ile kayıtlı olduğundan balon ve ok birlikte geri akar
      el.classList.add('swipe-back');
      el.classList.remove('swipe-ready');
      el.style.setProperty('--sw', '0');
      window.setTimeout(() => {
        el.classList.remove('swipe-back', 'swiping');
        el.style.removeProperty('--sw');
      }, 380);
      if (fire) {
        // trackpad'in atalet olayları hemen ikinci bir kaydırma başlatmasın
        swipe.current.cool = Date.now() + 450;
        startReply(m);
      }
    };
    return {
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (e.button !== 0 || e.pointerType === 'mouse' && e.buttons !== 1) return;
        if ((e.target as HTMLElement).closest('button, a, video, audio, input, textarea')) return;
        swipeBegin(m, e.currentTarget, e.clientX, e.clientY);
      },
      onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
        const s = swipe.current;
        if (s.id !== m.id || s.wheel || !s.el) return;
        const dx = e.clientX - s.x0;
        const dy = Math.abs(e.clientY - s.y0);
        // dikey kaydırma ya da metin seçimi: iptal
        if (s.dx === 0 && (dy > 16 || window.getSelection()?.toString())) return void (dy > 16 && swipeReset());
        if (s.dx === 0 && dx <= 10) return;
        if (s.dx === 0) {
          // yatay hareket kesinleşti: işaretçiyi yakala (balonun dışına çıkınca da sürsün)
          try {
            s.el.setPointerCapture(e.pointerId);
          } catch {
            /* yok say */
          }
          window.getSelection()?.removeAllRanges();
        }
        s.dx = Math.max(0.01, dx - 10);
        swipeTick();
      },
      onPointerUp: () => swipe.current.id === m.id && !swipe.current.wheel && (swipe.current.dx > 0 ? done() : swipeReset()),
      onPointerCancel: () => swipe.current.id === m.id && !swipe.current.wheel && done(),
      // Mac trackpad: iki parmakla sağa kaydırma yatay tekerlek olayı (deltaX < 0) üretir; olaylar kesik gelir,
      // görsel konum rAF ile yumuşatılır, 180 ms olay gelmezse "bırakıldı" sayılır
      onWheel: (e: React.WheelEvent<HTMLElement>) => {
        if (wheelFeed.current) return; // süren hareket pencere dinleyicisinden besleniyor
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.2 || e.deltaX >= 0) return;
        if (Date.now() < swipe.current.cool) return;
        swipeBegin(m, e.currentTarget, 0, 0, true);
        const feed = (ev: { deltaX: number; deltaY: number }) => {
          const s = swipe.current;
          if (!s.wheel) return;
          if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX) * 2 && Math.abs(ev.deltaY) > 4) return void done(); // dikey kaydırmaya döndü
          s.dx = Math.max(0, s.dx - ev.deltaX);
          swipeTick();
          window.clearTimeout(s.wheelT);
          s.wheelT = window.setTimeout(done, 180);
        };
        wheelFeed.current = feed;
        window.addEventListener('wheel', feed, { capture: true, passive: true });
        feed(e);
      },
    };
  };
  /** Slack iş parçacığı odağı: üst mesajın remoteId'si (yalnız o mesaj + yanıtları listelenir, gönderim thread'e gider) */
  const [threadFocus, setThreadFocus] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  /** Bir mesaj için tam emoji seçici (hızlı çubuktaki "+") */
  const [reactPick, setReactPick] = useState<{ id: string; top: number; left: number } | null>(null);
  /** Hızlı tepki çubuğu açık olan mesaj (üstüne gelince yalnız 😊 düğmesi görünür; tıklayınca çubuk açılır) */
  const [barFor, setBarFor] = useState<string | null>(null);
  /** Takvime ekle penceresi (ön doldurulmuş) */
  const [calFor, setCalFor] = useState<CalendarDraft | null>(null);
  /** Metinden takvim taslağı: tarih/saat tahmini + başlık (ilk satır, kısaltılmış) */
  const calFromText = (text: string, notes?: string): CalendarDraft => {
    const w = guessWhen(text);
    const title = text.replace(/\s+/g, ' ').trim().slice(0, 80) || chat.name;
    return { title: `${chat.name}: ${title}`, start: w.time ? `${w.date}T${w.time}` : w.date, notes };
  };
  async function setFollowUp(days: number | null) {
    try {
      await api.setFollowUp(chat.id, days === null ? null : Date.now() + days * 86_400_000);
      notify(days === null ? 'Takip hatırlatması kaldırıldı' : `${days === 7 ? '1 hafta' : `${days} gün`} içinde yanıt gelmezse hatırlatılacak`);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  useEffect(() => {
    if (!barFor) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.rbar, .rtrig, .react-pick')) setBarFor(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [barFor]);
  useEffect(() => {
    if (!ownFor) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.own-menu, .rtrig')) (setOwnFor(null), setDelAsk(null));
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [ownFor]);
  useEffect(() => (setThreadFocus(null), setEmojiOpen(false), setReactPick(null), setBarFor(null)), [chat.id]);
  // yerel tepkisi olmayan mesajlaşma uygulamaları (TikTok, X, Messenger, iMessage): tepki alıntılı emoji yanıtı olarak gider
  const reactAsText = !REACT_PLATFORMS.has(chat.platform) && QUOTE_TEXT_PLATFORMS.has(chat.platform);
  const canReact = REACT_PLATFORMS.has(chat.platform) || reactAsText;
  // takip hatırlatıcısı pazaryeri dışında her sohbette (sağ paneldeki ile aynı)
  const canFollow = PLATFORMS[chat.platform].category !== 'shop';
  const byRemote = useMemo(() => new Map(messages.map((m) => [m.remoteId, m])), [messages]);
  /** Gönderen → profil fotoğrafı: bazı mesajlarda fotoğraf yoksa aynı kişinin başka mesajından ya da üye listesinden */
  const avatarOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of chat.participants ?? []) if (p.avatarUrl) m.set(p.id, p.avatarUrl);
    for (const x of messages) if (x.senderAvatarUrl && !m.has(x.senderId)) m.set(x.senderId, x.senderAvatarUrl);
    return m;
  }, [messages, chat.participants]);
  /** Slack: yanıtı olan üst mesajlar (sağ panel listesi), son yanıta göre */
  const threads = useMemo(() => {
    if (chat.platform !== 'slack') return [] as Array<{ parent: Message; replies: Message[] }>;
    const out = new Map<string, Message[]>();
    for (const m of messages) if (m.threadId) out.set(m.threadId, [...(out.get(m.threadId) ?? []), m]);
    const list: Array<{ parent: Message; replies: Message[] }> = [];
    for (const m of messages) if (m.replyCount || out.has(m.remoteId)) list.push({ parent: m, replies: out.get(m.remoteId) ?? [] });
    return list.sort((a, b) => (b.replies.at(-1)?.ts ?? b.parent.ts) - (a.replies.at(-1)?.ts ?? a.parent.ts));
  }, [messages, chat.platform]);
  async function react(m: Message, emoji: string) {
    setReactPick(null);
    if (reactAsText) return void send(emoji, m);
    try {
      await api.react(chat.id, m.id, emoji);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  const insertEmoji = (e: string) => {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? text.length;
    const end = ta?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + e + text.slice(end));
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = start + e.length;
    });
  };
  const firstIdRef = useRef<string | undefined>(undefined);
  const lastIdRef = useRef<string | undefined>(undefined);
  const chatRef = useRef<string | undefined>(undefined);
  const heightRef = useRef(0);
  const platform = PLATFORMS[chat.platform];
  const role = profileRole(chat);
  const sampleSummary = Array.isArray(chat.meta?.summary) ? chat.meta.summary.filter((x): x is string => typeof x === 'string') : [];
  const summary = draft && draft.summary.length > 0 ? draft.summary : sampleSummary;
  const [summaryAt, setSummaryAt] = useState(0);
  /** E-posta kanalları: balon yerine ileti kartları ve e-posta yanıt alanı */
  const isMail = platform.category === 'mail' && !timeline; // birleşik zaman çizelgesi e-posta düzeninde çizilmez
  // Pazaryeri yanıtları (Trendyol/HB/n11 soru-cevap, sipariş notu) yalnız metin: dosya ve ses gönderilemez
  const canMedia = platform.category !== 'shop';
  /** Sohbet notu: hızlı ve yerel (localStorage, sohbet kimliğine göre); sohbet değişince yeniden okunur */
  const noteKey = `kavsak.note.${chat.id}`;
  const sampleNote = typeof chat.meta?.note === 'string' ? chat.meta.note : '';
  const [chatNote, setChatNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  /** düzenleme taslağı: Kaydet'e basılmadan yazılmaz */
  const [noteDraft, setNoteDraft] = useState('');
  useEffect(() => {
    let v = sampleNote;
    try {
      const stored = localStorage.getItem(noteKey);
      if (stored !== null) v = stored;
    } catch {
      /* yok */
    }
    setChatNote(v);
    setNoteDraft(v);
    setNoteOpen(false);
  }, [noteKey, sampleNote]);
  const saveNote = (v: string) => {
    setChatNote(v);
    try {
      localStorage.setItem(noteKey, v.trim() ? v : '');
    } catch {
      /* yok */
    }
  };
  const [uploading, setUploading] = useState<string | null>(null);
  /** Seçilen ek: hemen gönderilmez, kompozörde önizleme olarak bekler; Gönder ile (açıklama = yazılan metin) gider */
  const [pending, setPending] = useState<{ file: File; url?: string; voice?: boolean } | null>(null);
  const pickFile = (f: File) => {
    if (f.size > 50 * 1024 * 1024) return notify('Dosya 50 MB\'tan büyük', true);
    setPending((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return { file: f, url: f.type.startsWith('image/') || f.type.startsWith('video/') || f.type.startsWith('audio/') ? URL.createObjectURL(f) : undefined };
    });
  };
  // Sesli mesaj kaydı: mikrofon → MediaRecorder; bitince kompozörde ek olarak bekler (dinlenebilir), Gönder ile "voice" bayrağıyla gider
  const [rec, setRec] = useState<{ r: MediaRecorder; stream: MediaStream; chunks: Blob[]; startedAt: number } | null>(null);
  const [recSecs, setRecSecs] = useState(0);
  const recRef = useRef<typeof rec>(null);
  recRef.current = rec;
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setRecSecs(Math.floor((Date.now() - rec.startedAt) / 1000)), 250);
    return () => clearInterval(t);
  }, [rec]);
  const recMime = () => {
    if (typeof MediaRecorder === 'undefined') return '';
    for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']) if (MediaRecorder.isTypeSupported(m)) return m;
    return '';
  };
  async function startRec() {
    if (rec) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return notify('Bu ortamda ses kaydı desteklenmiyor', true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      // izin penceresi açıkken sohbet değiştiyse: kayıt başlatılmaz, mikrofon hemen bırakılır
      if (!aliveRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const mime = recMime();
      const r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48_000 } : undefined);
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.start(250);
      setRecSecs(0);
      setRec({ r, stream, chunks, startedAt: Date.now() });
    } catch (e) {
      const name = (e as Error).name;
      notify(name === 'NotAllowedError' || name === 'SecurityError' ? 'Mikrofon izni verilmedi (Sistem Ayarları → Gizlilik → Mikrofon)' : name === 'NotFoundError' ? 'Mikrofon bulunamadı' : (e as Error).message, true);
    }
  }
  /** keep=false: vazgeç (kayıt atılır) */
  function stopRec(keep: boolean) {
    const cur = recRef.current;
    if (!cur) return;
    setRec(null);
    const secs = (Date.now() - cur.startedAt) / 1000;
    cur.r.onstop = () => {
      cur.stream.getTracks().forEach((t) => t.stop());
      if (!keep || secs < 0.7) {
        if (keep) notify('Kayıt çok kısa');
        return;
      }
      const type = (cur.r.mimeType || 'audio/webm').split(';')[0];
      const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : type.includes('mpeg') ? 'mp3' : 'webm';
      const blob = new Blob(cur.chunks, { type: cur.r.mimeType || type });
      if (blob.size === 0) return notify('Kayıt alınamadı: mikrofon ses vermedi', true);
      const file = new File([blob], `Sesli mesaj ${fmtClock(secs)}.${ext}`, { type: cur.r.mimeType || type });
      setPending((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url);
        return { file, url: URL.createObjectURL(file), voice: true };
      });
    };
    if (cur.r.state !== 'inactive') cur.r.stop();
    else cur.r.onstop(new Event('stop'));
  }
  useEffect(() => () => stopRec(false), [chat.id]); // sohbet değişince açık kayıt atılır
  const clearPending = () => {
    setPending((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
  };
  useEffect(() => () => clearPending(), [chat.id]); // sohbet değişince bekleyen ek atılır
  const [schedOpen, setSchedOpen] = useState(false);
  const [schedWhen, setSchedWhen] = useState('');
  const [queued, setQueued] = useState<ScheduledSend[]>([]);
  // Esc önce en üstteki katmanı kapatır (zamanla/emoji/tepki/bekleyen ek); yakalama evresinde çalışır ki App'in
  // "sohbeti kapat" Esc'i ancak açık katman yoksa devreye girsin (e.defaultPrevented)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const close = schedOpen ? () => setSchedOpen(false) : emojiOpen ? () => setEmojiOpen(false) : reactPick ? () => setReactPick(null) : barFor ? () => setBarFor(null) : pending ? clearPending : null;
      if (!close) return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [schedOpen, emojiOpen, reactPick, barFor, pending]);
  const schedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sync = () => setQueued(readScheduled().filter((s) => s.chatId === chat.id).sort((a, b) => a.at - b.at));
    schedListeners.add(sync);
    sync();
    startScheduledSends();
    return () => {
      schedListeners.delete(sync);
    };
  }, [chat.id]);
  useEffect(() => setSchedOpen(false), [chat.id]);
  useEffect(() => {
    if (!schedOpen) return;
    const close = (e: MouseEvent) => {
      if (!schedRef.current?.contains(e.target as Node)) setSchedOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [schedOpen]);
  function queueAt(at: number) {
    const body = (text || draftShown?.draft || '').trim();
    if (!body) {
      notify('Zamanlamak için bir mesaj yaz');
      return;
    }
    if (!Number.isFinite(at) || at <= Date.now()) {
      notify('Gelecek bir saat seç', true);
      return;
    }
    queueScheduled({ id: crypto.randomUUID(), chatId: chat.id, text: body, at })
      .then(() => {
        setText('');
        setDraft(null);
        setSchedOpen(false);
        notify(`${fmtStamp(at)} tarihinde gönderilecek${CORE_SCHED ? ' · Mivelo açık kaldıkça (pencere kapalı olsa da) gider' : ''}`);
      })
      .catch((e) => notify((e as Error).message, true));
  }
  /** true: gönderildi (bekleyen ek ancak o zaman atılır; hata olursa ek kompozörde kalır, yeniden denenebilir) */
  async function sendFile(file: File, voice = false): Promise<boolean> {
    if (file.size > 50 * 1024 * 1024) {
      notify('Dosya 50 MB\'tan büyük', true);
      return false;
    }
    setUploading(file.name);
    try {
      const data = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1] ?? '');
        r.onerror = () => rej(new Error('Dosya okunamadı'));
        r.readAsDataURL(file);
      });
      await api.sendFile(chat.id, { name: file.name, mime: file.type || 'application/octet-stream', data, caption: text.trim() || undefined, voice: voice || undefined });
      setText('');
      notify(voice ? 'Sesli mesaj gönderildi' : `${file.name} gönderildi`);
      return true;
    } catch (e) {
      notify((e as Error).message, true);
      return false;
    } finally {
      setUploading(null);
    }
  }

  // Kaydırma: sohbet açılınca en alta; "daha eski mesajlar" başa eklenince okunan yer korunur; yeni mesaj gelince
  // yalnızca zaten alttaysan en alta iner (yukarı kaydırırken sohbet durum/okundu güncellemeleriyle aşağı fırlamaz).
  // Çizimden önce (layout): yeni balonun giriş animasyonu kaymış konumdan başlamasın
  useLayoutEffect(() => {
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
    // alttaysan her içerik değişiminde (yeni mesaj, tepki, durum) altta kal
    else if (el && stickRef.current) el.scrollTop = el.scrollHeight;
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
    // Yapışma yalnızca KULLANICI yukarı kaydırınca bırakılır: sağ panel açılıp sütun daralınca metin uzar ve boşluk büyür,
    // ama scrollTop değişmez — bunu "yukarı kaydırdı" sanıp en yeni mesajı yazma alanının altında bırakıyorduk.
    let lastTop = el.scrollTop;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (gap < 80) stickRef.current = true;
      else if (el.scrollTop < lastTop - 2) stickRef.current = false;
      lastTop = el.scrollTop;
      setShowDown(gap > 360);
      heightRef.current = el.scrollHeight;
    };
    // medya yüklenmesi (load olayları kabarcıklanmaz; yakalama evresinde dinlenir)
    const onMediaLoad = () => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
      heightRef.current = el.scrollHeight;
    };
    // Boyut değişimi (sağ panel, takip şeridi, pencere): alttaysan altta kal
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => onMediaLoad()) : undefined;
    ro?.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('load', onMediaLoad, true);
    el.addEventListener('loadedmetadata', onMediaLoad, true);
    return () => {
      ro?.disconnect();
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('load', onMediaLoad, true);
      el.removeEventListener('loadedmetadata', onMediaLoad, true);
    };
  }, [chat.id]);


  // ---- Hareket (motion/conversation.css, .claude/skills/motion-design): yeni balon girişi, tik değişimi, tepki uçuşu, herkesten
  // sil, gönderilemedi, yazıyor → mesaj. Hepsi görsel katman: API çağrıları beklemez. Sohbet açılırken ve yeniden çizimde eski
  // balonlar oynamaz; yalnız sondan geriye yeni kimlikler (≤60) ve son 60 mesajın durumu karşılaştırılır (3000+ mesajda döngü yok).
  const fx = useRef<{ chat: string; seen: Set<string>; status: Map<string, Message['status']>; outIds: string[]; typingAt: number; typingRect?: { w: number; h: number }; sendFx?: Map<string, { at: number; frames: Keyframe[]; group: boolean }> }>({
    chat: '',
    seen: new Set(),
    status: new Map(),
    outIds: [],
    typingAt: 0,
  });
  /** Tepki çubuğunda seçilen emoji: çip çizilince oradan çipe uçar */
  const flyRef = useRef<{ mid: string; emoji: string; from: DOMRect; at: number } | null>(null);
  const armFly = (btn: HTMLElement, mid: string, emoji: string) => {
    flyRef.current = { mid, emoji: colorEmoji(emoji), from: btn.getBoundingClientRect(), at: Date.now() };
  };
  /** Herkesten sil: onayda metin bulanıklaşır; silindi kaydı gelince balon eski boyundan yenisine geçer */
  const delFx = useRef<{ id: string; at: number; w: number; h: number; bg: string; anim: Animation | null } | null>(null);
  const wrapOf = (id: string): HTMLElement | null => msgsRef.current?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`)?.closest<HTMLElement>('.bwrap') ?? null;
  function startDeleteFx(id: string) {
    const bub = wrapOf(id)?.querySelector<HTMLElement>('.bub');
    if (!bub) return;
    const cs = getComputedStyle(bub);
    const anim = animate(bub, [{ color: cs.color, textShadow: `0 0 0 ${cs.color}` }, { color: 'transparent', textShadow: '0 0 8px transparent' }], { duration: 180, easing: EASE.out, fill: 'forwards' });
    delFx.current = { id, at: Date.now(), w: bub.offsetWidth, h: bub.offsetHeight, bg: cs.backgroundColor, anim };
  }
  function cancelDeleteFx(id: string) {
    if (delFx.current?.id !== id) return;
    delFx.current.anim?.cancel();
    delFx.current = null;
  }
  const typingNow = useRef(typing);
  typingNow.current = typing;
  // yazıyor balonunun boyu (mesaj gelince bu boydan gerçek boya uzar)
  useLayoutEffect(() => {
    const f = fx.current;
    if (typing != null) {
      const b = msgsRef.current?.querySelector<HTMLElement>('.typing-bub');
      if (b) f.typingRect = { w: b.offsetWidth, h: b.offsetHeight };
      f.typingAt = 0;
    } else if (f.typingRect && !f.typingAt) f.typingAt = Date.now();
  }, [typing]);
  useLayoutEffect(() => {
    const f = fx.current;
    const tail = messages.slice(-60);
    const outNow = tail.filter((m) => m.id.startsWith('out-')).map((m) => m.id);
    if (f.chat !== chat.id) {
      // sohbet açıldı: var olanlar "görülmüş", animasyon yok
      f.chat = chat.id;
      f.seen = new Set(messages.map((m) => m.id));
      f.status = new Map(tail.filter((m) => m.fromMe).map((m) => [m.id, m.status]));
      f.outIds = outNow;
      f.typingRect = undefined;
      return;
    }
    // gerçek kaydı gelen iyimser balonlar: yerine geçen kayıt giriş animasyonu oynatmaz, tik durumunu devralır
    const vanished = f.outIds.filter((id) => !outNow.includes(id));
    f.outIds = outNow;
    const fresh: Message[] = [];
    for (let i = messages.length - 1; i >= 0 && fresh.length < 60; i--) {
      const m = messages[i];
      if (f.seen.has(m.id)) break;
      f.seen.add(m.id);
      fresh.push(m);
    }
    fresh.reverse();
    // toplu eşitleme (çok sayıda yeni mesaj): animasyon yok
    const animateIn = fresh.length <= 6;
    for (const m of fresh) {
      if (m.fromMe && !m.id.startsWith('out-') && vanished.length) {
        const old = vanished.shift()!;
        const st = f.status.get(old);
        if (st) f.status.set(m.id, st);
        // gerçek kayıt iyimser balonun yerine yeni DOM öğesiyle gelir: kalkış animasyonu kaldığı yerden sürsün (kesilip zıplamasın)
        const sf = f.sendFx?.get(old);
        f.sendFx?.delete(old);
        if (sf && performance.now() - sf.at < SEND_MS) {
          const w = wrapOf(m.id);
          const t = sf.group ? w?.closest<HTMLElement>('.grp') : w;
          const a = animate(t, sf.frames, { duration: SEND_MS, easing: EASE.in });
          if (a) a.currentTime = performance.now() - sf.at;
        }
        continue;
      }
      if (animateIn) enterFx(m);
    }
    if (f.status.size > 400) f.status = new Map(tail.filter((m) => m.fromMe).map((m) => [m.id, f.status.get(m.id) ?? m.status]));
    for (const m of tail) {
      if (!m.fromMe) continue;
      const prev = f.status.get(m.id);
      f.status.set(m.id, m.status);
      if (prev && prev !== m.status) tickFx(m, prev);
    }
    // herkesten sil: silindi kaydı geldi
    const d = delFx.current;
    if (d) {
      const m = tail.find((x) => x.id === d.id);
      if (m?.deleted) {
        delFx.current = null;
        revealDeleted(d);
      } else if (Date.now() - d.at > 8000) cancelDeleteFx(d.id);
    }
    // tepki uçuşu: çip çizildi mi
    const fl = flyRef.current;
    if (fl) {
      const w = Date.now() - fl.at < 4000 ? wrapOf(fl.mid) : null;
      const chip = w ? [...w.querySelectorAll<HTMLElement>('.rchip')].find((c) => c.querySelector('.e')?.textContent === fl.emoji) : undefined;
      if (chip) flyToChip(fl.from, fl.emoji, chip, w!.querySelector<HTMLElement>('.bub'));
      if (chip || !w) flyRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, chat.id]);
  /** Yeni balon: benimki aşağıdan yükselir, gelen soldan kayar; yazıyor göstergesinin yerine gelen balon onun boyundan uzar */
  function enterFx(m: Message) {
    const w = wrapOf(m.id);
    if (!w) return;
    const f = fx.current;
    const bub = w.querySelector<HTMLElement>('.bub');
    if (!m.fromMe && f.typingRect && bub && (typingNow.current != null || Date.now() - f.typingAt < 1500)) {
      const { w: w0, h: h0 } = f.typingRect;
      f.typingRect = undefined;
      const w1 = bub.offsetWidth;
      const h1 = bub.offsetHeight;
      if (w1 >= w0 * 0.8) {
        const color = getComputedStyle(bub).color;
        animate(bub, [{ width: `${w0}px`, height: `${h0}px`, overflow: 'hidden' }, { width: `${w1}px`, height: `${h1}px`, overflow: 'hidden' }], { duration: DUR.std, easing: EASE.std });
        animate(bub, [{ color: 'transparent' }, { color }], { duration: 220, delay: 100, easing: EASE.std, fill: 'backwards' });
        return;
      }
    }
    const grp = w.closest<HTMLElement>('.grp');
    // grubun ilk balonuysa grup (avatar/gönderen adıyla) birlikte gelir
    const target = grp && grp.querySelector('.bwrap') === w ? grp : w;
    const origin = m.fromMe ? '100% 100%' : '0 100%';
    // ortam katmanı: alttaysan eski balonlar yeni balonun boyu kadar sıçramaz, yukarı süzülür
    glideUp(target);
    if (m.fromMe) {
      // gönderme: balon yazma alanından kalkar (dikey yol ≤ 1/3 ekran), hafif aşıp yerine oturur
      const ta = taRef.current?.getBoundingClientRect();
      const r = (bub ?? w).getBoundingClientRect();
      const box = msgsRef.current?.clientHeight ?? 600;
      const dy = ta ? Math.max(16, Math.min(box / 3, ta.top + ta.height / 2 - (r.top + r.height / 2))) : 22;
      const dx = ta ? Math.max(-40, Math.min(0, ta.left + 24 - r.left)) * 0.4 : 0;
      const frames: Keyframe[] = [
        { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(.9)`, transformOrigin: origin },
        { opacity: 1, transform: 'translate(0, -3px) scale(1.012)', transformOrigin: origin, offset: 0.68 },
        { opacity: 1, transform: 'none', transformOrigin: origin },
      ];
      animate(target, frames, { duration: SEND_MS, easing: EASE.in });
      if (m.id.startsWith('out-')) (f.sendFx ??= new Map()).set(m.id, { at: performance.now(), frames, group: target === grp });
    } else {
      // gelme: sol alttan (avatarın köşesinden) büyüyerek gelir, küçük bir yay ve hafif aşma
      animate(
        target,
        [
          { opacity: 0, transform: 'translate(-12px, 10px) scale(.92)', transformOrigin: origin },
          { opacity: 1, transform: 'translate(0, -2px) scale(1.01)', transformOrigin: origin, offset: 0.7 },
          { opacity: 1, transform: 'none', transformOrigin: origin },
        ],
        { duration: 340, easing: EASE.in },
      );
      // ikincil: yeni grubun avatarı balondan biraz sonra "pıt" diye belirir
      if (target === grp) animate(grp.querySelector('.avatar'), [{ opacity: 0, transform: 'scale(.5)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 70, easing: EASE.pop, fill: 'backwards' });
    }
    // ikincil: saat/tik balon oturduktan sonra belirir
    animate(w.querySelector('.bt'), [{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 200, delay: 160, easing: EASE.std, fill: 'backwards' });
  }
  /** Yeni balon altta eklenince (en alttaysan) görünen eski içerik yeni balonun boyu kadar aşağıdan yukarı süzülür (anlık sıçrama yerine) */
  function glideUp(target: HTMLElement) {
    const box = msgsRef.current;
    if (!box || !stickRef.current) return;
    const prev = target.previousElementSibling;
    const gap = prev ? Math.max(0, target.getBoundingClientRect().top - prev.getBoundingClientRect().bottom) : 0;
    const h = Math.min(box.clientHeight / 3, target.offsetHeight + gap);
    if (h < 4) return;
    const top = box.getBoundingClientRect().top;
    const els: Element[] = [];
    for (let node: Element | null = target; node && node !== box && els.length < 14; node = node.parentElement) {
      for (let sib = node.previousElementSibling; sib && els.length < 14; sib = sib.previousElementSibling) {
        if (sib.classList.contains('avatar')) continue; // avatar grubun altına bağlı: yerinde kalır
        if (sib.getBoundingClientRect().bottom < top - h) break; // görünmeyenler zaten görünmez
        els.push(sib);
      }
    }
    for (const el of els) animate(el, [{ transform: `translateY(${h}px)` }, { transform: 'none' }], { duration: 340, easing: EASE.in });
  }
  /** Tik değişimi: saat → tek tik çizilir → ikinci tik kayarak gelir → görüldüde renk (CSS geçişi) + küçük zıplama */
  function tickFx(m: Message, prev: Message['status']) {
    const w = wrapOf(m.id);
    const tk = w?.querySelector<HTMLElement>('.bt .tick');
    if (!w || !tk) return;
    const paths = tk.querySelectorAll<SVGPathElement>('path');
    const draw = (p: SVGPathElement | undefined, delay: number) => {
      if (!p || typeof p.getTotalLength !== 'function') return;
      const l = p.getTotalLength();
      animate(p, [{ strokeDasharray: `${l}`, strokeDashoffset: `${l}` }, { strokeDasharray: `${l}`, strokeDashoffset: '0' }], { duration: 180, delay, easing: EASE.std, fill: 'backwards' });
    };
    const slide = (p: SVGPathElement | undefined, delay: number) => animate(p, [{ opacity: 0, transform: 'translateX(-5px)' }, { opacity: 1, transform: 'none' }], { duration: 160, delay, easing: EASE.in, fill: 'backwards' });
    const st = m.status;
    if (st === 'sent') draw(paths[0], 0);
    else if (st === 'delivered' || st === 'read') {
      if (prev === 'pending' || prev === 'failed') {
        draw(paths[0], 0);
        slide(paths[1], 200);
      } else if (prev === 'sent') slide(paths[1], 0);
      if (st === 'read') animate(tk, [{ transform: 'none' }, { transform: 'scale(1.25)', offset: 0.4 }, { transform: 'none' }], { duration: 260, delay: prev === 'delivered' ? 0 : 160, easing: EASE.std });
    } else if (st === 'failed') {
      // gönderilemedi: sert sallanma ±6px, kırmızı çerçeve, hata simgesi pop, "Yeniden dene" aşağı süzülür
      const bub = w.querySelector<HTMLElement>('.bub');
      animate(bub, [{ transform: 'none' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(2px)' }, { transform: 'none' }], { duration: 360, easing: 'ease-in-out' });
      animate(bub, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: EASE.std, pseudoElement: '::after' });
      animate(tk, [{ transform: 'scale(0)' }, { transform: 'none' }], { duration: 260, easing: EASE.pop });
      animate(w.querySelector('.fail-note'), [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: 120, easing: EASE.in, fill: 'backwards' });
    }
  }
  /** Silindi kaydı: balon eski boyundan/renginden yenisine, "Bu mesaj silindi" belirir (bulanıklaşma 180 ms'yi bitirir) */
  function revealDeleted(d: NonNullable<typeof delFx.current>) {
    d.anim?.cancel();
    const bub = wrapOf(d.id)?.querySelector<HTMLElement>('.bub');
    if (!bub) return;
    const rest = Math.max(0, 180 - (Date.now() - d.at));
    const cs = getComputedStyle(bub);
    animate(bub, [{ width: `${d.w}px`, height: `${d.h}px`, backgroundColor: d.bg }, { width: `${bub.offsetWidth}px`, height: `${bub.offsetHeight}px`, backgroundColor: cs.backgroundColor }], { duration: 280, delay: rest, easing: EASE.std, fill: 'backwards' });
    animate(bub, [{ color: 'transparent' }, { color: cs.color }], { duration: 220, delay: rest + 120, easing: EASE.std, fill: 'backwards' });
  }

  const shown = useMemo(() => {
    const q = (search ?? '').trim().toLocaleLowerCase('tr-TR');
    // "X bir mesajı beğendi" türü olay metinleri sohbette satır olarak gösterilmez (liste önizlemesinde kalır; tepkiler çip olarak görünür)
    const visible = foldTextReactions(messages.filter((m) => !REACT_TEXT.test(m.text)));
    const base = threadFocus ? visible.filter((m) => m.remoteId === threadFocus || m.threadId === threadFocus) : visible;
    if (!q) return base;
    return base.filter((m) => m.text.toLocaleLowerCase('tr-TR').includes(q) || m.senderName.toLocaleLowerCase('tr-TR').includes(q) || m.attachments?.some((a) => a.name?.toLocaleLowerCase('tr-TR').includes(q)));
  }, [messages, search, threadFocus]);
  const groups = useMemo(() => groupMessages(shown), [shown]);
  /** Sohbetteki gezinilebilir medya (eski → yeni): görsel/video, pencerede açılabilen */
  const mediaList = useMemo(() => shown.flatMap((m) => (m.attachments ?? []).filter(isGalleryMedia)), [shown]);
  /** Eki galeri içinde aç; listede yoksa (ör. e-posta eki) tek başına */
  const setLightbox = useCallback(
    (a: Attachment | null, startAt?: number) => {
      if (!a) return setLightboxState(null);
      const same = (x: Attachment) => x === a || (!!(x.url || x.link) && x.url === a.url && x.link === a.link);
      const index = isGalleryMedia(a) ? mediaList.findIndex(same) : -1;
      const start = startAt ? { att: index >= 0 ? mediaList[index] : a, t: startAt } : undefined;
      const th = thumbRef.current;
      thumbRef.current = null;
      const origin = th && Date.now() - th.at < 1000 && th.el.isConnected ? th.el : undefined;
      setLightboxState(index >= 0 ? { list: mediaList, index, start, origin } : { list: [a], index: 0, start, origin });
    },
    [mediaList],
  );
  /** Mesajdaki bağlantı (metin, bağlantı kartı, e-posta gövdesi): yeni sekme yerine uygulama içi pencerede */
  const openLink = useCallback((href: string) => setLightboxState({ list: [linkAttachment(href)], index: 0 }), []);
  // Balon listesi yalnız mesajlar/sohbet/açık menüler değişince yeniden kurulur: yazma alanındaki her tuş vuruşunda
  // (text durumu bu bileşende) ve App'in ilgisiz çizimlerinde 300-1000 balon baştan üretilmesin. Tıklama işleyicileri
  // her çizimde yenilenen işlevleri act ref'inden okur (bayat kapanış olmaz).
  const act = useRef({ react, startEdit, unsend, setFollowUp, calFromText, notify, retryOut, discardOut });
  act.current = { react, startEdit, unsend, setFollowUp, calFromText, notify, retryOut, discardOut };
  const bubbleList = useMemo(
    () =>
      groups.map((g) =>
            g.kind === 'day' ? (
              <div key={g.key} className="datepill">
                {g.label}
              </div>
            ) : (
              <div key={g.key} className={`grp ${g.fromMe ? 'me' : ''}`}>
                {!g.fromMe && <Avatar name={g.senderName} size={28} url={g.items.find((m) => m.senderAvatarUrl)?.senderAvatarUrl ?? avatarOf.get(g.items[0].senderId) ?? (chat.kind === 'direct' ? chat.avatarUrl : undefined)} />}
                <div className="col">
                  {!g.fromMe && chat.kind !== 'direct' && (
                    <span className="sender" style={{ color: senderColor(g.items[0].senderId || g.senderName) }}>
                      {g.senderName}
                    </span>
                  )}
                  {toUnits(g.items).map((u) => {
                    if (u.kind === 'album') {
                      // art arda gelen fotoğraf/videolar tek balonda (WhatsApp albümü gibi); saat ve tik son mesajın
                      const last = u.items[u.items.length - 1];
                      const end = u.i + u.items.length - 1;
                      const pos = g.items.length === u.items.length ? 'first last' : u.i === 0 ? 'first' : end === g.items.length - 1 ? 'last' : 'mid';
                      const reacts = u.items.flatMap((x) => x.reactions ?? []);
                      const foreignA = !!timeline && last.chatId !== chat.id;
                      return (
                        <div key={u.items[0].id} data-mid={u.items[0].id} className={`bwrap ${g.fromMe ? 'me' : ''}`}>
                          <div className={`bub album-bub ${pos}`}>
                            <AlbumView items={u.items} onOpen={setLightbox} />
                            <time className="bt" dateTime={new Date(last.ts).toISOString()} title={fmtStamp(last.ts)}>
                              {timeline && <TlMark p={timeline.platformOf(last.chatId)} />}
                              {fmtTime(last.ts)}
                              {g.fromMe && statusIcon(last.status)}
                            </time>
                          </div>
                          {reacts.length ? <ReactionChips list={reacts} onToggle={canReact && !reactAsText && !foreignA ? (e) => act.current.react(last, e) : undefined} /> : null}
                        </div>
                      );
                    }
                    const { m, i } = u;
                    // alıntı satırıyla gönderilmiş yanıt (TikTok/X/Messenger/LinkedIn/iMessage): kutu olarak göster, metinden çıkar
                    const tq = !m.replyTo ? parseQuoteLine(m.text) : null;
                    const mText = tq ? tq.rest : m.text;
                    // birleşik zaman çizelgesinde başka kanalın mesajı: yanıt/tepki/düzenleme yalnız gönderim kanalındakilerde
                    const foreign = !!timeline && m.chatId !== chat.id;
                    const replyable = !foreign && canReplyChat && !m.remoteId.startsWith('local-') && !m.remoteId.startsWith('out-') && !m.id.startsWith('out-');
                    const isReact = /^(👍|❤️|😂|🔥|👏|😮) .+ (bir mesajı beğendi|mesajına tepki verdi)$/.test(m.text);
                    const parent = m.threadId ? byRemote.get(m.threadId) : undefined;
                    const url = !isReact && !m.attachments?.length && !m.deleted ? firstUrl(m.text) : undefined;
                    // kendi mesajım: düzenle (yalnız metin, süre sınırı içinde) / herkesten sil
                    const own = !foreign && m.fromMe && !m.deleted && !isReact && !m.remoteId.startsWith('local-') && !m.id.startsWith('out-') && !m.remoteId.startsWith('out-');
                    const editable = own && canEditChat && !!m.text.trim() && !m.attachments?.some((a) => a.kind !== 'other') && within(m.ts, EDIT_LIMIT_MS[chat.platform]);
                    const unsendable = own && canUnsendChat && within(m.ts, UNSEND_LIMIT_MS[chat.platform]);
                    return (
                      <div key={m.id} data-mid={m.id} className={`bwrap ${g.fromMe ? 'me' : ''}`} {...(replyable && !isReact ? swipeProps(m) : {})}>
                        {m.threadId && !threadFocus && (
                          <button type="button" className="tq b" onClick={() => setThreadFocus(m.threadId!)} title="İş parçacığını aç">
                            <Icon name="reply" size={12} sw={2} />
                            <span className="tq-h">Bir iş parçacığına yanıt</span>
                            <span className="tq-t">{parent?.text || 'İş parçacığı'}</span>
                          </button>
                        )}
                        <div className={`bub ${g.items.length === 1 ? 'first last' : i === 0 ? 'first' : i === g.items.length - 1 ? 'last' : 'mid'} ${isReact ? 'react' : ''} ${m.deleted ? 'deleted' : ''} ${m.status === 'failed' && g.fromMe ? 'm-failed' : ''}`}>
                          {m.replyTo && (
                            // alıntı: tıklayınca yanıtlanan mesaja kaydır ve vurgula
                            <button
                              type="button"
                              className={`quote b ${m.replyTo.fromMe ? 'mine' : ''}`}
                              onClick={() => {
                                const el = document.querySelector<HTMLElement>(`[data-mid="${CSS.escape(`${chat.id}#${m.replyTo!.remoteId}`)}"]`);
                                if (!el) return act.current.notify('Yanıtlanan mesaj yüklenmemiş (daha eski)');
                                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                                el.classList.remove('flash');
                                void el.offsetWidth;
                                el.classList.add('flash');
                              }}
                            >
                              <b>{m.replyTo.fromMe ? 'Sen' : m.replyTo.senderName}</b>
                              <span>{m.replyTo.text || 'Mesaj'}</span>
                            </button>
                          )}
                          {tq && (
                            <button
                              type="button"
                              className={`quote b ${tq.senderName === 'Sen' ? 'mine' : ''}`}
                              onClick={() => {
                                const key = tq.text.replace(/…$/, '');
                                const hit = [...messages].reverse().find((x) => x.id !== m.id && x.ts <= m.ts && (parseQuoteLine(x.text)?.rest ?? x.text).replace(/\s+/g, ' ').replace(/[”]/g, '"').startsWith(key));
                                const el = hit && document.querySelector<HTMLElement>(`[data-mid="${CSS.escape(hit.id)}"]`);
                                if (!el) return act.current.notify('Yanıtlanan mesaj yüklenmemiş (daha eski)');
                                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                                el.classList.remove('flash');
                                void el.offsetWidth;
                                el.classList.add('flash');
                              }}
                            >
                              <b>{tq.senderName}</b>
                              <span>{tq.text || 'Mesaj'}</span>
                            </button>
                          )}
                          {m.attachments?.map((a, j) => (
                            <AttachmentView key={j} a={a} onOpen={setLightbox} />
                          ))}
                          <VoiceTranscript m={m} />
                          {(() => {
                            const timeEl = !isReact ? (
                              <time className="bt" dateTime={new Date(m.ts).toISOString()} title={fmtStamp(m.ts)}>
                                {m.edited && !m.deleted && <span className="edited">düzenlendi</span>}
                                {timeline && <TlMark p={timeline.platformOf(m.chatId)} />}
                                {fmtTime(m.ts)}
                                {g.fromMe && statusIcon(m.status)}
                              </time>
                            ) : null;
                            if (mText && m.attachments?.length)
                              return (
                                <span className="bub-text">
                                  {bubbleText(mText)}
                                  {timeEl}
                                </span>
                              );
                            return (
                              <>
                                {mText ? bubbleText(mText) : null}
                                {timeEl}
                              </>
                            );
                          })()}
                        </div>
                        {g.fromMe && m.status === 'failed' && (
                          <span className="fail-note" role="status">
                            <Icon name="alert" size={12} sw={2.2} /> Gönderilemedi
                            {m.id.startsWith('out-') && (
                              <>
                                {' · '}
                                <button type="button" onClick={() => act.current.retryOut(m)}>
                                  Yeniden dene
                                </button>
                                {' · '}
                                <button type="button" className="sub" onClick={() => act.current.discardOut(m)}>
                                  Kaldır
                                </button>
                              </>
                            )}
                          </span>
                        )}
                        {url && <LinkCard url={url} />}
                        {m.reactions?.length ? <ReactionChips list={m.reactions} onToggle={canReact && !reactAsText && !foreign ? (e) => act.current.react(m, e) : undefined} /> : null}
                        {!!m.replyCount && !threadFocus && (
                          <button type="button" className="treplies b" onClick={() => setThreadFocus(m.remoteId)}>
                            <span className="tav">
                              {[...new Map((byRemote.size ? messages.filter((x) => x.threadId === m.remoteId) : []).map((x) => [x.senderId, x])).values()].slice(0, 3).map((x) => (
                                <Avatar key={x.senderId} name={x.senderName} size={18} url={x.senderAvatarUrl} />
                              ))}
                            </span>
                            {m.replyCount} yanıt
                            {(() => {
                              const last = messages.filter((x) => x.threadId === m.remoteId).at(-1);
                              return last ? <span className="tago"> · {ago(last.ts)}</span> : null;
                            })()}
                          </button>
                        )}
                        {!isReact &&
                          !m.deleted &&
                          [
                            replyable && (
                              <button key="y" type="button" className="rtrig" aria-label="Yanıtla" title="Yanıtla (ya da balonu sağa kaydır)" onClick={() => (startReply(m), setBarFor(null))}>
                                <Icon name="reply" size={14} />
                              </button>
                            ),
                            !foreign && (canReact || chat.platform === 'slack') && (
                              <button key="r" type="button" className={`rtrig ${barFor === m.id ? 'on' : ''}`} aria-label={canReact ? 'Tepki ver' : 'Hızlı işlemler'} title={canReact ? 'Tepki ver' : 'Hızlı işlemler'} onClick={() => (setBarFor(barFor === m.id ? null : m.id), setReactPick(null))}>
                                <Icon name={canReact ? 'smile' : 'thread'} size={15} />
                              </button>
                            ),
                            !!m.text && (
                              <button key="c" type="button" className="rtrig cal" aria-label="Takvime ekle" title="Takvime ekle" onClick={() => (setCalFor({ ...act.current.calFromText(m.text, `${m.fromMe ? 'Ben' : m.senderName}: ${m.text}`), messageId: m.id }), setBarFor(null))}>
                                <Icon name="calendar" size={14} />
                              </button>
                            ),
                            canFollow && (
                              <button key="f" type="button" className={`rtrig ${chat.followUp ? 'rtrig-on' : ''}`} aria-label={chat.followUp ? 'Takip hatırlatıcısını kaldır' : '2 gün yanıt gelmezse hatırlat'} title={chat.followUp ? 'Takip hatırlatıcısını kaldır' : 'Takip: 2 gün yanıt gelmezse hatırlat'} onClick={(ev) => (!chat.followUp && shakeBell(ev.currentTarget.querySelector('svg')), void act.current.setFollowUp(chat.followUp ? null : 2))}>
                                <Icon name="bell" size={14} />
                              </button>
                            ),
                            (editable || unsendable) && (
                              <button key="o" type="button" className={`rtrig ${ownFor === m.id ? 'on' : ''}`} aria-label="Düzenle veya herkesten sil" title={editable ? 'Düzenle / herkesten sil' : 'Herkesten sil'} aria-expanded={ownFor === m.id} onClick={() => (setOwnFor(ownFor === m.id ? null : m.id), setDelAsk(null), setBarFor(null))}>
                                <Icon name="dots" size={15} />
                              </button>
                            ),
                          ]
                            .filter(Boolean)
                            .map((b, i) => (
                              <span key={i} className={`rpos p${i}`}>
                                {b}
                              </span>
                            ))}
                        {!isReact && barFor === m.id && (canReact || chat.platform === 'slack') && (
                          <span className="rbar" role="toolbar" aria-label="Hızlı işlemler">
                            {canReact &&
                              QUICK_REACTIONS.map((e) => (
                                <button key={e} type="button" className={m.reactions?.some((r) => r.fromMe && r.emoji === e) ? 'on' : ''} onClick={(ev) => (!ev.currentTarget.classList.contains('on') && armFly(ev.currentTarget, m.id, e), act.current.react(m, e), setBarFor(null))} title={reactAsText ? `${e}: ${platform.name}’da tepki yok; alıntılı emoji yanıtı olarak gider (Mivelo’da tepki olarak görünür)` : `${e} tepkisi`}>
                                  {e}
                                </button>
                              ))}
                            {canReact && (
                              <button
                                type="button"
                                className="more"
                                title="Başka emoji"
                                aria-label="Başka emoji"
                                onClick={(ev) => {
                                  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                                  setReactPick(reactPick?.id === m.id ? null : { id: m.id, top: r.bottom + 6, left: Math.max(8, Math.min(window.innerWidth - 300, r.left - 120)) });
                                }}
                              >
                                <Icon name="smile" size={14} />
                              </button>
                            )}
                            {chat.platform === 'slack' && !m.threadId && (
                              <button type="button" className="more" title="İş parçacığında yanıtla" aria-label="İş parçacığında yanıtla" onClick={() => (setThreadFocus(m.remoteId), setBarFor(null))}>
                                <Icon name="thread" size={14} />
                              </button>
                            )}
                          </span>
                        )}
                        {ownFor === m.id && (editable || unsendable) && (
                          <span className="rbar own-menu" role="menu" aria-label="Mesaj işlemleri">
                            {editable && (
                              <button type="button" role="menuitem" onClick={() => act.current.startEdit(m)}>
                                <Icon name="pen" size={14} /> Düzenle
                              </button>
                            )}
                            {unsendable &&
                              (delAsk === m.id ? (
                                <button type="button" role="menuitem" className="danger" onClick={() => void act.current.unsend(m)} autoFocus>
                                  <Icon name="trash" size={14} /> Emin misin? Sil
                                </button>
                              ) : (
                                <button type="button" role="menuitem" onClick={() => setDelAsk(m.id)}>
                                  <Icon name="trash" size={14} /> Herkesten sil
                                </button>
                              ))}
                          </span>
                        )}
                        {reactPick?.id === m.id && (
                          <div className="react-pick" style={{ top: reactPick.top, left: reactPick.left }}>
                            <EmojiPicker compact onPick={(e) => act.current.react(m, e)} onClose={() => setReactPick(null)} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ),
          ),
    // swipeProps yalnız ref'lerle ve sabit startReply ile çalışır; süre sınırı (within) bir sonraki değişimde tazelenir
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, chat, avatarOf, byRemote, messages, threadFocus, barFor, ownFor, delAsk, reactPick, setLightbox, startReply, timeline],
  );

  // ---- takip şeridi: açılınca zil sallanır + şerit aşağı kayarak açılır; yanıt gelip takip kapanınca yeşile dönüp kapanır ----
  const followRef = useRef<HTMLDivElement>(null);
  const followOutRef = useRef<HTMLDivElement>(null);
  const [followExit, setFollowExit] = useState<{ ok: boolean; text: string } | null>(null);
  const followPrev = useRef<{ chat: string; f?: Chat['followUp']; text: string }>({ chat: '', text: '' });
  useLayoutEffect(() => {
    const p = followPrev.current;
    const f = chat.followUp;
    followPrev.current = { chat: chat.id, f, text: f ? followText(chat.name, f) : p.text };
    if (p.chat !== chat.id) return void setFollowExit(null); // sohbet açılışında animasyon yok
    if (!!p.f === !!f) return;
    if (f) {
      setFollowExit(null);
      const el = followRef.current;
      if (!el) return;
      const h = el.offsetHeight;
      animate(el, [{ height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0 }, { height: `${h}px`, paddingTop: '8px', paddingBottom: '8px', opacity: 1 }], { duration: DUR.std, delay: 120, easing: EASE.std, fill: 'backwards' });
      for (const c of el.children) animate(c, [{ transform: 'translateY(-8px)' }, { transform: 'none' }], { duration: 280, delay: 120, easing: EASE.in, fill: 'backwards' });
      shakeBell(el.querySelector('svg'));
      return;
    }
    // kapandı: son mesaj karşıdan ve takip başladıktan sonraysa yanıt geldi (çekirdek kendiliğinden kapattı)
    const last = messages[messages.length - 1];
    setFollowExit({ ok: !!p.f && !!last && !last.fromMe && last.ts > p.f.since, text: p.text });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.followUp, chat.id]);
  useEffect(() => {
    if (!followExit) return;
    const el = followOutRef.current;
    let alive = true;
    let t = 0;
    const close = () => {
      const a = el ? animate(el, [{ height: `${el.offsetHeight}px`, paddingTop: '8px', paddingBottom: '8px', opacity: 1 }, { height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0 }], { duration: 220, easing: EASE.std, fill: 'forwards' }) : null;
      void (a?.finished ?? Promise.resolve()).then(
        () => alive && setFollowExit(null),
        () => alive && setFollowExit(null),
      );
    };
    if (followExit.ok) {
      animate(el?.firstElementChild, [{ transform: 'scale(.6)', opacity: 0.4 }, { transform: 'none', opacity: 1 }], { duration: 240, easing: EASE.pop });
      animate(el, [{ opacity: 0.4 }, { opacity: 1 }], { duration: 240, easing: EASE.std });
      t = window.setTimeout(close, reducedMotion() ? 900 : 1300);
    } else close();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [followExit]);
  const lastIncoming = [...messages].reverse().find((m) => !m.fromMe);
  const needsReply = !!lastIncoming && messages[messages.length - 1]?.id === lastIncoming.id;
  const [mediaOpen, setMediaOpen] = useState(false);
  const mediaP = useClosing(mediaOpen || null);
  const detailsP = useClosing(showDetails || null, 240); // kapanış animasyonu (ctxOut .22s) bitmeden kaldırılmasın
  useEffect(() => setMediaOpen(false), [chat.id]);
  const allShared = useMemo(() => {
    const out: Array<{ att: Attachment; m: Message }> = [];
    for (const m of [...messages].reverse()) for (const att of m.attachments ?? []) out.push({ att, m });
    return out;
  }, [messages]);
  const files = useMemo(() => allShared.slice(0, 4), [allShared]);

  /** summaryOnly: yalnız özet/aksiyon (sağ paneldeki "Özetle"); yanıtlanacak mesaj yokken kompozöre taslak düşmez */
  async function makeDraft(t: Tone = tone, summaryOnly = false) {
    // bulut AI: ilk kullanımda yurt dışına aktarım açık rızası (Consent.tsx); vazgeçilirse hiçbir içerik gönderilmez
    if (!(await requireAiConsent())) return;
    setTone(t);
    setDrafting(true);
    try {
      const r = await api.draft(chat.id, t);
      // taslak kapalıysa ya da yalnız özet istendiyse metni tutma
      setDraft(aiP.drafts && !summaryOnly ? r : { ...r, draft: '' });
      setSummaryAt(Date.now());
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setDrafting(false);
    }
  }

  // Odak'tan "Düzenle": taslak metni kompozöre; "Nazik hatırlatma yaz": taslağı hemen üret
  useEffect(() => {
    if (!seed) return;
    if (seed.text) setText(seed.text);
    else if (seed.autoDraft && draftOn) void makeDraft();
    onSeedUsed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** override: yazma alanı yerine bu metni gönder (yerel AI "Çevir ve gönder") */
  /** reaction: yerel tepkisi olmayan uygulamada tepki = hedef mesajı alıntılayan emoji yanıtı (yazma alanına dokunmaz) */
  async function send(override?: unknown, reaction?: Message) {
    if (editTarget && !reaction) return saveEdit();
    if (pending && !reaction) {
      if (uploading) return;
      const f = pending.file;
      const voice = !!pending.voice;
      // ek ancak gönderim başarılıysa kompozörden kalkar (hata olursa kayıt/dosya kaybolmasın)
      if (await sendFile(f, voice))
        setPending((prev) => {
          if (prev?.file !== f) return prev;
          if (prev.url) URL.revokeObjectURL(prev.url);
          return null;
        });
      return;
    }
    const typed = (typeof override === 'string' ? override : text || draftShown?.draft || '').trim();
    if (!typed) return;
    const chatId = chat.id;
    // yanıt: Slack'te iş parçacığına, yerel alıntısı olanlarda alıntılı yanıt (platform kimliğiyle), diğerlerinde alıntı satırı
    const rt = reaction ?? replyTarget;
    const textQuote = !!rt && QUOTE_TEXT_PLATFORMS.has(chat.platform);
    const body = textQuote && rt ? quoteLine(rt.fromMe ? 'Sen' : rt.senderName, parseQuoteLine(rt.text)?.rest ?? (rt.text || rt.attachments?.[0]?.name || 'Mesaj')) + typed : typed;
    const threadId = threadFocus ?? (rt && chat.platform === 'slack' ? rt.threadId ?? rt.remoteId : undefined);
    const replyTo = rt && chat.platform !== 'slack' && !textQuote ? rt.remoteId : undefined;
    const quote = rt && replyTo ? { remoteId: rt.remoteId, senderName: rt.fromMe ? 'Sen' : rt.senderName, text: (rt.text || rt.attachments?.[0]?.name || '').slice(0, 160), fromMe: rt.fromMe } : undefined;
    const id = `out-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const params: OutSend = { chatId, body, threadId, replyTo, typed, reaction: !!reaction };
    setOutbox((x) => [...x, { id, chatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text: body, ts: Date.now(), status: 'pending', threadId, replyTo: quote, retry: params }]);
    if (!reaction) {
      setText('');
      setDraft(null);
      setReplyTarget(null);
      pressSend();
    }
    return dispatch(id, params);
  }

  /** Giden mesajı platforma yollar (iyimser balon `id`); hata olursa balon "Gönderilemedi · Yeniden dene" ile kalır */
  async function dispatch(id: string, p: OutSend) {
    const { chatId, body, threadId, replyTo } = p;
    // art arda gönderimler sırasını korusun (her biri bir öncekini bekler; arayüz beklemez). Zincir modül düzeyinde,
    // sohbet kimliğine göre: sohbetten çıkıp dönünce yeni mesaj yoldaki eskisini geçmesin
    const run = (sendChains.get(chatId) ?? Promise.resolve()).then(() => api.send(chatId, body, threadId, replyTo));
    const tail = run.catch(() => undefined);
    sendChains.set(chatId, tail);
    void tail.then(() => {
      if (sendChains.get(chatId) === tail) sendChains.delete(chatId);
    });
    try {
      const r = await run;
      setOutbox((x) => x.map((o) => (o.id === id ? { ...o, status: 'sent', realId: r?.remoteId } : o)));
      setTimeout(() => setOutbox((x) => x.filter((o) => o.id !== id)), 5000);
    } catch (e) {
      if (!p.reaction && aliveRef.current) {
        // sohbet açık: balon kırmızı çerçeveyle kalır, altında "Yeniden dene" (metin kaybolmaz)
        setOutbox((x) => x.map((o) => (o.id === id ? { ...o, status: 'failed' } : o)));
      } else {
        setOutbox((x) => x.filter((o) => o.id !== id));
        // sohbet kapandıysa metin, sohbet yeniden açılınca kompozöre gelsin
        if (!p.reaction) restoreFailed(chatId, p.typed);
      }
      notify((e as Error).message, true);
    }
  }
  /** Gönderilemeyen iyimser balonu yeniden yolla (saat → tikler) */
  function retryOut(m: Message) {
    const o = outbox.find((x) => x.id === m.id);
    if (!o?.retry) return;
    setOutbox((x) => x.map((y) => (y.id === m.id ? { ...y, status: 'pending' } : y)));
    void dispatch(o.id, o.retry);
  }
  /** Gönderilemeyen balonu kaldır; yazma alanı boşsa metin oraya döner */
  function discardOut(m: Message) {
    const o = outbox.find((x) => x.id === m.id);
    setOutbox((x) => x.filter((y) => y.id !== m.id));
    if (o?.retry) setText((t) => (t.trim() ? t : o.retry!.typed));
  }
  /** Gönder düğmesi: basılma + kağıt uçak sağ üstten çıkıp soldan geri gelir (s2) */
  const sendBtnRef = useRef<HTMLButtonElement>(null);
  function pressSend() {
    const b = sendBtnRef.current;
    if (!b || reducedMotion()) return;
    animate(b, [{ transform: 'none' }, { transform: 'scale(.92)', offset: 0.3 }, { transform: 'scale(1.05)', offset: 0.7 }, { transform: 'none' }], { duration: 300, easing: EASE.std });
    animate(b.querySelector('svg'), [{ transform: 'none', opacity: 1 }, { transform: 'translate(5px,-5px)', opacity: 0, offset: 0.45 }, { transform: 'translate(-5px,5px)', opacity: 0, offset: 0.46 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: EASE.std });
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape' && editTarget) {
      e.preventDefault(); // sohbet kapanmasın, yalnız düzenleme iptal
      cancelEdit();
      return;
    }
    if (e.key === 'Escape' && replyTarget) {
      e.preventDefault(); // sohbet kapanmasın, yalnız yanıt iptal
      setReplyTarget(null);
      return;
    }
    if (e.key === 'Tab' && draftShown && !text.trim()) {
      e.preventDefault();
      setText(draftShown.draft);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
      // Ayarlar → Genel: Enter gönderir ya da ⌘/Ctrl+Enter gönderir (Enter yeni satır)
      const mod = e.metaKey || e.ctrlKey;
      if (!getPrefs().enterSends && !mod) return;
      e.preventDefault();
      void send();
    }
  }

  return (
    <OpenLinkCtx.Provider value={openLink}>
      <section className="conv" aria-label="Konuşma">
        <header className="conv-head">
          {onBack && (
            <button className="btn icon b b2" onClick={onBack} aria-label="Listeye dön" title="Listeye dön" style={{ transform: 'rotate(90deg)' }}>
              <Icon name="chev" size={15} sw={2} />
            </button>
          )}
          <span className="avwrap conv-open" role="button" tabIndex={0} title="Ayrıntılar" onClick={onToggleDetails} onKeyDown={(e) => e.key === 'Enter' && onToggleDetails?.()}>
            <Avatar name={chat.name} size={40} url={chat.avatarUrl} />
          </span>
          <div className="conv-id conv-open" role="button" tabIndex={0} title="Ayrıntılar" onClick={onToggleDetails} onKeyDown={(e) => e.key === 'Enter' && onToggleDetails?.()}>
            <div className="conv-id-top">
              <h2 title={chat.name}>{chat.name}</h2>
              {chat.tags.slice(0, 1).map((t) => (
                <Tag key={t} name={t} />
              ))}
            </div>
            <span className="sub">
              <Chip platform={chat.platform} size={16} />
              <span className="meta">{platform.name}</span>
              <span className="sep" aria-hidden="true" />
              {typing != null ? (
                <span className="typing-text">
                  {typing ? `${typing.split(' ')[0]} yazıyor` : 'yazıyor'}
                  <span className="tdots"><i /><i /><i /></span>
                </span>
              ) : (
                <span className="meta">{isOrderPage(chat) ? 'Sipariş' : shopKind(chat) === 'question' ? (questionOrderRef(chat) ? 'Sipariş sorusu' : 'Ürün sorusu') : chat.kind === 'group' ? 'Grup' : chat.kind === 'channel' ? 'Kanal' : 'Sohbet'}</span>
              )}
            </span>
          </div>
          <button className={`btn icon b b2 ${search !== null ? 'on' : ''}`} onClick={() => setSearch(search === null ? '' : null)} title="Sohbette ara" aria-label="Ara">
            <Icon name="search" size={15} />
          </button>
        </header>
        {headerExtra}
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

        {!chat.followUp && followExit && (
          <div ref={followOutRef} className={`snooze-banner follow m-exit ${followExit.ok ? 'm-ok' : ''}`} role="status">
            <Icon name={followExit.ok ? 'check' : 'bell'} size={15} sw={followExit.ok ? 2.2 : 1.8} />
            <span>{followExit.ok ? 'Yanıt geldi · takip kapandı' : followExit.text}</span>
          </div>
        )}
        {chat.followUp && (
          <div ref={followRef} className={`snooze-banner follow ${chat.followUp.due ? 'due' : ''}`}>
            <Icon name="bell" size={15} />
            <span>{followText(chat.name, chat.followUp)}</span>
            {chat.followUp.due && draftOn && (
              <button type="button" className="btn xs soft b b2" onClick={() => void makeDraft()}>
                <Icon name="sparkle" size={12} color="var(--v)" sw={2} /> Hatırlatma yaz
              </button>
            )}
            <button type="button" className="btn ghost xs b b2" onClick={() => void setFollowUp(null)}>
              {chat.followUp.due ? 'Kapat' : 'Kaldır'}
            </button>
          </div>
        )}
        {isOrderPage(chat) ? (
          <OrderPage chat={chat} messages={messages} relatedQuestion={relatedQuestion} onOpenChat={onOpenChat} />
        ) : (
        <>
        <div
          className={`msgs ${isMail ? 'mail' : ''}`}
          ref={msgsRef}
          onClickCapture={(e) => {
            const t = (e.target as HTMLElement).closest?.('.al-tile, .att-card');
            thumbRef.current = t ? { el: (t.querySelector('img') ?? t) as HTMLElement, at: Date.now() } : null;
          }}
        >
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
                    {m.hasHtml ? <MailFrame messageId={m.id} fallback={m.text} onLink={openLink} /> : <div className="mail-body">{m.text}</div>}
                    {m.attachments?.length ? (
                      <div className="mail-atts">
                        {m.attachments.map((a, i) => (
                          <a key={i} className="mail-att" href={abs(a.link ?? a.url) ?? '#'} onClick={(e) => (e.preventDefault(), a.link || a.url ? setLightbox(a) : notify('Bu ek indirilemedi (medya kaydı yok)', true))}>
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
          {threadFocus && (
            <div className="tbanner" role="status">
              <Icon name="thread" size={14} />
              <span>
                <b>İş parçacığı</b> · {shown.filter((m) => m.threadId === threadFocus).length} yanıt — yazdıkların bu iş parçacığına gider
              </span>
              <button className="btn xs b b2" onClick={() => setThreadFocus(null)}>
                Tümüne dön
              </button>
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
              {!olderBusy && chat.platform === 'slack' && (
                <>
                  <br />
                  <span style={{ fontSize: 12 }}>Slack’in ücretsiz planı 90 günden eski mesajları gizliyor (Slack’in kendi uygulamasında da görünmez). Bu sohbete yeni mesaj gelince burada görünür.</span>
                </>
              )}
              {!olderBusy && chat.unread > 0 && (
                <>
                  <br />
                  <span style={{ fontSize: 12 }}>Platform mesajları vermedi (X’te şifreli sohbetler bu uçlardan okunamaz).</span>
                </>
              )}
            </div>
          )}
          {messages.length > 0 && shown.length === 0 && <div className="empty">Aramayla eşleşen mesaj yok.</div>}
          {bubbleList}
          {aiP.actions && draft && (draft.events?.length ?? 0) > 0 && (
            <div className="actions">
              <div className="h">
                <span className="ico">
                  <Icon name="calendar" size={13} color="#fff" sw={2} />
                </span>
                {draft.events!.length} tarihli olay
              </div>
              {draft.events!.map((ev, i) => (
                <div key={i} className="it">
                  <Icon name="calendar" size={15} color="var(--text2)" />
                  <span style={{ flexGrow: 1 }}>
                    {ev.title} · <span style={{ color: 'var(--text3)' }}>{fmtEventWhen(ev.start)}</span>
                  </span>
                  <button className="btn soft xs b b2" onClick={() => setCalFor({ ...ev, title: ev.title.includes(chat.name) ? ev.title : `${chat.name}: ${ev.title}` })}>Takvime ekle</button>
                </div>
              ))}
            </div>
          )}
          {aiP.actions && draft && draft.actions.length > 0 && (
            <div className="actions">
              <div className="h">
                <span className="ico">
                  <Icon name="sparkle" size={13} color="#fff" sw={2} />
                </span>
                {draft.actions.length} aksiyon algılandı
              </div>
              {draft.actions.map((a, i) => (
                <div key={i} className="it">
                  <Icon name="calendar" size={15} color="var(--text2)" />
                  <span style={{ flexGrow: 1 }}>{a}</span>
                  <button className="btn soft xs b b2" onClick={() => setCalFor(calFromText(a, a))}>Takvime ekle</button>
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

        <div className={`composer ${draftShown ? 'ai' : ''} ${isMail ? 'mail' : ''}`}>
          {composerExtra}
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
          {/* pazaryeri sorusu: kurallara uygun AI cevap taslağı (QuestionDraft.tsx); genel "Taslak yaz" yerine */}
          {aiP.drafts && isShopQuestion(chat) && <QuestionDraftBar chat={chat} ai={ai} notify={notify} onDraft={(t) => (setText(t), setDraft(null))} />}
          {draftOn && !isShopQuestion(chat) && (
            <div className="comp-top">
              {draftShown ? (
                <span className="aipill on" title={draftShown.style?.length ? `Tarzın: ${draftShown.style.join(', ')}` : undefined}>
                  <Icon name="sparkle" size={13} color="#D4FF3F" sw={2} /> Senin tarzında taslak
                </span>
              ) : (
                <button className="aipill b b2" onClick={() => makeDraft()} disabled={drafting || !needsReply} title={needsReply ? 'Son mesaja taslak yanıt üret' : 'Yanıtlanacak yeni mesaj yok'}>
                  {drafting ? <span className="spin" /> : <Icon name="sparkle" size={13} color="var(--v)" sw={2} />} Taslak yaz
                </button>
              )}
              <span className="ctx-n">· {Math.min(messages.length, 30)} mesaj bağlamı</span>
              <span style={{ flexGrow: 1 }} />
              {(
                [
                  ['short', 'Kısa'],
                  ['formal', 'Resmi'],
                  ['en', 'EN'],
                ] as Array<[Tone, string]>
              ).map(([t, l]) => (
                <button key={t} className={`btn xs b b2 ${tone === t && draftShown ? 'soft' : ''}`} onClick={() => makeDraft(t)} disabled={drafting || (!needsReply && !draftShown)}>
                  {l}
                </button>
              ))}
              <button className="btn xs icon b b2" onClick={() => makeDraft(tone)} disabled={drafting || (!needsReply && !draftShown)} aria-label="Yeniden yaz">
                <Icon name="refresh" size={13} sw={2} />
              </button>
            </div>
          )}
          {draftShown && (draftShown.style?.length ?? 0) > 0 && (
            <div className="style-line" title="Kendi mesajlarından yerelde çıkarıldı; taslak bu tarza göre yazılır">
              <b>Tarzın:</b> {draftShown.style!.join(' · ')}
            </div>
          )}
          {pending && (
            <div className="pend-att">
              {pending.url && pending.file.type.startsWith('image/') ? (
                <img src={pending.url} alt={pending.file.name} />
              ) : pending.url && pending.file.type.startsWith('audio/') ? (
                <span className="pend-file voice">
                  <Icon name="mic" size={16} />
                </span>
              ) : pending.url ? (
                <video src={pending.url} muted playsInline />
              ) : (
                <span className="pend-file">
                  <Icon name="file" size={16} />
                </span>
              )}
              <span className="pend-meta">
                <b>{pending.voice ? 'Sesli mesaj' : pending.file.name}</b>
                {pending.voice && pending.url ? <audio src={pending.url} controls preload="metadata" /> : <span>{fmtSize(pending.file.size)} · Gönder ile gider; yazdığın metin açıklama olur</span>}
              </span>
              <button className="btn ghost xs icon b" onClick={clearPending} aria-label="Eki kaldır" title="Eki kaldır">
                <Icon name="x" size={13} sw={2} />
              </button>
            </div>
          )}
          {replyP.value && (replyTarget || !editTarget) && (
            <div className={`reply-bar ${replyP.closing ? 'm-closing' : ''}`} key={replyP.value.id}>
              <Icon name="reply" size={14} sw={2} />
              <span className="rb-body">
                <b>{replyP.value.fromMe ? 'Kendine' : replyP.value.senderName} yanıt veriyorsun</b>
                <span>{replyP.value.text || replyP.value.attachments?.[0]?.name || 'Mesaj'}</span>
              </span>
              <button className="btn ghost xs icon b" onClick={() => setReplyTarget(null)} aria-label="Yanıtı iptal et" title="İptal (Esc)">
                <Icon name="x" size={13} sw={2} />
              </button>
            </div>
          )}
          {editP.value && (editTarget || !replyTarget) && (
            <div className={`reply-bar edit-bar ${editP.closing ? 'm-closing' : ''}`} key={`e-${editP.value.id}`}>
              <Icon name="pen" size={14} sw={2} />
              <span className="rb-body">
                <b>Mesajı düzenle</b>
                <span>{editP.value.text}</span>
              </span>
              <button className="btn ghost xs icon b" onClick={cancelEdit} aria-label="Düzenlemeyi iptal et" title="İptal (Esc)">
                <Icon name="x" size={13} sw={2} />
              </button>
            </div>
          )}
          {draftShown && !text.trim() && <div className="ghost-draft">{draftShown.draft}</div>}
          <textarea
            spellCheck={prefs.spellcheck}
            ref={taRef}
            rows={2}
            value={text}
            placeholder={threadFocus ? 'İş parçacığına yanıt yaz…' : pending ? 'Açıklama ekle (isteğe bağlı) ve Gönder' : draftShown ? 'Taslağı kabul etmek için Tab, düzenlemek için yazmaya başla' : chat.platform === 'shopier' ? 'Siparişe yerel not ekle (Shopier alıcıya mesaj ucu sunmuyor)…' : isMail ? (prefs.enterSends ? 'Yanıtını yaz… (Enter gönderir, Shift+Enter yeni satır)' : 'Yanıtını yaz… (⌘/Ctrl+Enter gönderir)') : `${chat.name.length > 40 ? chat.name.slice(0, 38) + '…' : chat.name} için mesaj yaz…`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            style={draftShown && !text.trim() ? { minHeight: 28, paddingTop: 0 } : undefined}
          />
          {queued.length > 0 && (
            <div className="sched-list">
              {queued.map((s) => (
                <div key={s.id} className="sched-row">
                  <Icon name="calendar" size={14} />
                  <span title={s.missed}>
                    {s.missed ? <b style={{ color: 'var(--danger)', fontWeight: 600 }}>Gönderilmedi · </b> : null}
                    {fmtStamp(s.at)} · {s.text}
                  </span>
                  {s.missed && (
                    <button className="btn ghost xs b" onClick={() => (setText(s.text), cancelScheduled(s.id).catch(() => undefined))}>
                      Düzenle
                    </button>
                  )}
                  <button className="btn ghost xs b" onClick={() => cancelScheduled(s.id).then(() => notify(s.missed ? 'Kaldırıldı' : 'Zamanlama iptal edildi')).catch((e) => notify((e as Error).message, true))}>{s.missed ? 'Kaldır' : 'Vazgeç'}</button>
                </div>
              ))}
            </div>
          )}
          <div className="comp-bottom">
            {canMedia && (
            <label
              className="btn ghost sm icon b"
              role="button"
              tabIndex={0}
              aria-label="Fotoğraf, video veya dosya ekle"
              title="Fotoğraf / video / dosya gönder"
              style={{ cursor: uploading ? 'progress' : 'pointer' }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                e.currentTarget.querySelector('input')?.click();
              }}
            >
              <Icon name="clip" size={16} />
              <input type="file" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.txt" style={{ display: 'none' }} disabled={!!uploading} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) pickFile(f); }} />
            </label>
            )}
            <span className="emoji-anchor">
              <button className={`btn ghost sm icon b ${emojiOpen ? 'soft' : ''}`} onClick={() => setEmojiOpen((v) => !v)} aria-label="Emoji ekle" title="Emoji" aria-expanded={emojiOpen}>
                <Icon name="smile" size={16} />
              </button>
              {emojiOpen && <EmojiPicker onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />}
            </span>
            {rec ? (
              <span className="rec-bar" role="status" aria-live="polite">
                <span className="rec-dot" />
                <span className="rec-time">{fmtClock(recSecs)}</span>
                <span className="hint">Kaydediliyor…</span>
                <button className="btn ghost xs icon b" onClick={() => stopRec(false)} aria-label="Kaydı at" title="Kaydı at">
                  <Icon name="trash" size={14} />
                </button>
                <button className="btn primary xs b" onClick={() => stopRec(true)} aria-label="Kaydı bitir" title="Kaydı bitir">
                  <Icon name="checks" size={14} sw={2} /> Bitir
                </button>
              </span>
            ) : (
              !isMail && canMedia && (
                <button className="btn ghost sm icon b" onClick={() => void startRec()} disabled={!!uploading} aria-label="Sesli mesaj kaydet" title="Sesli mesaj kaydet">
                  <Icon name="mic" size={16} />
                </button>
              )
            )}
            {uploading && <span className="hint">{uploading} gönderiliyor…</span>}
            <div className="sched" ref={schedRef}>
              <button className={`btn ghost sm icon b ${schedOpen ? 'soft' : ''}`} aria-label="Zamanla gönder" title="Zamanla gönder" aria-expanded={schedOpen} onClick={() => setSchedOpen((v) => !v)}>
                <Icon name="calendar" size={16} />
              </button>
              {schedOpen && (
                <div className="sched-pop" role="dialog" aria-label="Gönderim zamanı">
                  <button className="b" onClick={() => queueAt(Date.now() + 3_600_000)}>1 saat sonra</button>
                  <button className="b" onClick={() => queueAt(tomorrowAt(9))}>Yarın 09:00</button>
                  <label>
                    <input type="datetime-local" value={schedWhen} onChange={(e) => setSchedWhen(e.target.value)} />
                    <button className="b" onClick={() => queueAt(new Date(schedWhen).getTime())}>Ayarla</button>
                  </label>
                </div>
              )}
            </div>
            <span style={{ flexGrow: 1 }} />
            {draftShown && !text.trim() && (
              <span className="hint">
                <span className="kbd">Tab</span> kabul et
              </span>
            )}
            <button ref={sendBtnRef} className="btn primary b" onClick={() => void send()} disabled={!!uploading || !!rec || !(pending || text.trim() || draftShown?.draft)}>
              {uploading ? <span className="spin" /> : <Icon name={editTarget ? 'check' : 'send'} size={15} sw={1.9} />} {editTarget ? 'Kaydet' : 'Gönder'}
            </button>
          </div>
        </div>
        </>
        )}
      </section>


      {detailsP.value && (
      <>
      <Resizer pane="ctx" sign={-1} />
      <aside className={`ctx ${detailsP.closing ? 'closing' : ''}`} aria-label="Kişi ayrıntıları">
        <div className="ctx-bar">
          {onToggleDetails && (
            <button className="btn icon b b2" onClick={onToggleDetails} title="Ayrıntı panelini gizle" aria-label="Paneli kapat">
              <Icon name="panel" size={15} />
            </button>
          )}
        </div>
        <div className="profile">
          <span className="avwrap">
            <Avatar name={chat.name} size={86} url={chat.avatarUrl} />
            <Chip platform={chat.platform} size={22} ring="var(--ctx-bg)" />
          </span>
          <span className="name">{chat.name}</span>
          {role && (role.href ? <a className="role" href={role.href} target="_blank" rel="noreferrer">{role.text}</a> : <span className="role">{role.text}</span>)}
          <span className="sub">
            {platform.name}
            {' · '}
            {isOrderPage(chat) ? 'sipariş' : shopKind(chat) === 'question' ? (questionOrderRef(chat) ? 'sipariş sorusu' : 'ürün sorusu') : chat.kind === 'group' ? 'grup' : chat.kind === 'channel' ? 'kanal' : 'sohbet'}
          </span>
        </div>
        {PLATFORMS[chat.platform].category === 'shop' && (chat.meta?.order as OrderMeta | undefined)?.items ? <OrderPanel chat={chat} notify={notify} /> : null}
        {PLATFORMS[chat.platform].category === 'shop' && !chat.meta?.order && chat.meta?.question ? <QuestionPanel chat={chat} /> : null}

        <div className="qacts one">
          <button className={`b b2 ${noteOpen || chatNote ? 'go' : ''}`} onClick={() => (setNoteDraft(chatNote), setNoteOpen((v) => !v))}>
            <Icon name="pen" size={16} /> {chatNote ? 'Notu düzenle' : 'Not ekle'}
          </button>
        </div>

        <PersonPanel chat={chat} onSelectChat={onSelectChat} notify={notify} />

        {onFlags && (
          <div className="ctx-sec">
            <span className="label">Eylemler</span>
            <div className="acts">
              {(() => {
                const o = openInAppLink(chat);
                return o ? (
                  <button type="button" className="act b" onClick={() => void openExternal(o.href)}>
                    <Chip platform={chat.platform} size={16} />
                    <span>{o.label}</span>
                    <Icon name="external" size={12} />
                  </button>
                ) : null;
              })()}
              <button type="button" className={`act b ${chat.pinned ? 'on' : ''}`} onClick={() => onFlags({ pinned: !chat.pinned })}>
                <Icon name="pin" size={15} /> <span>{chat.pinned ? 'Sabitlemeyi kaldır' : 'Üstte sabitle'}</span>
              </button>
              <button type="button" className={`act b ${chat.muted ? 'on' : ''}`} onClick={() => onFlags({ muted: !chat.muted })}>
                <Icon name="mute" size={15} /> <span>{chat.muted ? 'Sesi aç' : 'Sessize al'}</span>
              </button>
              <button type="button" className={`act b ${chat.hidden ? 'on' : ''}`} onClick={() => onFlags({ hidden: !chat.hidden })}>
                <Icon name="eyeoff" size={15} /> <span>{chat.hidden ? 'Gizlemeyi kaldır' : 'Gizle'}</span>
              </button>
            </div>
          </div>
        )}

        {PLATFORMS[chat.platform].category !== 'shop' && (
          <div className="ctx-sec">
            <span className="label">Takip hatırlatıcısı</span>
            {chat.followUp ? (
              <div className={`follow-card ${chat.followUp.due ? 'due' : ''}`}>
                <Icon name="bell" size={15} />
                <span>{chat.followUp.due ? 'Süre doldu, yanıt gelmedi' : `${fmtFollow(chat.followUp.at)} yanıt gelmezse hatırlatılacak`}</span>
                <button type="button" className="btn ghost xs b b2" onClick={() => void setFollowUp(null)}>
                  Kaldır
                </button>
              </div>
            ) : (
              <div className="follow-opts">
                <span className="hint">Yanıt gelmezse hatırlat</span>
                {([1, 2, 3, 7] as const).map((d) => (
                  <button key={d} type="button" className="btn xs b b2" onClick={() => void setFollowUp(d)}>
                    {d === 7 ? '1 hafta' : `${d} gün`}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {threads.length > 0 && (
          <div className="ctx-sec">
            <span className="label">İş parçacıkları · {threads.length}</span>
            <div className="tlist">
              {threads.slice(0, 6).map(({ parent, replies }) => {
                const last = replies.at(-1);
                const fresh = !!last && !last.fromMe && Date.now() - last.ts < 24 * 3600_000;
                return (
                  <button key={parent.id} type="button" className={`titem b ${threadFocus === parent.remoteId ? 'on' : ''}`} onClick={() => setThreadFocus(parent.remoteId)}>
                    <span className={`tdot ${fresh ? 'on' : ''}`} />
                    <span className="tbody">
                      <span className="tt">{parent.text || '[ek]'}</span>
                      {last && (
                        <span className="tl">
                          <b>{last.fromMe ? 'Sen' : last.senderName.split(' ')[0]}:</b> {last.text || '[ek]'}
                        </span>
                      )}
                      <span className="tn">{parent.replyCount ?? replies.length} yanıt{last ? ` · ${ago(last.ts)}` : ''}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {(noteOpen || chatNote) && (
          <div className="card ctx-note">
            <span className="h">
              <Icon name="pen" size={13} sw={2} /> Not
            </span>
            {noteOpen ? (
              <>
                <textarea autoFocus value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Bu kişi/sohbet hakkında not…" rows={4} />
                <div className="note-actions">
                  <button className="btn primary sm b b2" onClick={() => (saveNote(noteDraft), setNoteOpen(false), notify(noteDraft.trim() ? 'Not kaydedildi' : 'Not silindi'))}>
                    <Icon name="check" size={13} sw={2} /> Kaydet
                  </button>
                  <button className="btn sm b b2" onClick={() => (setNoteDraft(chatNote), setNoteOpen(false))}>
                    Kapat
                  </button>
                  {chatNote && (
                    <button className="btn ghost sm b b2" style={{ marginLeft: 'auto' }} onClick={() => (saveNote(''), setNoteDraft(''), setNoteOpen(false), notify('Not silindi'))}>
                      <Icon name="trash" size={13} /> Sil
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="note-text" onClick={() => (setNoteDraft(chatNote), setNoteOpen(true))}>
                {chatNote}
              </div>
            )}
          </div>
        )}

        {aiP.summary && (
          <div className="card sum">
            <span className="h">
              <span className="sum-ic"><Icon name="sparkle" size={13} color="var(--v)" sw={2} /></span>
              Özet
              {draft && draft.summary.length > 0 && summaryAt > 0 && <span className="when">{fmtTime(summaryAt)}</span>}
            </span>
            {summary.length > 0 ? (
              <ul>
                {summary.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            ) : ai ? (
              <button type="button" className="btn xs soft b b2" style={{ alignSelf: 'flex-start' }} onClick={() => void makeDraft(tone, !needsReply)} disabled={drafting}>
                {drafting ? <span className="spin" /> : <Icon name="sparkle" size={12} color="var(--v)" sw={2} />} Özetle
              </button>
            ) : (
              <span className="empty-sum">Özet için AI anahtarı gerekir.</span>
            )}
          </div>
        )}

        {aiP.actions && draft && draft.actions.length > 0 && (
          <div className="ctx-sec">
            <span className="label">Aksiyonlar</span>
            <div className="todos">
              {draft.actions.map((a, i) => (
                <label key={i} className="todo">
                  <input type="checkbox" /> <span style={{ flexGrow: 1 }}>{a}</span>
                  <button type="button" className="btn ghost xs icon b b2" title="Takvime ekle" aria-label="Takvime ekle" onClick={(e) => (e.preventDefault(), setCalFor(calFromText(a, a)))}>
                    <Icon name="calendar" size={13} />
                  </button>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="ctx-sec">
          <span className="label">Etiketler</span>
          <div className="ctx-tags">
            {chat.tags.map((t) => (
              <button key={t} type="button" className="ctx-tag b" title="Etiketi kaldır" aria-label={`${t} etiketini kaldır`} onClick={() => (onTags(chat.tags.filter((x) => x !== t)), notify(`“${t}” etiketi kaldırıldı`))}>
                {t === 'fırsat' ? <Icon name="sparkle" size={11} color={TAG_COLORS[t][1]} sw={2} /> : <span className="dot" style={{ background: TAG_COLORS[t]?.[1] ?? 'var(--text3)' }} />}
                {t}
                <span className="x" aria-hidden><Icon name="x" size={10} sw={2.2} /></span>
              </button>
            ))}
            <button type="button" className={`ctx-tag add b ${addingTag ? 'on' : ''}`} aria-label="Etiket ekle" title="Etiket ekle" onClick={() => setAddingTag((v) => !v)}>
              +
            </button>
          </div>
          {addingTag && (
            <div className="tagedit">
              <input
                autoFocus
                placeholder="etiket"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && tagInput.trim()) {
                    onTags([...new Set([...chat.tags, tagInput.trim().toLowerCase()])]);
                    setTagInput('');
                    setAddingTag(false);
                  }
                }}
              />
              {DEFAULT_TAGS.filter((t) => !chat.tags.includes(t)).map((t) => (
                <button key={t} className="tag-suggest b" onClick={() => onTags([...chat.tags, t])} title={`${t} etiketini ekle`}>
                  + {t}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="ctx-sec">
          <span className="label">Kanallar</span>
          <div className="chanlist">
            <div className="idrow">
              <Chip platform={chat.platform} size={18} />
              <span>{platform.name}</span>
              <span className="m">{chat.lastMessageAt ? fmtTime(chat.lastMessageAt) : ''}</span>
            </div>
          </div>
        </div>



        {chat.kind === 'group' && (chat.participants?.length ?? 0) > 0 && (
          <div className="ctx-sec">
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
          <div className="ctx-sec">
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
          <div className="ctx-sec">
            <span className="label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              Paylaşılanlar
              <span style={{ color: 'var(--text3)', fontWeight: 400 }}>{allShared.length}</span>
              {allShared.length > 4 && (
                <button className="btn ghost xs icon b" style={{ marginLeft: 'auto' }} onClick={() => setMediaOpen(true)} title={`Tümünü büyük göster (${allShared.length})`} aria-label="Tüm paylaşılanlar">
                  <Icon name="maximize" size={13} sw={2} />
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
                  <span className="ic" style={att.kind === 'image' || att.kind === 'video' ? { background: 'var(--v-soft)', color: 'var(--v-txt)' } : { background: 'var(--danger-bg)', color: '#c2261a' }}>
                    {att.url ? (
                      <img src={abs(att.url)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} />
                    ) : att.kind === 'image' ? (
                      <Icon name="image" size={15} color="var(--v-txt)" />
                    ) : att.kind === 'video' ? (
                      <Icon name="play" size={15} color="var(--v-txt)" />
                    ) : att.mime?.includes('pdf') ? (
                      'PDF'
                    ) : (
                      <Icon name="file" size={15} color="var(--danger-txt)" />
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
      {calFor && <EventEditor initial={{ chatId: chat.id, ...calFor }} notify={notify} onClose={() => setCalFor(null)} />}
      {mediaP.value && (
        <div className={`overlay ${mediaP.closing ? 'closing' : ''}`} onClick={() => setMediaOpen(false)}>
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
      {lightboxP.value && <Lightbox list={lightboxP.value.list} index={lightboxP.value.index} start={lightboxP.value.start} origin={lightboxP.value.origin} onIndex={(index) => setLightboxState((v) => (v ? { ...v, index } : v))} closing={lightboxP.closing} onClose={() => setLightboxState(null)} />}
    </OpenLinkCtx.Provider>
  );
}

interface OrderMeta {
  id: string;
  status: string;
  /** Pazaryeri bağlayıcılarının Türkçe durum etiketi (Trendyol/Hepsiburada/Amazon) */
  statusLabel?: string;
  paymentStatus?: string;
  dateCreated?: string;
  currency: string;
  totals?: { subtotal?: string; shipping?: string; discount?: string; total?: string };
  note?: string;
  items: Array<{ title: string; quantity: number; total: string; type?: string; selection?: string[] }>;
  shipping?: { name: string; phone?: string; email?: string; address?: string };
  fulfillments?: Array<{ status: string; company?: string; trackingNumber?: string; trackingUrl?: string; date?: string }>;
  refunds?: Array<{ type: string; status: string; total: string; date?: string }>;
}
const CARRIERS: Array<[string, string]> = [
  ['yurtici', 'Yurtiçi'], ['aras', 'Aras'], ['mng', 'MNG'], ['ptt', 'PTT'], ['surat', 'Sürat'], ['hepsijet', 'HepsiJET'], ['ups', 'UPS'], ['dhl', 'DHL'], ['fedex', 'FedEx'], ['tnt', 'TNT'], ['pts', 'PTS'], ['aramex', 'Aramex'], ['interGlobal', 'InterGlobal'], ['other', 'Diğer'],
];

/** Takip zamanı: "yarın 14:30", "3 gün sonra (Pzt 09:00)" */
function fmtFollow(at: number): string {
  const d = new Date(at);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  const hm = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  if (days <= 0) return `Bugün ${hm}'e kadar`;
  if (days === 1) return `Yarın ${hm}'e kadar`;
  return `${d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'short' })} ${hm}'e kadar`;
}

/** "2026-10-02T14:30" → "2 Ekim Cum 14:30" */
function fmtEventWhen(start: string): string {
  const [d, t] = start.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const s = new Date(y, m - 1, day).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'short' });
  return t ? `${s} ${t}` : `${s} · tüm gün`;
}

function OrderPanel({ chat, notify }: { chat: Chat; notify: (t: string, err?: boolean) => void }) {
  const o = chat.meta!.order as OrderMeta;
  const [company, setCompany] = useState('yurtici');
  const [tracking, setTracking] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Kargoya verip kapatma yalnız Shopier'de (resmi API); pazaryerlerinde kart salt okunur
  const canFulfill = chat.platform === 'shopier';
  const CLOSED = /^(fulfilled|delivered|shipped|cancelled|canceled|returned)$/i;
  const open = !CLOSED.test(o.status);
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
        <span className={`order-status ${open ? 'open' : 'done'}`}><IconText text={o.statusLabel ?? (open ? 'Açık sipariş' : 'Kapatıldı')} size={12} /></span>
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
        {o.shipping?.name ? <Row k="Alıcı" v={o.shipping.name} /> : null}
        {o.shipping?.phone ? <Row k="Telefon" v={o.shipping.phone} href={`tel:${o.shipping.phone}`} /> : null}
        {o.shipping?.email ? <Row k="E-posta" v={o.shipping.email} href={`mailto:${o.shipping.email}`} /> : null}
        {o.shipping?.address ? <Row k="Adres" v={o.shipping.address} /> : null}
        {o.note ? <Row k="Not" v={o.note} /> : null}
        {(o.fulfillments ?? []).map((f, i) => (
          <Row key={i} k={f.status === 'shipped' ? 'Kargo' : 'Gönderi'} v={`${f.company ?? ''}${f.trackingNumber ? ' · ' + f.trackingNumber : ''}`.trim() || (f.status === 'shipped' ? 'gönderildi' : 'hazırlanıyor')} href={f.trackingUrl} />
        ))}
        {(o.refunds ?? []).map((r, i) => (
          <Row key={'r' + i} k="İade" v={`${r.type === 'full' ? 'tam' : 'kısmi'} ${fmt(r.total)} · ${r.status === 'succeeded' ? 'tamamlandı' : r.status === 'failed' ? 'başarısız' : 'bekliyor'}`} />
        ))}
      </div>
      {open && canFulfill && (
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
/**
 * Sipariş sayfası (Trendyol/Hepsiburada/n11/Shopier): bu pazaryerlerinin API'sinde sipariş üzerinden alıcıya mesaj ucu yok,
 * bu yüzden sohbet ve yazma alanı yerine sipariş özeti + durum zaman çizelgesi. Müşteri yazışması "Sorular"da.
 */
function OrderPage({ chat, messages, relatedQuestion, onOpenChat }: { chat: Chat; messages: Message[]; relatedQuestion?: Chat | null; onOpenChat?: (c: Chat) => void }) {
  const o = chat.meta!.order as OrderMeta;
  const cur = o.currency === 'TRY' ? '₺' : o.currency;
  const fmt = (v?: string) => (v ? `${String(v).replace('.', ',')} ${cur}` : '—');
  const when = (t: number) => new Date(t).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
  const open = !/^(fulfilled|delivered|shipped|cancelled|canceled|returned|completed|closed)$/i.test(o.status);
  // zaman çizelgesi: bağlayıcının yazdığı olay satırları (yeni sipariş, durum değişiklikleri, yerel notlar), eskiden yeniye
  const events = [...messages].sort((a, b) => a.ts - b.ts);
  return (
    <div className="msgs order-page">
      <div className="op-card">
        <div className="op-head">
          <div>
            <span className="op-no"><Icon name="box" size={20} color="var(--v)" /> Sipariş #{o.id}</span>
            <span className="op-date">{o.dateCreated ? when(Date.parse(o.dateCreated)) : ''}</span>
          </div>
          <span className={`order-status ${open ? 'open' : 'done'}`}><IconText text={String(o.statusLabel ?? o.status ?? '')} size={12} /></span>
        </div>
        <div className="op-items">
          {o.items.map((it, i) => (
            <div key={i} className="op-item">
              <span className="q">{it.quantity}×</span>
              <span className="t">
                {it.title}
                {it.selection?.length ? <span className="sel"> · {it.selection.join(' / ')}</span> : null}
              </span>
              <span className="p">{fmt(it.total)}</span>
            </div>
          ))}
          <div className="op-item total">
            <span className="t">Toplam</span>
            <span className="p">{fmt(o.totals?.total)}</span>
          </div>
        </div>
        {(o.shipping?.name || o.shipping?.address) && (
          <div className="op-ship">
            <Icon name="send" size={13} sw={2} /> {[o.shipping?.name, o.shipping?.address].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>

      <div className="op-card">
        <span className="op-h">Durum geçmişi</span>
        <ol className="op-tl">
          {events.map((m) => (
            <li key={m.id} className={m.text.startsWith('📝') ? 'note' : ''}>
              <span className="dot" />
              <span className="tx">
                <IconText text={m.text} size={15} />
              </span>
              <span className="tm">{when(m.ts)}</span>
            </li>
          ))}
          {events.length === 0 && <li className="empty-tl">Henüz durum değişikliği yok.</li>}
        </ol>
      </div>

      <div className="op-card op-msg">
        {relatedQuestion ? (
          <>
            <span className="op-q">
              <Icon name="help" size={16} color="var(--warn-head)" /> Bu siparişle ilgili bir müşteri sorusu var.
            </span>
            <button className="btn primary sm b b2" onClick={() => onOpenChat?.(relatedQuestion)}>
              Soruyu aç
            </button>
          </>
        ) : (
          <span>
            {PLATFORMS[chat.platform].name}, sipariş üzerinden müşteriye mesaj göndermeye izin vermiyor. Müşteri bir soru sorarsa <b>Sorular</b> sekmesinde görünür ve oradan yanıtlarsın.
          </span>
        )}
      </div>
    </div>
  );
}

/** Pazaryeri müşteri sorusu kartı: ürün, durum, konu, bağlı sipariş. Alan adları pazaryerine göre değişir (Trendyol/Hepsiburada/n11). */
function QuestionPanel({ chat }: { chat: Chat }) {
  const q = chat.meta!.question as {
    status?: string; statusLabel?: string; subject?: string; productName?: string; product?: { name?: string; imageUrl?: string; sku?: string };
    imageUrl?: string; webUrl?: string; orderNumber?: string; dateCreated?: string; expireDate?: string; public?: boolean; reportReason?: string;
  };
  const waiting = /wait|bekl/i.test(`${q.status ?? ''} ${q.statusLabel ?? ''}`);
  const product = q.productName ?? q.product?.name;
  const img = q.imageUrl ?? q.product?.imageUrl;
  const when = (v?: string) => (v ? new Date(v).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  return (
    <div className="order question">
      <div className="order-head">
        <span className={`order-status ${waiting ? 'open' : 'done'}`}>{q.statusLabel ?? (waiting ? 'Cevap bekliyor' : 'Cevaplandı')}</span>
        <span className="q-kind">
          <Icon name="help" size={13} /> Müşteri sorusu
        </span>
      </div>
      {product && (
        <div className="q-product">
          {img && <img src={img} alt="" />}
          {q.webUrl ? (
            <a href={q.webUrl} target="_blank" rel="noreferrer">
              {product}
            </a>
          ) : (
            <span>{product}</span>
          )}
        </div>
      )}
      <div className="order-rows">
        {q.subject ? <Row k="Konu" v={q.subject} /> : null}
        {q.orderNumber ? <Row k="Sipariş" v={`#${q.orderNumber}`} /> : null}
        {q.dateCreated ? <Row k="Soruldu" v={when(q.dateCreated)} /> : null}
        {waiting && q.expireDate ? <Row k="Son gün" v={when(q.expireDate)} /> : null}
        {q.public !== undefined ? <Row k="Görünür" v={q.public ? 'Ürün sayfasında herkese açık' : 'Yalnız müşteriye'} /> : null}
        {q.reportReason ? <Row k="Rapor" v={q.reportReason} /> : null}
      </div>
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

function profileRole(chat: Chat): { text: string; href?: string } | undefined {
  const p = chat.platform;
  const other = chat.kind === 'direct' ? chat.participants?.find((x) => x.id !== 'me') : undefined;
  if (p === 'whatsapp' && chat.kind === 'direct') {
    const num = chat.handle ?? (chat.remoteId.endsWith('@s.whatsapp.net') ? '+' + chat.remoteId.split('@')[0] : undefined);
    if (num) return { text: num, href: `https://wa.me/${num.replace(/\D/g, '')}` };
  } else if (p === 'instagram' || p === 'x' || p === 'linkedin' || p === 'slack') {
    const value = chat.handle || other?.handle;
    if (value) return { text: value, href: chat.link };
  } else if (p === 'telegram' && chat.handle) {
    return { text: chat.handle, href: chat.handle.startsWith('@') ? `https://t.me/${chat.handle.slice(1)}` : undefined };
  } else if (p === 'imessage') {
    return { text: chat.remoteId };
  } else if (PLATFORMS[p].mode === 'mail' && chat.handle) {
    return { text: chat.handle, href: `mailto:${chat.handle}` };
  }
  if (chat.kind === 'group' && chat.participants?.length) return { text: `${chat.participants.length} üye` };
  if (chat.handle && chat.handle !== chat.name) return { text: chat.handle };
  return undefined;
}


/** İyimser gönderimin parametreleri (Yeniden dene aynısını yollar) */
type OutSend = { chatId: string; body: string; threadId?: string; replyTo?: string; typed: string; reaction: boolean };

/** Açık medya penceresi: gezinilen liste + (satır içi oynatıcıdan gelindiyse) videonun kaldığı saniye */
type LightboxState = { list: Attachment[]; index: number; start?: { att: Attachment; t: number }; origin?: HTMLElement };

/**
 * Mesajdaki bağlantıların uygulama içinde açılması: sohbet bileşeni sağlar (Lightbox), bağlam yoksa (başka yerde kullanılan
 * linkify) sistem tarayıcısı. Bağlantılar yeni sekme/pencere açmaz; dışarı yalnız pencerede "Tarayıcıda aç" ile çıkılır.
 */
const OpenLinkCtx = createContext<((href: string) => void) | null>(null);

function MsgLink({ href }: { href: string }) {
  const open = useContext(OpenLinkCtx);
  return (
    <a href={href} className="msg-link" onClick={(e) => (e.preventDefault(), open ? open(href) : void openExternal(href))}>
      {href}
    </a>
  );
}

/** Adres → pencerede açılacak ek: doğrudan medya dosyasıysa türüne göre, değilse sayfa */
function linkAttachment(href: string): Attachment {
  const name = href.replace(/^https?:\/\/(www\.)?/i, '').replace(/[?#].*$/, '').split('/').filter(Boolean).pop() ?? href;
  if (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(href)) return { kind: 'video', link: href, name };
  if (/\.(jpe?g|png|gif|webp)(\?|#|$)/i.test(href)) return { kind: 'image', link: href, name };
  if (/\.(mp3|m4a|ogg|opus|wav)(\?|#|$)/i.test(href)) return { kind: 'audio', link: href, name };
  if (/\.pdf(\?|#|$)/i.test(href)) return { kind: 'file', link: href, name, mime: 'application/pdf' };
  return { kind: 'other', page: href, name: href };
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
}

/** Dış bağlantı: masaüstünde (Tauri) sistem tarayıcısında — WKWebView `target=_blank`'i açmıyor —, web'de yeni sekmede */
function openOutside(url: string) {
  void openExternal(url);
}

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };
type FsVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitDisplayingFullscreen?: boolean; webkitExitFullscreen?: () => void };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function fsElement(): Element | null {
  const d = document as FsDoc;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}
function exitFs() {
  const d = document as FsDoc;
  if (d.fullscreenElement && d.exitFullscreen) void d.exitFullscreen().catch(() => undefined);
  else d.webkitExitFullscreen?.();
}
/**
 * Gerçek tam ekran: standart API → webkit önekli (eski macOS WKWebView/Safari) → yalnız videoya özgü webkitEnterFullscreen
 * (iOS). Hiçbiri tutmazsa false: çağıran uygulama içi tam pencereye düşer (Tauri'de öğe tam ekranı kapalı olabilir).
 */
async function enterFs(el: HTMLElement, video?: HTMLVideoElement | null): Promise<boolean> {
  const e = el as FsEl;
  if (typeof e.requestFullscreen === 'function') {
    try {
      const ok = await Promise.race([e.requestFullscreen().then(() => true), sleep(1500).then(() => false)]);
      if (ok || fsElement()) return true;
    } catch {
      /* önekli yolu dene */
    }
  }
  if (typeof e.webkitRequestFullscreen === 'function') {
    try {
      e.webkitRequestFullscreen();
      await sleep(350);
      if (fsElement()) return true;
    } catch {
      /* videoya özgü yolu dene */
    }
  }
  const v = video as FsVideo | null | undefined;
  if (v && typeof v.webkitEnterFullscreen === 'function') {
    try {
      v.webkitEnterFullscreen();
      await sleep(350);
      if (v.webkitDisplayingFullscreen) return true;
    } catch {
      /* yok */
    }
  }
  return false;
}
/** Öğe şu an gerçek tam ekranda mı (değişimleri izler) */
function useIsFullscreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const sync = () => setOn(!!ref.current && fsElement() === ref.current);
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, [ref]);
  return on;
}

/** İndirme: web'de dosya indirilir; masaüstünde (WKWebView `download` özniteliğini yok sayar) sistem tarayıcısı indirir */
function DownloadLink({ href, name, className, children, title }: { href: string; name?: string; className?: string; children: React.ReactNode; title?: string }) {
  return (
    <a href={href} className={className} download={name ?? true} title={title} aria-label={title} target="_blank" rel="noreferrer" onClick={isTauri ? (e) => (e.preventDefault(), openOutside(href)) : undefined}>
      {children}
    </a>
  );
}

/**
 * Medya penceresi (uygulama içi): görsel/video/ses/PDF doğrudan, Instagram/X/YouTube/TikTok/Vimeo gönderileri gömülü oynatıcıyla,
 * gömülemeyen sayfalar önizleme kartıyla. Hiçbir tıklama yeni sekme açmaz; dışarı yalnız "Tarayıcıda aç" ile çıkılır.
 * Tam ekran: gerçek tam ekran API'si, olmazsa pencere uygulama içinde tüm ekranı kaplar.
 */
function Lightbox({ list, index, start, origin, onIndex, onClose, closing }: { list: Attachment[]; index: number; start?: LightboxState['start']; origin?: HTMLElement; onIndex: (i: number) => void; onClose: () => void; closing?: boolean }) {
  const att = list[Math.min(Math.max(0, index), list.length - 1)];
  const many = list.length > 1;
  const boxRef = useRef<HTMLDivElement>(null);
  /** Uygulama içi tam pencere (gerçek tam ekran açılamayınca) */
  const [full, setFull] = useState(false);
  const boxFs = useIsFullscreen(boxRef);
  const go = useCallback((d: number) => many && onIndex((index + d + list.length) % list.length), [many, index, list.length, onIndex]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        e.preventDefault(); // arkadaki sohbet kapanmasın
        if (fsElement()) return; // tarayıcı tam ekrandan kendisi çıkar
        if (full) setFull(false);
        else onClose();
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && many) {
        // oynatılan videonun ileri/geri sarması yerine medya değişir; sohbet listesinin ok gezintisi de çalışmasın
        e.preventDefault();
        e.stopPropagation();
        go(e.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, go, many, full]);
  // pencere kapanırken tam ekranda kalınmasın
  useEffect(() => () => void (fsElement() && exitFs()), []);
  const link = att.link ? abs(att.link) : undefined;
  const page = att.page ?? (att.link && !isMediaFile(att.link) ? att.link : undefined);
  const embed = page ? embedUrl(page) : undefined;
  const isFile = isMediaFile(att.link);
  const isVideo = att.kind === 'video' && isFile && !!link;
  const isPdf = !!link && isFile && (/\.pdf(\?|#|$)/i.test(att.link ?? '') || !!att.mime?.includes('pdf'));
  // sayfaya bağlı video/gönderi küçük resmi tek başına gösterilmez (oynamayan poster): önizleme kartı
  const isImg = !isVideo && !(att.kind === 'audio' && link) && !embed && !(page && att.kind !== 'image') && !!(att.url || (att.kind === 'image' && link && isFile));
  const toggleBoxFs = async () => {
    if (boxFs) return exitFs();
    if (full) return setFull(false);
    if (!boxRef.current || !(await enterFs(boxRef.current))) setFull(true);
  };
  const expanded = full || boxFs;
  // Paylaşılan öğe geçişi (FLIP): görsel, tıklanan küçük resmin yerinden tam boya büyür; kapanınca (aynı görseldeyse) oraya döner
  const firstAtt = useRef(att).current;
  const [flip] = useState(() => !!origin && isImg && !reducedMotion());
  const flipTo = (box: HTMLElement): Keyframe | null => {
    const img = box.querySelector('img');
    if (!origin?.isConnected || !img) return null;
    const r = origin.getBoundingClientRect();
    const bi = img.getBoundingClientRect();
    const bb = box.getBoundingClientRect();
    // küçük resim görünür alanda değilse geri dönüş anlamsız
    if (!r.width || !bi.width || r.bottom < 0 || r.top > window.innerHeight) return null;
    const s = Math.max(r.width / bi.width, r.height / bi.height);
    const tx = r.left + r.width / 2 - bb.left - (bi.left + bi.width / 2 - bb.left) * s;
    const ty = r.top + r.height / 2 - bb.top - (bi.top + bi.height / 2 - bb.top) * s;
    return { transform: `translate(${tx}px, ${ty}px) scale(${s})`, transformOrigin: '0 0', borderRadius: `${12 / s}px` };
  };
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!flip || !box) return;
    const img = box.querySelector('img');
    const chrome = box.querySelectorAll<HTMLElement>('.bar, .close');
    box.style.opacity = '0';
    let alive = true;
    let played = false;
    const runs: Array<Animation | null> = [];
    const play = () => {
      if (!alive || played) return;
      played = true;
      box.style.opacity = '';
      const from = flipTo(box);
      if (!from) return void animate(box, [{ opacity: 0, transform: 'translateY(10px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE.std });
      origin!.style.visibility = 'hidden';
      const a = animate(box, [from, { transform: 'none', transformOrigin: '0 0', borderRadius: '28px' }], { duration: 380, easing: EASE.in });
      runs.push(a);
      for (const c of chrome) runs.push(animate(c, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 220, easing: EASE.std, fill: 'backwards' }));
      const show = () => void (origin!.style.visibility = '');
      void (a?.finished ?? Promise.resolve()).then(show, show);
    };
    // görsel yüklenmeden boyu bilinmez: en çok 300 ms beklenir, olmazsa sade açılış
    if (!img || img.complete) play();
    else {
      img.addEventListener('load', play, { once: true });
      img.addEventListener('error', play, { once: true });
      window.setTimeout(play, 300);
    }
    return () => {
      // (StrictMode'da etki iki kez çalışır: ilk turun animasyonu ölçümü bozmasın)
      alive = false;
      for (const a of runs) a?.cancel();
      box.style.opacity = '';
      if (origin) origin.style.visibility = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const box = boxRef.current;
    if (!flip || !closing || !box) return;
    const to = att === firstAtt && !full && !boxFs ? flipTo(box) : null;
    if (!to) return void animate(box, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.98)' }], { duration: 150, easing: EASE.out, fill: 'forwards' });
    origin!.style.visibility = 'hidden';
    for (const c of box.querySelectorAll('.bar, .close')) animate(c, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: EASE.out, fill: 'forwards' });
    animate(box, [{ transform: 'none', transformOrigin: '0 0', borderRadius: '28px' }, to], { duration: 280, easing: EASE.std, fill: 'forwards' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);
  return (
    <div className={`lightbox ${closing ? 'closing' : ''} ${full ? 'full' : ''} ${flip ? 'lb-flip' : ''}`} onClick={onClose} role="dialog" aria-label={att.name ?? 'Medya'}>
      <div className={`box ${embed || page ? 'page' : ''}`} ref={boxRef} onClick={(e) => e.stopPropagation()}>
        {isVideo ? (
          <VideoPlayer key={link} src={link!} poster={abs(att.url)} autoPlay big startAt={start && start.att === att ? start.t : undefined} expanded={full} onFallback={() => setFull((v) => !v)} />
        ) : att.kind === 'audio' && link ? (
          <div className="lb-audio">
            <Icon name="mic" size={28} color="#fff" />
            <audio src={link} controls autoPlay />
          </div>
        ) : embed ? (
          <iframe key={embed} src={embed} title={att.name ?? 'Gönderi'} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
        ) : isPdf ? (
          <iframe key={link} className="lb-doc" src={link} title={att.name ?? 'Belge'} />
        ) : isImg ? (
          <img src={att.kind === 'image' && link && (isImageFile(att.link) || !att.url) ? link : abs(att.url)} alt={att.name ?? ''} referrerPolicy="no-referrer" />
        ) : page ? (
          <PageCard page={page} att={att} />
        ) : link ? (
          <div className="lb-file">
            <Icon name="file" size={34} color="#fff" />
            <b>{att.name ?? attLabel(att.kind)}</b>
            <span>{att.size ? `${fmtSize(att.size)} · ` : ''}Önizleme yok — dosyayı aşağıdan indirebilirsin.</span>
          </div>
        ) : null}
        <div className="bar">
          {many && <span className="lb-count">{index + 1} / {list.length}</span>}
          <span className="lb-name">{att.name ?? attLabel(att.kind)}</span>
          {page && (
            <button type="button" className="lb-act" onClick={() => openOutside(page)}>
              <Icon name="external" size={13} /> Tarayıcıda aç
            </button>
          )}
          {link && isFile && (
            <DownloadLink href={link} name={att.name} className="lb-act">
              <Icon name="download" size={13} /> İndir
            </DownloadLink>
          )}
          {!isVideo && (isImg || embed || isPdf) && (
            <button type="button" className="lb-act icon" onClick={() => void toggleBoxFs()} aria-label={expanded ? 'Tam ekrandan çık' : 'Tam ekran'} title={expanded ? 'Tam ekrandan çık' : 'Tam ekran'}>
              <Icon name={expanded ? 'minimize' : 'maximize'} size={14} sw={2} />
            </button>
          )}
        </div>
        <button className="close b" onClick={onClose} aria-label="Kapat">
          <Icon name="x" size={14} sw={2} />
        </button>
      </div>
      {many && (
        <>
          <button type="button" className="lb-nav prev b" onClick={(e) => (e.stopPropagation(), go(-1))} aria-label="Önceki medya" title="Önceki (←)">
            <Icon name="back" size={20} sw={2.2} />
          </button>
          <button type="button" className="lb-nav next b" onClick={(e) => (e.stopPropagation(), go(1))} aria-label="Sonraki medya" title="Sonraki (→)">
            <Icon name="back" size={20} sw={2.2} />
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Gömülemeyen sayfa (çoğu site X-Frame-Options ile iframe'i reddeder): Open Graph önizlemesi (görsel, site, başlık, açıklama)
 * ve "Tarayıcıda aç". Önizleme gelmezse ekin küçük resmi / adresi.
 */
function PageCard({ page, att }: { page: string; att: Attachment }) {
  const p = usePreview(page);
  const ok = !!p && !p.none;
  const img = (ok && p.image) || abs(att.url);
  const title = (ok && p.title) || (att.name && att.name !== page ? att.name : undefined) || hostOf(page);
  return (
    <div className="lb-page">
      {img ? (
        <img src={img} alt="" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} />
      ) : (
        <span className="lb-page-ic">
          <Icon name={att.kind === 'video' ? 'play' : att.kind === 'image' ? 'image' : 'link'} size={34} color="#fff" />
        </span>
      )}
      <div className="lb-page-body">
        <span className="lb-page-site">{(ok && p.site) || hostOf(page)}</span>
        <b>{title}</b>
        {ok && p.description ? <span className="lb-page-desc">{p.description}</span> : null}
        {!p ? <span className="lb-page-note">Önizleme yükleniyor…</span> : <span className="lb-page-note">Bu sayfa uygulama içinde gösterilemiyor; aşağıdaki "Tarayıcıda aç" ile açabilirsin.</span>}
      </div>
    </div>
  );
}

/** iframe'de açılabilen gömülü sürümler: Instagram, X, YouTube, TikTok, Vimeo gönderileri */
function embedUrl(link: string): string | undefined {
  let m = link.match(/^https?:\/\/(?:www\.)?instagram\.com\/(?:[^/?#]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if (m) return `https://www.instagram.com/${m[1] === 'p' ? 'p' : 'reel'}/${m[2]}/embed/`;
  m = link.match(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/]+\/status(?:es)?\/(\d+)/);
  if (m) return `https://platform.twitter.com/embed/Tweet.html?dnt=true&embedId=twitter-widget-0&frame=false&hideCard=false&hideThread=false&id=${m[1]}&lang=tr&theme=light&widgetsVersion=2615f7e52b7e0%3A1702314776716`;
  m = link.match(/^https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{6,})/) ?? link.match(/^https?:\/\/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  if (m) return `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1&rel=0`;
  m = link.match(/^https?:\/\/(?:www\.|m\.)?tiktok\.com\/(?:@[^/]*\/(?:video|photo)|share\/video|video|v|embed(?:\/v2)?)\/(\d+)/);
  if (m) return `https://www.tiktok.com/embed/v2/${m[1]}`;
  m = link.match(/^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)/);
  if (m) return `https://player.vimeo.com/video/${m[1]}?autoplay=1`;
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

/** Platformların metin olarak verdiği tepki/beğeni olayları */
export const REACT_TEXT = /^(👍|❤️|❤|😂|🔥|👏|😮|🎉|🙏) .+ (bir mesajı beğendi|mesajına tepki verdi)$/;

/** Grup sohbetinde gönderen adı renkleri: styles.css --sc0…--sc9 (gece modunda koyu zeminde okunur tonlar) */
const SENDER_COLORS = Array.from({ length: 10 }, (_, i) => `var(--sc${i})`);
/** Grup sohbetinde her gönderene sabit bir renk (kimlikten türetilir; oturumlar arasında aynı kalır) */
export function senderColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return SENDER_COLORS[h % SENDER_COLORS.length];
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
function firstUrl(text: string): string | undefined {
  const m = text.match(URL_RE);
  return m?.[0].replace(/[.,;:!?]+$/, '');
}
/** Metindeki http(s) adreslerini tıklanabilir yap */
function linkify(text: string): React.ReactNode {
  if (!/https?:\/\//i.test(text)) return text;
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0];
    const trail = raw.match(/[.,;:!?]+$/)?.[0] ?? '';
    const href = raw.slice(0, raw.length - trail.length);
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(
      <MsgLink key={m.index} href={href} />,
    );
    if (trail) out.push(trail);
    last = m.index! + raw.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Kendi mesajımın tiki (her balonda): görüldü = yeşil çift tik, iletildi (karşıda görüldü bilgisi kapalı ya da henüz açılmadı) = çift tik,
 *  gönderildi (sunucuda; WhatsApp'ta alıcı çevrimdışı) = tek tik, gönderiliyor = saat, gönderilemedi = kırmızı uyarı */
/** Süre sınırı (ms) içinde mi; sınır yoksa her zaman */
function within(ts: number, limit?: number): boolean {
  return limit == null || Date.now() - ts < limit;
}

/** Birleşik zaman çizelgesi: balonun saatinin yanında mesajın geldiği kanalın küçük logosu */
function TlMark({ p }: { p?: Platform }) {
  return p ? (
    <span className="tl-mark" title={PLATFORMS[p]?.name}>
      <Chip platform={p} size={14} />
    </span>
  ) : null;
}

export function statusIcon(s: Message['status']) {
  if (s === 'read') return <span className="tick read" title="Görüldü"><Icon name="checks" size={14} sw={2.2} /></span>;
  if (s === 'delivered') return <span className="tick" title="İletildi"><Icon name="checks" size={14} sw={2.2} /></span>;
  if (s === 'sent') return <span className="tick" title="Gönderildi"><Icon name="check" size={13} sw={2.2} /></span>;
  if (s === 'pending') return <span className="tick" title="Gönderiliyor"><Icon name="clock" size={11} sw={2.2} /></span>;
  if (s === 'failed') return <span className="tick failed" title="Gönderilemedi"><Icon name="alert" size={12} sw={2.2} /></span>;
  return null;
}

/** Takip şeridi metni */
function followText(name: string, f: NonNullable<Chat['followUp']>): string {
  return f.due ? `${name} yanıt vermedi. Nazik bir hatırlatma gönderebilirsin.` : `${fmtFollow(f.at)} yanıt gelmezse hatırlatılacak. ${name} yazınca kendiliğinden kapanır.`;
}

/** Zil sallanması (takip hatırlatıcısı açılınca) */
function shakeBell(el: Element | null | undefined) {
  const o = '50% 15%';
  animate(el, [{ transform: 'rotate(0)', transformOrigin: o }, { transform: 'rotate(16deg)', transformOrigin: o, offset: 0.15 }, { transform: 'rotate(-13deg)', transformOrigin: o, offset: 0.35 }, { transform: 'rotate(8deg)', transformOrigin: o, offset: 0.55 }, { transform: 'rotate(-4deg)', transformOrigin: o, offset: 0.75 }, { transform: 'rotate(0)', transformOrigin: o }], { duration: 620, easing: 'ease-out' });
}

/** Tepki uçuşu: emoji çubuktaki yerinden kavis çizerek çipe uçar (body'de sabit konumlu kopya), çip zıplayarak yerleşir, balon hafifçe esner */
function flyToChip(from: DOMRect, emoji: string, chip: HTMLElement, bub: HTMLElement | null) {
  const pop = () => {
    animate(chip, [{ transform: 'scale(.4)' }, { transform: 'none' }], { duration: 280, easing: EASE.pop });
    animate(bub, [{ transform: 'none' }, { transform: 'scale(1.02)', offset: 0.4 }, { transform: 'none' }], { duration: 220, easing: EASE.std });
  };
  const to = (chip.querySelector('.e') ?? chip).getBoundingClientRect();
  if (reducedMotion() || !from.width || !to.width) return pop();
  const n = document.createElement('span');
  n.className = 'm-fly';
  n.textContent = emoji;
  n.setAttribute('aria-hidden', 'true');
  document.body.appendChild(n);
  const w = n.offsetWidth;
  const h = n.offsetHeight;
  const x0 = from.left + from.width / 2 - w / 2;
  const y0 = from.top + from.height / 2 - h / 2;
  const x1 = to.left + to.width / 2 - w / 2;
  const y1 = to.top + to.height / 2 - h / 2;
  const end = Math.max(0.4, Math.min(1, to.height / h));
  chip.style.visibility = 'hidden';
  const a = n.animate(
    [
      { transform: `translate(${x0}px, ${y0}px) scale(1)` },
      { transform: `translate(${(x0 + x1) / 2}px, ${Math.min(y0, y1) - 20}px) scale(1.08)`, offset: 0.5 },
      { transform: `translate(${x1}px, ${y1}px) scale(${end})` },
    ],
    { duration: 380, easing: EASE.std },
  );
  const done = () => {
    n.remove();
    chip.style.visibility = '';
    pop();
  };
  a.finished.then(done, done);
}

/** Metin sunumlu semboller (❤ ♥ ☺ …) renkli emoji olarak çizilsin: varyasyon seçicisi (U+FE0F) eklenir */
export function colorEmoji(e: string): string {
  return e.replace(/([\u2764\u2765\u2763\u2665\u2660\u2663\u2666\u263A\u2639\u261D\u270C\u270B\u270D\u2620\u2714\u2716\u2611\u2600\u2601\u26A0\u2B50\u2705])(?!\uFE0F)/g, '$1\uFE0F');
}

/** Tepki çipleri: emoji başına sayı; benimki vurgulu; başlıkta kimler */
function ReactionChips({ list, onToggle }: { list: Reaction[]; onToggle?: (emoji: string) => void }) {
  const groups = new Map<string, { n: number; mine: boolean; names: string[] }>();
  for (const r of list) {
    const key = colorEmoji(r.emoji);
    const g = groups.get(key) ?? { n: 0, mine: false, names: [] };
    g.n++;
    if (r.fromMe) g.mine = true;
    if (r.senderName) g.names.push(r.fromMe ? 'Sen' : r.senderName);
    groups.set(key, g);
  }
  return (
    <span className="rchips">
      {[...groups].map(([e, g]) => (
        <button key={e} type="button" className={`rchip b ${g.mine ? 'mine' : ''}`} title={g.names.join(', ')} onClick={onToggle ? () => onToggle(e) : undefined} disabled={!onToggle}>
          <span className="e">{e}</span>
          {g.n > 1 ? <span className="n">{g.n}</span> : null}
        </button>
      ))}
    </span>
  );
}

const previewCache = new Map<string, Promise<LinkPreview>>();
/** Bağlantı kartı (Open Graph): site · başlık · açıklama · görsel; önizleme yoksa hiç görünmez */
const X_STATUS = /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\/[^?#]*\/status(es)?\/\d+/i;

/** Önizleme isteği (önbellekli; aynı adres bir kez istenir) */
function usePreview(url: string | undefined): LinkPreview | null {
  const [p, setP] = useState<LinkPreview | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    let req = previewCache.get(url);
    if (!req) {
      req = api.preview(url).catch(() => ({ url, none: true }) as LinkPreview);
      previewCache.set(url, req);
    }
    void req.then((v) => alive && setP(v));
    return () => {
      alive = false;
    };
  }, [url]);
  return p;
}

/**
 * Paylaşılan X gönderisi, yerel önbellekte içeriği yoksa: çekirdek X'in herkese açık gömme verisinden (oturumsuz) yazar,
 * metin ve görseli getirir. Gelmezse (silinmiş/korumalı) sade bir kart; eskiden boş siyah kutu kalıyordu.
 */
function XPostCard({ a, page, onOpen }: { a: Attachment; page: string; onOpen: (a: Attachment) => void }) {
  const p = usePreview(page);
  const ok = p && !p.none && p.title;
  const handle = ok ? p.title!.match(/\((@[^)]+)\)\s*$/)?.[1] : undefined;
  return (
    <button type="button" className={`att-card b xpost${ok && p.image ? '' : ' noimg'}`} onClick={() => onOpen(a.page ? a : { ...a, page })} title="Gönderiyi aç">
      {ok && p.image && <img src={p.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} />}
      <span className="att-cap">
        <Icon name="link" size={13} />
        <span className="xpost-txt">
          {ok ? (
            <>
              <b>{handle ?? p.title}</b>
              {p.description ? `: ${p.description}` : ''}
            </>
          ) : (
            (a.name ?? 'Gönderi')
          )}
        </span>
      </span>
    </button>
  );
}

function LinkCard({ url }: { url: string }) {
  const open = useContext(OpenLinkCtx);
  const [p, setP] = useState<LinkPreview | null>(null);
  useEffect(() => {
    let alive = true;
    let req = previewCache.get(url);
    if (!req) {
      req = api.preview(url).catch(() => ({ url, none: true }) as LinkPreview);
      previewCache.set(url, req);
    }
    void req.then((v) => alive && setP(v));
    return () => {
      alive = false;
    };
  }, [url]);
  if (!p || p.none || !p.title) return null;
  return (
    <a className="linkcard b" href={p.url} onClick={(e) => (e.preventDefault(), open ? open(url) : void openExternal(p.url))} title={p.url}>
      {p.image && <img src={p.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} />}
      <span className="lc-body">
        <span className="lc-site">{p.site}</span>
        <span className="lc-title">{p.title}</span>
        {p.description && <span className="lc-desc">{p.description}</span>}
      </span>
    </a>
  );
}

function statusLabel(s: Message['status']) {
  if (s === 'read')
    return (
      <>
        · Görüldü <Icon name="checks" size={14} color="var(--v)" sw={2} />
      </>
    );
  if (s === 'delivered') return <> · İletildi</>;
  if (s === 'pending') return <> · Gönderiliyor</>;
  if (s === 'failed') return <span style={{ color: 'var(--danger)' }}> · Gönderilemedi</span>;
  return null;
}

/** Çekirdeğin vekil yolları (/api/media/…) Tauri'de mutlak adrese çevrilir */
function abs(u?: string): string | undefined {
  return mediaUrl(u);
}
/** Doğrudan oynatılabilir/indirilebilir dosya mı (vekil yolu ya da bilinen uzantı) — sayfa bağlantısı değil */
/** Galeride gezinilebilen ek: görsel ya da oynatılabilir video (önizlemesi/dosyası olan) */
function isGalleryMedia(a: Attachment): boolean {
  if (a.kind === 'image') return !!(a.url || (a.link && isMediaFile(a.link)));
  if (a.kind === 'video') return !!(a.link && isMediaFile(a.link)) || !!a.url;
  return false;
}

/** Albüme girebilen mesaj: metinsiz, yalnız görsel/video ekli, tepki satırı değil */
function isAlbumMsg(m: Message): boolean {
  return !m.text?.trim() && !!m.attachments?.length && m.attachments.every(isGalleryMedia) && !m.threadId && !m.replyCount;
}

/** Grup içindeki mesajları çizim birimlerine böl: art arda ≥3 albümlük mesaj (aralar ≤3 dk) tek albüm, diğerleri tek tek */
type Unit = { kind: 'msg'; m: Message; i: number } | { kind: 'album'; items: Message[]; i: number };
function toUnits(items: Message[]): Unit[] {
  const out: Unit[] = [];
  for (let i = 0; i < items.length; ) {
    let j = i;
    while (j < items.length && isAlbumMsg(items[j]) && (j === i || items[j].ts - items[j - 1].ts <= 3 * 60_000)) j++;
    if (j - i >= 3) {
      out.push({ kind: 'album', items: items.slice(i, j), i });
      i = j;
    } else {
      out.push({ kind: 'msg', m: items[i], i });
      i++;
    }
  }
  return out;
}

/** WhatsApp tarzı albüm: 2 sütunlu ızgara, en çok 4 kare; fazlası son karede "+N" */
function AlbumView({ items, onOpen }: { items: Message[]; onOpen: (a: Attachment) => void }) {
  const atts = items.flatMap((m) => (m.attachments ?? []).map((a) => ({ a, mid: m.id })));
  const shownAtts = atts.slice(0, 4);
  const more = atts.length - shownAtts.length;
  return (
    <span className={`album n${shownAtts.length}`}>
      {shownAtts.map(({ a, mid }, k) => {
        const src = abs(a.url) ?? (a.kind === 'image' ? abs(a.link) : undefined);
        return (
          <button key={k} type="button" className="al-tile b" data-mid={mid} onClick={() => onOpen(a)} title={a.name ?? 'Büyüt'}>
            {src ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="al-blank" />}
            {a.kind === 'video' && (
              <span className="al-play">
                <Icon name="play" size={18} color="#fff" />
              </span>
            )}
            {k === shownAtts.length - 1 && more > 0 && <span className="al-more">+{more}</span>}
          </button>
        );
      })}
    </span>
  );
}

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
 * Mesaj balonundaki ek (hiçbiri yeni sekme açmaz; tıklayınca uygulama içi medya penceresi):
 * - audio → <audio controls> (link)
 * - video (dosya) → sade oynatıcı (tam ekran düğmesi; olmazsa pencerede büyür)
 * - sayfa bağlantısı (Instagram gönderisi, TikTok videosu vb.) → önizleme görseli; pencerede gömülü oynatıcı ya da önizleme kartı
 * - image → <img> (url), tıklayınca büyük pencere
 * - file/other → pencerede önizleme (PDF) / indirme
 */
function AttachmentView({ a, onOpen }: { a: Attachment; onOpen: (a: Attachment, startAt?: number) => void }) {
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
        <VideoPlayer src={link} poster={url} onFallback={(t) => onOpen(a, t)} />
        <span className="att-cap">
          <Icon name="play" size={13} />
          <span className="att-name">{a.name ?? attLabel(a.kind)}</span>
          <DownloadLink href={link} name={a.name} className="att-dl" title="Videoyu indir">
            <Icon name="download" size={13} />
          </DownloadLink>
        </span>
      </span>
    );
  }
  const page = a.page ?? (isPageLink(a.link) ? a.link : undefined);
  if (page && !url && X_STATUS.test(page)) return <XPostCard a={a} page={page} onOpen={onOpen} />;
  if (page) {
    return (
      <button type="button" className="att-card b" onClick={() => onOpen(a.page ? a : { ...a, page })} title={a.kind === 'video' ? 'Videoyu oynat' : 'Gönderiyi aç'}>
        {url ? (
          <span className="att-thumb">
            <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={hideOnError} />
            {a.kind === 'video' && (
              <span className="al-play">
                <Icon name="play" size={18} color="#fff" />
              </span>
            )}
          </span>
        ) : (
          <span className="att-blank">
            <Icon name={a.kind === 'video' ? 'play' : 'link'} size={28} color="#fff" />
          </span>
        )}
        <span className="att-cap">
          <Icon name={a.kind === 'video' ? 'play' : a.kind === 'image' ? 'image' : 'link'} size={13} />
          <span className="att-name">{a.name ?? attLabel(a.kind)}</span>
        </span>
      </button>
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
    <a className="att" href={link} rel="noreferrer" style={{ textDecoration: 'none' }} title={link ? 'Aç' : undefined} onClick={(e) => (e.preventDefault(), link && onOpen(a))}>
      <Icon name={a.kind === 'image' ? 'image' : a.kind === 'audio' ? 'mic' : a.kind === 'video' ? 'play' : 'file'} size={14} />
      {a.name ?? attLabel(a.kind)}
      {a.size ? <span style={{ opacity: 0.7 }}> · {fmtSize(a.size)}</span> : null}
    </a>
  );
}

/** Saniye → m:ss (kayıt süresi) */
function fmtClock(secs: number) {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Sade video oynatıcı: yerel kontroller yerine ortada oynat/duraklat, altta ince ilerleme çubuğu (tıklayınca sarar),
 * köşede ses ve tam ekran. Tarayıcının dağınık kontrol çubuğu görünmez.
 * Tam ekran önce gerçek API ile (standart → webkit öneki → iOS video); açılamazsa (Tauri WKWebView'da öğe tam ekranı kapalı
 * olabilir; eskiden düğme hiçbir şey yapmıyordu) `onFallback(saniye)`: balonda medya penceresi, pencerede tüm ekranı kaplama.
 */
function VideoPlayer({ src, poster, autoPlay, startAt, big, expanded, onFallback }: { src: string; poster?: string; autoPlay?: boolean; startAt?: number; big?: boolean; expanded?: boolean; onFallback?: (t: number) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  const isFs = useIsFullscreen(box);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [prog, setProg] = useState(0);
  const [dur, setDur] = useState(0);
  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  };
  const toggleFs = async () => {
    const v = ref.current;
    if (isFs) return exitFs();
    if (expanded) return onFallback?.(v?.currentTime ?? 0);
    if (box.current && (await enterFs(box.current, v))) return;
    if (!big) v?.pause(); // pencerede kaldığı yerden sürer
    onFallback?.(v?.currentTime ?? 0);
  };
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const on = isFs || !!expanded;
  return (
    <span ref={box} className={`vp ${playing ? 'playing' : ''} ${big ? 'big' : ''}`}>
      <video
        ref={ref}
        src={src}
        poster={poster}
        preload="metadata"
        playsInline
        autoPlay={autoPlay}
        muted={muted}
        onClick={toggle}
        onDoubleClick={() => void toggleFs()}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) => {
          setDur(e.currentTarget.duration || 0);
          if (startAt && startAt < (e.currentTarget.duration || Infinity)) e.currentTarget.currentTime = startAt;
        }}
        onTimeUpdate={(e) => setProg(e.currentTarget.duration ? e.currentTarget.currentTime / e.currentTarget.duration : 0)}
      />
      {!playing && (
        <button type="button" className="vp-play" onClick={toggle} aria-label="Oynat">
          <Icon name="play" size={26} color="#fff" sw={0} />
        </button>
      )}
      <span className="vp-bar">
        <span className="vp-time">{playing || prog > 0 ? fmt((ref.current?.currentTime ?? 0)) : dur ? fmt(dur) : ''}</span>
        <span
          className="vp-track"
          role="slider"
          aria-label="İlerleme"
          aria-valuenow={Math.round(prog * 100)}
          onClick={(e) => {
            const v = ref.current;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            if (v && v.duration) v.currentTime = ((e.clientX - r.left) / r.width) * v.duration;
          }}
        >
          <span className="vp-fill" style={{ width: `${prog * 100}%` }} />
        </span>
        <button type="button" className="vp-btn" onClick={() => setMuted((m) => !m)} aria-label={muted ? 'Sesi aç' : 'Sesi kapat'} title={muted ? 'Sesi aç' : 'Sesi kapat'}>
          <Icon name={muted ? 'mute' : 'volume'} size={13} sw={2} />
        </button>
        <button type="button" className="vp-btn vp-fs" onClick={() => void toggleFs()} aria-label={on ? 'Tam ekrandan çık' : 'Tam ekran'} title={on ? 'Tam ekrandan çık' : 'Tam ekran'}>
          <Icon name={on ? 'minimize' : 'maximize'} size={13} sw={2} />
        </button>
      </span>
    </span>
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

// ---- Medya kütüphanesi (MediaLibrary.tsx): aynı medya penceresi ve bağlantı → ek dönüşümü ----
export { Lightbox as MediaLightbox, linkAttachment, isMediaFile as isMediaFileUrl };
