import { useEffect, useMemo, useRef, useState } from 'react';
import { EmojiPicker } from './emoji';
import { api } from './api';
import { API_BASE, mediaUrl, openExternal } from './desktop';
import { DEFAULT_TAGS, PLATFORMS, isOrderPage, shopKind, QUICK_REACTIONS, REACT_PLATFORMS, TAG_COLORS, openInAppLink, type Attachment, type CalendarDraft, type Chat, type ChatFlags, type DraftResult, type LinkPreview, type Message, type Reaction } from './types';
import { guessWhen } from './when';
import { useAiPrefs } from './ai-prefs';
import { useClosing, Avatar, Chip, Icon, Resizer, Tag, ago, fmtDay, fmtStamp, fmtTime } from './ui';

type Tone = 'default' | 'short' | 'formal' | 'en';

interface ScheduledSend {
  id: string;
  chatId: string;
  text: string;
  at: number;
}

const SCHED_KEY = 'kavsak.scheduled';
const MISSED_KEY = 'kavsak.scheduled.missed';
let schedTimer = 0;
const schedListeners = new Set<() => void>();

function readScheduled(): ScheduledSend[] {
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

function queueScheduled(item: ScheduledSend): void {
  try {
    localStorage.setItem(SCHED_KEY, JSON.stringify([...readScheduled(), item]));
  } catch {
    /* yok */
  }
  emitScheduled();
  startScheduledSends();
}

function cancelScheduled(id: string): void {
  try {
    localStorage.setItem(SCHED_KEY, JSON.stringify(readScheduled().filter((s) => s.id !== id)));
  } catch {
    /* yok */
  }
  emitScheduled();
  startScheduledSends();
}

function tomorrowAt(hour: number): number {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

export function Conversation({
  chat,
  messages,
  ai,
  notify,
  onTags,
  showDetails = true,
  onToggleDetails,
  onOpenChat,
  onLoadOlder,
  hasOlder = false,
  olderBusy = false,
  onBack,
  typing,
  onFlags,
  seed,
  onSeedUsed,
  relatedQuestion,
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
  onLoadOlder?: () => void | Promise<void>;
  hasOlder?: boolean;
  olderBusy?: boolean;
  /** Dar ekranda listeye dön */
  onBack?: () => void;
  /** Karşı taraf yazıyor: null hayır, '' evet, 'Ad' grupta kim */
  typing?: string | null;
  /** Yerel bayraklar: sabitle/arşivle/sessize al/gizle */
  onFlags?: (f: ChatFlags) => void;
  /** Başka ekrandan (Odak) açılırken kompozöre konacak metin ya da kendiliğinden üretilecek taslak */
  seed?: { text?: string; autoDraft?: boolean } | null;
  onSeedUsed?: () => void;
  /** Sipariş sayfası: aynı siparişe bağlı müşteri sorusu sohbeti (varsa) */
  relatedQuestion?: Chat | null;
}) {
  const [search, setSearch] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (search !== null) searchRef.current?.focus();
  }, [search]);
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const [drafting, setDrafting] = useState(false);
  // Ayarlar → AI: kapalı özellikler gizlenir; taslak kapalıyken üretilen sonuçtan yalnızca özet/aksiyonlar kullanılır
  const aiP = useAiPrefs();
  const draftOn = ai && aiP.drafts;
  const draftShown = draftOn && draft?.draft ? draft : null;
  const [sending, setSending] = useState(false);
  const [tone, setTone] = useState<Tone>('default');
  const [tagInput, setTagInput] = useState('');
  const [addingTag, setAddingTag] = useState(false);
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const lightboxP = useClosing(lightbox);
  useEffect(() => setLightbox(null), [chat.id]);
  const endRef = useRef<HTMLDivElement>(null);
  const msgsRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
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
  useEffect(() => (setThreadFocus(null), setEmojiOpen(false), setReactPick(null), setBarFor(null)), [chat.id]);
  const canReact = REACT_PLATFORMS.has(chat.platform);
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
  const isMail = platform.category === 'mail';
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
    queueScheduled({ id: crypto.randomUUID(), chatId: chat.id, text: body, at });
    setText('');
    setDraft(null);
    setSchedOpen(false);
    notify(`${fmtStamp(at)} tarihinde gönderilecek`);
  }
  async function sendFile(file: File, voice = false) {
    if (file.size > 50 * 1024 * 1024) return notify('Dosya 50 MB\'tan büyük', true);
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

  const shown = useMemo(() => {
    const q = (search ?? '').trim().toLocaleLowerCase('tr-TR');
    // "X bir mesajı beğendi" türü olay metinleri sohbette satır olarak gösterilmez (liste önizlemesinde kalır; tepkiler çip olarak görünür)
    const visible = messages.filter((m) => !REACT_TEXT.test(m.text));
    const base = threadFocus ? visible.filter((m) => m.remoteId === threadFocus || m.threadId === threadFocus) : visible;
    if (!q) return base;
    return base.filter((m) => m.text.toLocaleLowerCase('tr-TR').includes(q) || m.senderName.toLocaleLowerCase('tr-TR').includes(q) || m.attachments?.some((a) => a.name?.toLocaleLowerCase('tr-TR').includes(q)));
  }, [messages, search, threadFocus]);
  const groups = useMemo(() => groupMessages(shown), [shown]);
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

  async function send() {
    if (pending) {
      if (sending || uploading) return;
      const f = pending.file;
      const voice = !!pending.voice;
      clearPending();
      await sendFile(f, voice);
      return;
    }
    const body = (text || draftShown?.draft || '').trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await api.send(chat.id, body, threadFocus ?? undefined);
      setText('');
      setDraft(null);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setSending(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Tab' && draftShown && !text.trim()) {
      e.preventDefault();
      setText(draftShown.draft);
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
                <span className="meta">{isOrderPage(chat) ? 'Sipariş' : shopKind(chat) === 'question' ? 'Müşteri sorusu' : chat.kind === 'group' ? 'Grup' : chat.kind === 'channel' ? 'Kanal' : 'Sohbet'}</span>
              )}
            </span>
          </div>
          <button className={`btn icon b b2 ${search !== null ? 'on' : ''}`} onClick={() => setSearch(search === null ? '' : null)} title="Sohbette ara" aria-label="Ara">
            <Icon name="search" size={15} />
          </button>
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

        {chat.followUp && (
          <div className={`snooze-banner follow ${chat.followUp.due ? 'due' : ''}`}>
            <Icon name="bell" size={15} />
            <span>
              {chat.followUp.due
                ? `${chat.name} yanıt vermedi. Nazik bir hatırlatma gönderebilirsin.`
                : `${fmtFollow(chat.followUp.at)} yanıt gelmezse hatırlatılacak. ${chat.name} yazınca kendiliğinden kapanır.`}
            </span>
            {chat.followUp.due && draftOn && (
              <button type="button" className="btn xs soft b b2" onClick={() => void makeDraft()}>
                <Icon name="sparkle" size={12} color="#6C47FF" sw={2} /> Hatırlatma yaz
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
                {!g.fromMe && <Avatar name={g.senderName} size={28} url={g.items.find((m) => m.senderAvatarUrl)?.senderAvatarUrl ?? avatarOf.get(g.items[0].senderId) ?? (chat.kind === 'direct' ? chat.avatarUrl : undefined)} />}
                <div className="col">
                  {!g.fromMe && chat.kind !== 'direct' && (
                    <span className="sender" style={{ color: senderColor(g.items[0].senderId || g.senderName) }}>
                      {g.senderName}
                    </span>
                  )}
                  {g.items.map((m, i) => {
                    const isReact = /^(👍|❤️|😂|🔥|👏|😮) .+ (bir mesajı beğendi|mesajına tepki verdi)$/.test(m.text);
                    const parent = m.threadId ? byRemote.get(m.threadId) : undefined;
                    const url = !isReact && !m.attachments?.length ? firstUrl(m.text) : undefined;
                    return (
                      <div key={m.id} className={`bwrap ${g.fromMe ? 'me' : ''}`}>
                        {m.threadId && !threadFocus && (
                          <button type="button" className="tq b" onClick={() => setThreadFocus(m.threadId!)} title="İş parçacığını aç">
                            <Icon name="reply" size={12} sw={2} />
                            <span className="tq-h">Bir iş parçacığına yanıt</span>
                            <span className="tq-t">{parent?.text || 'İş parçacığı'}</span>
                          </button>
                        )}
                        <div className={`bub ${g.items.length === 1 ? 'first last' : i === 0 ? 'first' : i === g.items.length - 1 ? 'last' : 'mid'} ${isReact ? 'react' : ''}`}>
                          {m.attachments?.map((a, j) => (
                            <AttachmentView key={j} a={a} onOpen={setLightbox} />
                          ))}
                          {(() => {
                            const timeEl = !isReact ? (
                              <time className="bt" dateTime={new Date(m.ts).toISOString()} title={fmtStamp(m.ts)}>
                                {fmtTime(m.ts)}
                                {g.fromMe && i === g.items.length - 1 && statusIcon(m.status)}
                              </time>
                            ) : null;
                            if (m.text && m.attachments?.length)
                              return (
                                <span className="bub-text">
                                  {linkify(m.text)}
                                  {timeEl}
                                </span>
                              );
                            return (
                              <>
                                {m.text ? linkify(m.text) : null}
                                {timeEl}
                              </>
                            );
                          })()}
                        </div>
                        {url && <LinkCard url={url} />}
                        {m.reactions?.length ? <ReactionChips list={m.reactions} onToggle={canReact ? (e) => react(m, e) : undefined} /> : null}
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
                        {!isReact && (canReact || chat.platform === 'slack' || !!m.text) && (
                          <button type="button" className={`rtrig ${barFor === m.id ? 'on' : ''}`} aria-label={canReact ? 'Tepki ver' : 'Hızlı işlemler'} title={canReact ? 'Tepki ver' : 'Hızlı işlemler'} onClick={() => (setBarFor(barFor === m.id ? null : m.id), setReactPick(null))}>
                            <Icon name={canReact || chat.platform === 'slack' ? 'smile' : 'calendar'} size={15} />
                          </button>
                        )}
                        {!isReact && barFor === m.id && (canReact || chat.platform === 'slack' || !!m.text) && (
                          <span className="rbar" role="toolbar" aria-label="Hızlı işlemler">
                            {canReact &&
                              QUICK_REACTIONS.map((e) => (
                                <button key={e} type="button" className={m.reactions?.some((r) => r.fromMe && r.emoji === e) ? 'on' : ''} onClick={() => (react(m, e), setBarFor(null))} title={`${e} tepkisi`}>
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
                            {!!m.text && (
                              <button type="button" className="more" title="Takvime ekle" aria-label="Takvime ekle" onClick={() => (setCalFor(calFromText(m.text, `${m.fromMe ? 'Ben' : m.senderName}: ${m.text}`)), setBarFor(null))}>
                                <Icon name="calendar" size={14} />
                              </button>
                            )}
                            {chat.platform === 'slack' && !m.threadId && (
                              <button type="button" className="more" title="İş parçacığında yanıtla" aria-label="İş parçacığında yanıtla" onClick={() => (setThreadFocus(m.remoteId), setBarFor(null))}>
                                <Icon name="thread" size={14} />
                              </button>
                            )}
                          </span>
                        )}
                        {reactPick?.id === m.id && (
                          <div className="react-pick" style={{ top: reactPick.top, left: reactPick.left }}>
                            <EmojiPicker compact onPick={(e) => react(m, e)} onClose={() => setReactPick(null)} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {g.fromMe && g.items[g.items.length - 1].status === 'failed' && <span className="meta" style={{ color: '#a32d2d' }}>Gönderilemedi</span>}
                </div>
              </div>
            ),
          )}
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
                  <Icon name="calendar" size={15} color="#4A4757" />
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
                  <Icon name="calendar" size={15} color="#4A4757" />
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
          {draftOn && (
            <div className="comp-top">
              {draftShown ? (
                <span className="aipill on" title={draftShown.style?.length ? `Tarzın: ${draftShown.style.join(', ')}` : undefined}>
                  <Icon name="sparkle" size={13} color="#D4FF3F" sw={2} /> Senin tarzında taslak
                </span>
              ) : (
                <button className="aipill b b2" onClick={() => makeDraft()} disabled={drafting || !needsReply} title={needsReply ? 'Son mesaja taslak yanıt üret' : 'Yanıtlanacak yeni mesaj yok'}>
                  {drafting ? <span className="spin" /> : <Icon name="sparkle" size={13} color="#6C47FF" sw={2} />} Taslak yaz
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
          {draftShown && !text.trim() && <div className="ghost-draft">{draftShown.draft}</div>}
          <textarea
            ref={taRef}
            rows={2}
            value={text}
            placeholder={threadFocus ? 'İş parçacığına yanıt yaz…' : pending ? 'Açıklama ekle (isteğe bağlı) ve Gönder' : draftShown ? 'Taslağı kabul etmek için Tab, düzenlemek için yazmaya başla' : chat.platform === 'shopier' ? 'Siparişe yerel not ekle (Shopier alıcıya mesaj ucu sunmuyor)…' : isMail ? 'Yanıtını yaz… (Enter gönderir, Shift+Enter yeni satır)' : `${chat.name.length > 40 ? chat.name.slice(0, 38) + '…' : chat.name} için mesaj yaz…`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            style={draftShown && !text.trim() ? { minHeight: 28, paddingTop: 0 } : undefined}
          />
          {queued.length > 0 && (
            <div className="sched-list">
              {queued.map((s) => (
                <div key={s.id} className="sched-row">
                  <Icon name="calendar" size={14} />
                  <span>{fmtStamp(s.at)} · {s.text}</span>
                  <button className="btn ghost xs b" onClick={() => (cancelScheduled(s.id), notify('Zamanlama iptal edildi'))}>Vazgeç</button>
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
            <button className="btn primary b" onClick={send} disabled={sending || !!uploading || !!rec || !(pending || text.trim() || draftShown?.draft)}>
              {sending || uploading ? <span className="spin" /> : <Icon name="send" size={15} sw={1.9} />} Gönder
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
            <Chip platform={chat.platform} size={22} ring="#f3f2f7" />
          </span>
          <span className="name">{chat.name}</span>
          {role && (role.href ? <a className="role" href={role.href} target="_blank" rel="noreferrer">{role.text}</a> : <span className="role">{role.text}</span>)}
          <span className="sub">
            {platform.name}
            {' · '}
            {isOrderPage(chat) ? 'sipariş' : shopKind(chat) === 'question' ? 'müşteri sorusu' : chat.kind === 'group' ? 'grup' : chat.kind === 'channel' ? 'kanal' : 'sohbet'}
          </span>
        </div>
        {PLATFORMS[chat.platform].category === 'shop' && (chat.meta?.order as OrderMeta | undefined)?.items ? <OrderPanel chat={chat} notify={notify} /> : null}
        {PLATFORMS[chat.platform].category === 'shop' && !chat.meta?.order && chat.meta?.question ? <QuestionPanel chat={chat} /> : null}

        <div className="qacts one">
          <button className={`b b2 ${noteOpen || chatNote ? 'go' : ''}`} onClick={() => (setNoteDraft(chatNote), setNoteOpen((v) => !v))}>
            <Icon name="pen" size={16} /> {chatNote ? 'Notu düzenle' : 'Not ekle'}
          </button>
        </div>

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
              <button type="button" className={`act b ${chat.archived ? 'on' : ''}`} onClick={() => onFlags({ archived: !chat.archived })}>
                <Icon name={chat.archived ? 'unarchive' : 'archive'} size={15} /> <span>{chat.archived ? 'Arşivden çıkar' : 'Arşivle'}</span>
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
              <span className="sum-ic"><Icon name="sparkle" size={13} color="#6C47FF" sw={2} /></span>
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
                {drafting ? <span className="spin" /> : <Icon name="sparkle" size={12} color="#6C47FF" sw={2} />} Özetle
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
                {t === 'fırsat' ? <Icon name="sparkle" size={11} color={TAG_COLORS[t][1]} sw={2} /> : <span className="dot" style={{ background: TAG_COLORS[t]?.[1] ?? '#8c889b' }} />}
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
      {calFor && <CalendarModal initial={calFor} notify={notify} onClose={() => setCalFor(null)} />}
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
      {lightboxP.value && <Lightbox att={lightboxP.value} closing={lightboxP.closing} onClose={() => setLightbox(null)} />}
    </>
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

/**
 * Takvime ekle: çekirdek .ics üretip sistemin takvim uygulamasında açar (Mac: Takvim, Windows: Outlook/Takvim);
 * kullanıcı orada kaydeder. Uzak oturumda/demoda dosya indirilir.
 */
function CalendarModal({ initial, notify, onClose }: { initial: CalendarDraft; notify: (t: string, err?: boolean) => void; onClose: () => void }) {
  const [title, setTitle] = useState(initial.title);
  const [date, setDate] = useState(initial.start.slice(0, 10));
  const [time, setTime] = useState(initial.start.slice(11, 16));
  const [duration, setDuration] = useState(initial.durationMin ?? 60);
  const [notes, setNotes] = useState(initial.notes ?? '');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!title.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return notify('Başlık ve tarih gerekli', true);
    setBusy(true);
    try {
      const r = await api.calendar({ title: title.trim(), start: time ? `${date}T${time}` : date, durationMin: duration, notes: notes.trim() || undefined });
      if (r.opened) notify('Takvim uygulamasında açıldı; oradan kaydet');
      else {
        const url = URL.createObjectURL(new Blob([r.ics], { type: 'text/calendar' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `${title.trim().replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60) || 'etkinlik'}.ics`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        notify('Takvim dosyası indirildi; açınca takvimine eklenir');
      }
      onClose();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal cal-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Takvime ekle" onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), onClose())}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="calendar" size={20} color="#6C47FF" />
          <h2 style={{ fontSize: 20 }}>Takvime ekle</h2>
          <span style={{ flexGrow: 1 }} />
          <button className="btn icon b b2" onClick={onClose} aria-label="Kapat">
            <Icon name="x" size={15} sw={2} />
          </button>
        </div>
        <label className="fld">
          <span>Başlık</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
        </label>
        <div className="fld-row">
          <label className="fld">
            <span>Tarih</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="fld">
            <span>Saat</span>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <label className="fld">
            <span>Süre</span>
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} disabled={!time}>
              {[15, 30, 45, 60, 90, 120, 180].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} dk` : `${m / 60} sa`}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!time && <span className="hint">Saat boşsa tüm gün etkinlik olarak eklenir.</span>}
        <label className="fld">
          <span>Not</span>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="İsteğe bağlı" />
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn b b2" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn primary b b2" onClick={() => void save()} disabled={busy}>
            {busy ? <span className="spin" /> : <Icon name="calendar" size={14} />} Takvime ekle
          </button>
        </div>
      </div>
    </div>
  );
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
        <span className={`order-status ${open ? 'open' : 'done'}`}>{o.statusLabel ?? (open ? 'Açık sipariş' : 'Kapatıldı')}</span>
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
            <span className="op-no">📦 Sipariş #{o.id}</span>
            <span className="op-date">{o.dateCreated ? when(Date.parse(o.dateCreated)) : ''}</span>
          </div>
          <span className={`order-status ${open ? 'open' : 'done'}`}>{o.statusLabel ?? o.status}</span>
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
              <span className="tx">{m.text}</span>
              <span className="tm">{when(m.ts)}</span>
            </li>
          ))}
          {events.length === 0 && <li className="empty-tl">Henüz durum değişikliği yok.</li>}
        </ol>
      </div>

      <div className="op-card op-msg">
        {relatedQuestion ? (
          <>
            <span>❓ Bu siparişle ilgili bir müşteri sorusu var.</span>
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
        <span className="q-kind">❓ Müşteri sorusu</span>
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


/** Medya penceresi: görsel/video doğrudan, Instagram/X gönderileri gömülü (embed) sayfayla, diğerleri bağlantıyla. */
function Lightbox({ att, onClose, closing }: { att: Attachment; onClose: () => void; closing?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault(); // arkadaki sohbet kapanmasın
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
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

/** Platformların metin olarak verdiği tepki/beğeni olayları */
export const REACT_TEXT = /^(👍|❤️|❤|😂|🔥|👏|😮|🎉|🙏) .+ (bir mesajı beğendi|mesajına tepki verdi)$/;

const SENDER_COLORS = ['#6c47ff', '#0b6b45', '#b45309', '#a3195b', '#0a66c2', '#b42318', '#0e7490', '#6d28d9', '#047857', '#c2410c'];
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
      <a key={m.index} href={href} target="_blank" rel="noreferrer" className="msg-link" onClick={(e) => (e.preventDefault(), void openExternal(href))}>
        {href}
      </a>,
    );
    if (trail) out.push(trail);
    last = m.index! + raw.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function statusIcon(s: Message['status']) {
  if (s === 'read') return <Icon name="checks" size={13} sw={2.2} />;
  if (s === 'delivered' || s === 'sent') return <Icon name="check" size={12} sw={2.2} />;
  if (s === 'pending') return <span className="spin" style={{ width: 9, height: 9, borderWidth: 1.5 }} />;
  return null;
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
function XPostCard({ a, page }: { a: Attachment; page: string }) {
  const p = usePreview(page);
  const ok = p && !p.none && p.title;
  const handle = ok ? p.title!.match(/\((@[^)]+)\)\s*$/)?.[1] : undefined;
  return (
    <a className={`att-card b xpost${ok && p.image ? '' : ' noimg'}`} href={page} target="_blank" rel="noreferrer" title="Gönderiyi tarayıcıda aç">
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
        <Icon name="external" size={12} />
      </span>
    </a>
  );
}

function LinkCard({ url }: { url: string }) {
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
    <a className="linkcard b" href={p.url} target="_blank" rel="noreferrer" onClick={(e) => (e.preventDefault(), void openExternal(p.url))} title={p.url}>
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
        <VideoPlayer src={link} poster={url} />
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
  if (page && !url && X_STATUS.test(page)) return <XPostCard a={a} page={page} />;
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

/** Saniye → m:ss (kayıt süresi) */
function fmtClock(secs: number) {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Sade video oynatıcı: yerel kontroller yerine ortada oynat/duraklat, altta ince ilerleme çubuğu (tıklayınca sarar),
 * köşede ses ve tam ekran. Tarayıcının dağınık kontrol çubuğu görünmez.
 */
function VideoPlayer({ src, poster }: { src: string; poster?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
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
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return (
    <span className={`vp ${playing ? 'playing' : ''}`}>
      <video
        ref={ref}
        src={src}
        poster={poster}
        preload="metadata"
        playsInline
        muted={muted}
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
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
        <button type="button" className="vp-btn" onClick={() => void ref.current?.requestFullscreen?.().catch(() => undefined)} aria-label="Tam ekran" title="Tam ekran">
          <Icon name="external" size={12} sw={2} />
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
