import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { peopleApi, type Person, type PersonChat, type TimelineMessage } from './people-api';
import { onPeopleEvent, usePeople } from './people-store';
import { Chip, Icon } from './ui';
import { PLATFORMS, type Chat, type Message, type Platform } from './types';
import { staggerIn } from './PersonPanel';
import { MvInd } from './motion/MvInd';

/**
 * Birleşik zaman çizelgesi: sohbet bir kişiye bağlıysa (kişi birden çok kanalda) başlık altında kanal çipleri + "Tüm kanallar".
 * "Tüm kanallar" seçilince mesaj alanı bağlı sohbetlerin mesajlarını birlikte, zamana göre gösterir (Conversation'ın kendi
 * balonlarıyla; her balonda küçük platform logosu). Yanıt seçilen kanaldan gider (varsayılan: en son yazışılan kanal).
 */

export interface UnifiedTimelineState {
  person: Person | null;
  on: boolean;
  setOn: (v: boolean) => void;
  messages: Message[];
  hasMore: boolean;
  busy: boolean;
  loadOlder: () => Promise<void>;
  /** yanıtın gideceği sohbet (tam Chat; App listesinde yoksa açık sohbet) */
  sendChat: Chat | null;
  setSendChatId: (id: string) => void;
  platformOf: (chatId: string) => Platform | undefined;
  /** Conversation'a verilen kararlı nesne (balon listesi her çizimde yeniden kurulmasın) */
  info: { platformOf: (chatId: string) => Platform | undefined };
}

const PAGE = 100;

export function useUnifiedTimeline(current: Chat | undefined, chats: Map<string, Chat>): UnifiedTimelineState {
  const { byChat } = usePeople();
  const found = current ? byChat.get(current.id) : undefined;
  const person = found && found.chats.length >= 2 ? found : null;
  const [on, setOnState] = useState(false);
  const [msgs, setMsgs] = useState<TimelineMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sendId, setSendId] = useState<string | null>(null);
  const personId = person?.id;
  const chatIds = useMemo(() => new Set(person?.chats.map((c) => c.id) ?? []), [person]);
  const byId = useMemo(() => new Map<string, PersonChat>(person?.chats.map((c) => [c.id, c]) ?? []), [person]);
  // sohbet değişince tek kanala dönülür
  useEffect(() => {
    setOnState(false);
    setSendId(null);
  }, [current?.id]);
  useEffect(() => {
    if (!person) setOnState(false);
  }, [person]);

  const reqRef = useRef(0);
  const load = useCallback(async () => {
    if (!personId) return;
    const req = ++reqRef.current;
    setBusy(true);
    try {
      const t = await peopleApi.timeline(personId, undefined, PAGE);
      if (req !== reqRef.current) return;
      setMsgs(t.messages);
      setHasMore(t.hasMore);
    } catch {
      /* kişi silinmiş olabilir */
    } finally {
      if (req === reqRef.current) setBusy(false);
    }
  }, [personId]);

  useEffect(() => {
    if (!on || !personId) return;
    void load();
    // birleşik görünümde okunmamış diğer kanallar da okundu sayılır
    for (const c of person?.chats ?? []) if ((chats.get(c.id)?.unread ?? 0) > 0) void api.markRead(c.id).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, personId, load]);

  // canlı: bağlı sohbetlere gelen/giden mesaj, silme, çoklu yazım
  useEffect(() => {
    if (!on) return;
    return onPeopleEvent((ev) => {
      if (ev.type === 'message.upsert' && chatIds.has(ev.message.chatId)) {
        const pc = byId.get(ev.message.chatId)!;
        const m: TimelineMessage = { ...ev.message, platform: pc.platform, accountId: pc.accountId };
        setMsgs((prev) => {
          const i = prev.findIndex((x) => x.id === m.id);
          if (i >= 0) return prev.map((x, j) => (j === i ? m : x));
          return [...prev, m].sort((a, b) => a.ts - b.ts);
        });
      } else if (ev.type === 'message.delete' && chatIds.has(ev.chatId)) setMsgs((prev) => prev.filter((x) => x.id !== ev.messageId));
      else if (ev.type === 'messages.read' && chatIds.has(ev.chatId)) setMsgs((prev) => prev.map((x) => (x.chatId === ev.chatId && x.fromMe && x.ts <= ev.before && x.status !== 'read' ? { ...x, status: 'read' } : x)));
      else if (ev.type === 'messages.refetch' && ev.chatIds.some((c) => chatIds.has(c))) void load();
    });
  }, [on, chatIds, byId, load]);

  const loadOlder = useCallback(async () => {
    if (!personId || busy || !msgs.length) return;
    setBusy(true);
    try {
      const t = await peopleApi.timeline(personId, msgs[0].ts, PAGE);
      setMsgs((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        return [...t.messages.filter((m) => !ids.has(m.id)), ...prev].sort((a, b) => a.ts - b.ts);
      });
      setHasMore(t.hasMore);
    } finally {
      setBusy(false);
    }
  }, [personId, busy, msgs]);

  // varsayılan gönderim kanalı: en son yazışılan (App listesindeki güncel zamanla)
  const latest = useMemo(() => {
    if (!person) return null;
    let best: PersonChat | null = null;
    for (const c of person.chats) {
      const at = chats.get(c.id)?.lastMessageAt ?? c.lastMessageAt;
      if (!best || at > (chats.get(best.id)?.lastMessageAt ?? best.lastMessageAt)) best = c;
    }
    return best?.id ?? null;
  }, [person, chats]);
  const sendChat = (on && (chats.get(sendId ?? '') ?? chats.get(latest ?? ''))) || current || null;

  const platformOf = useCallback((id: string) => byId.get(id)?.platform, [byId]);
  const setOn = useCallback((v: boolean) => setOnState(v), []);
  const info = useMemo(() => ({ platformOf }), [platformOf]);
  return { person, on: on && !!person, setOn, messages: msgs, hasMore, busy, loadOlder, sendChat, setSendChatId: setSendId, platformOf, info };
}

/** Sohbet başlığının altındaki kanal şeridi: bu kişinin kanalları + "Tüm kanallar" */
export function PersonChannelBar({ tl, current, onSelectChat }: { tl: UnifiedTimelineState; current: Chat; onSelectChat: (id: string) => void }) {
  // kanal çipleri kişi ilk görününce 35 ms arayla kayarak gelir (aynı kişinin kanalları arasında geçişte tekrar oynamaz)
  const ref = useRef<HTMLDivElement>(null);
  const shownFor = useRef<string | null>(null);
  const pid = tl.person?.id ?? null;
  useLayoutEffect(() => {
    if (!pid || shownFor.current === pid) return;
    shownFor.current = pid;
    staggerIn(ref.current, ':scope > :not(.mv-ind)', 12);
  }, [pid]);
  if (!tl.person) return null;
  return (
    <div ref={ref} className="pchan" role="tablist" aria-label={`${tl.person.name}: kanallar`}>
      <button type="button" role="tab" aria-selected={tl.on} className={`pchan-it all b ${tl.on ? 'on' : ''}`} onClick={() => tl.setOn(!tl.on)} title="Bu kişinin tüm kanallarındaki mesajlar tek zaman çizelgesinde">
        <Icon name="users" size={13} sw={2} /> Tüm kanallar
      </button>
      <MvInd sel=".pchan-it.on" dep={tl.on ? 'all' : current.id} variant="chip" />
      {tl.person.chats.map((c) => {
        const active = !tl.on && c.id === current.id;
        return (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`pchan-it b ${active ? 'on' : ''}`}
            title={`${PLATFORMS[c.platform]?.name ?? c.platform} · ${c.name}`}
            onClick={() => {
              if (c.id === current.id) tl.setOn(false);
              else onSelectChat(c.id);
            }}
          >
            <Chip platform={c.platform} size={16} />
            <span>{PLATFORMS[c.platform]?.category === 'mail' ? c.handle ?? c.name : PLATFORMS[c.platform]?.name ?? c.platform}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Birleşik görünümde yazma alanının üstü: yanıtın gideceği kanal */
export function SendVia({ tl }: { tl: UnifiedTimelineState }) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = !!(tl.on && tl.person && tl.sendChat);
  const was = useRef(false);
  useLayoutEffect(() => {
    if (visible && !was.current) staggerIn(ref.current, ':scope > .k, :scope .sv-it', 8);
    was.current = visible;
  }, [visible]);
  if (!tl.on || !tl.person || !tl.sendChat) return null;
  const cur = tl.sendChat;
  return (
    <div ref={ref} className="sendvia">
      <span className="k">Gönderilecek kanal</span>
      <span className="sv-list" role="radiogroup" aria-label="Gönderilecek kanal">
        <MvInd sel=".sv-it.on" dep={cur.id} variant="chip" />
        {tl.person.chats.map((c) => (
          <button key={c.id} type="button" role="radio" aria-checked={c.id === cur.id} className={`sv-it b ${c.id === cur.id ? 'on' : ''}`} title={`${PLATFORMS[c.platform]?.name ?? c.platform} · ${c.name}`} onClick={() => tl.setSendChatId(c.id)}>
            <Chip platform={c.platform} size={16} />
            <span>{PLATFORMS[c.platform]?.name ?? c.platform}</span>
          </button>
        ))}
      </span>
    </div>
  );
}
