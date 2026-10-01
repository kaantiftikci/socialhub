import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { api } from "./api";
import { MOD_KEY } from "./desktop";
import { getPrefs } from "./prefs";
import { PLATFORMS, isOrderPage, type Chat } from "./types";
import { Avatar, Chip, Icon, IconText } from "./ui";
import { EASE, animate, reducedMotion } from "./motion/motion";

/**
 * Hızlı gönder (⌘⇧K / Ctrl+Shift+K) ve bildirimden hızlı yanıt.
 *
 * - `QuickSend`: "Kime" (tüm uygulamalardaki sohbetlerde anlık arama: ad, @kullanıcı adı, e-posta/numara; son yazışılanlar
 *   önce) → mesaj → Enter gönder, ⌘/Ctrl+Enter gönder ve sohbeti aç, Esc kapat. Masaüstünde küresel kısayol kabuktan
 *   ("quick-send" olayı) gelir.
 * - `QuickReplyStack`: sağ üstteki gelen mesaj kartları; kartta satır içi yanıt kutusu. Kart kendiliğinden kaybolur ama
 *   üzerine gelince / yazarken durur. Masaüstünde (Tauri bildirimi tıklama vermez) arka plandayken gelen son bildirimler
 *   pencere öne gelince kart olarak gösterilir (`rememberBackground` + `useRevealOnFocus`).
 * - Gönderim iyimser: palet/kart hemen kapanır, sağ üstte "Gönderiliyor → Ad" hapı; hata olursa (send-guard sınırı,
 *   oturum düşmüş…) hap kırmızı kalır, "Düzenle" metni palete geri koyar.
 */

// ---------- iyimser gönderim kuyruğu (modül düzeyinde: palet kapansa da sürer) ----------
export interface QuickOut {
  id: string;
  chat: Chat;
  text: string;
  state: "sending" | "sent" | "error";
  error?: string;
}
let outbox: QuickOut[] = [];
const outSubs = new Set<() => void>();
const setOutbox = (fn: (x: QuickOut[]) => QuickOut[]) => {
  outbox = fn(outbox);
  outSubs.forEach((f) => f());
};
const useOutbox = () =>
  useSyncExternalStore(
    (f) => (outSubs.add(f), () => void outSubs.delete(f)),
    () => outbox,
    () => outbox,
  );
/** Sohbet başına sıralı gönderim (art arda gönderimler yer değiştirmesin) */
const chains = new Map<string, Promise<unknown>>();

export function quickSendText(chat: Chat, text: string): Promise<boolean> {
  const body = text.trim();
  if (!body) return Promise.resolve(false);
  const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  setOutbox((x) => [
    ...x.slice(-3),
    { id, chat, text: body, state: "sending" },
  ]);
  const run = (chains.get(chat.id) ?? Promise.resolve()).then(() =>
    api.send(chat.id, body),
  );
  const tail = run.catch(() => undefined);
  chains.set(chat.id, tail);
  void tail.then(() => chains.get(chat.id) === tail && chains.delete(chat.id));
  return run.then(
    () => {
      setOutbox((x) =>
        x.map((o) => (o.id === id ? { ...o, state: "sent" } : o)),
      );
      window.setTimeout(
        () => setOutbox((x) => x.filter((o) => o.id !== id)),
        2600,
      );
      return true;
    },
    (e: unknown) => {
      setOutbox((x) =>
        x.map((o) =>
          o.id === id
            ? {
                ...o,
                state: "error",
                error: (e as Error).message || "Gönderilemedi",
              }
            : o,
        ),
      );
      return false;
    },
  );
}

// ---------- arama ----------
/** Türkçe karakter ve büyük/küçük harf duyarsız karşılaştırma anahtarı */
const fold = (s: string) =>
  s
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i");
/** Telefon numarasında boşluk/tire yok sayılır */
const digits = (s: string) => s.replace(/[^\d+]/g, "");

/** Hızlı gönderilebilecek sohbetler: sipariş sayfaları (yazışma yok), kanallar, gizlenenler hariç */
export function quickTargets(chats: Chat[]): Chat[] {
  return chats.filter(
    (c) => !isOrderPage(c) && c.kind !== "channel" && !c.hidden,
  );
}

export function matchChats(chats: Chat[], q: string, limit = 8): Chat[] {
  const words = fold(q.trim()).split(/\s+/).filter(Boolean);
  const list = quickTargets(chats);
  if (!words.length)
    return [...list]
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
      .slice(0, limit);
  const scored: Array<[Chat, number]> = [];
  for (const c of list) {
    const hay = fold(
      [
        c.name,
        c.handle ?? "",
        PLATFORMS[c.platform]?.name ?? "",
        ...(c.participants ?? [])
          .slice(0, 12)
          .flatMap((p) => [p.name, p.handle ?? ""]),
      ].join(" "),
    );
    const hayDigits = digits(
      `${c.handle ?? ""} ${(c.participants ?? []).map((p) => p.handle ?? "").join(" ")}`,
    );
    if (
      !words.every(
        (w) =>
          hay.includes(w) ||
          (/^\+?\d{3,}$/.test(w) && hayDigits.includes(digits(w))),
      )
    )
      continue;
    const name = fold(c.name);
    const score =
      (name.startsWith(words[0]) ? 4 : 0) +
      (name.split(/\s+/).some((p) => p.startsWith(words[0])) ? 2 : 0) +
      (c.kind === "direct" ? 1 : 0);
    scored.push([c, score]);
  }
  return scored
    .sort((a, b) => b[1] - a[1] || b[0].lastMessageAt - a[0].lastMessageAt)
    .slice(0, limit)
    .map(([c]) => c);
}

// ---------- palet ----------
export function QuickSend({
  chats,
  onClose,
  onOpenChat,
  initial,
  closing = false,
}: {
  chats: Chat[];
  onClose: () => void;
  onOpenChat: (id: string) => void;
  initial?: { chatId?: string; text?: string } | null;
  /** kapanış animasyonu sürüyor (App useClosing): tıklamalar alttakine geçer */
  closing?: boolean;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [to, setTo] = useState<Chat | null>(() =>
    initial?.chatId
      ? (chats.find((c) => c.id === initial.chatId) ?? null)
      : null,
  );
  const [text, setText] = useState(initial?.text ?? "");
  const toRef = useRef<HTMLInputElement>(null);
  const msgRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hits = useMemo(() => matchChats(chats, q), [chats, q]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    (to ? msgRef.current : toRef.current)?.focus();
  }, [to]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-i="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (c: Chat | undefined) => {
    if (!c) return;
    setTo(c);
    setQ("");
  };
  const send = (open: boolean) => {
    if (!to || !text.trim()) return;
    void quickSendText(to, text);
    if (open) onOpenChat(to.id);
    onClose();
  };

  const onKeyTo = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown")
      (e.preventDefault(), setActive((a) => Math.min(hits.length - 1, a + 1)));
    else if (e.key === "ArrowUp")
      (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
    else if (e.key === "Enter") (e.preventDefault(), pick(hits[active]));
  };
  const onKeyMsg = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.altKey &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      send(e.metaKey || e.ctrlKey);
    } else if (e.key === "Backspace" && !text) {
      e.preventDefault();
      setTo(null);
    }
  };

  const mail = to ? PLATFORMS[to.platform].category === "mail" : false;
  return (
    <div
      className={`overlay palette-wrap qs-wrap ${closing ? "closing" : ""}`}
      onMouseDown={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape")
          (e.preventDefault(), e.stopPropagation(), onClose());
      }}
    >
      <div
        className="palette qs"
        role="dialog"
        aria-label="Hızlı gönder"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="pal-in qs-to">
          <span className="qs-k">Kime</span>
          {to ? (
            <span className="qs-chip">
              <Chip platform={to.platform} size={16} />
              <b>{to.name}</b>
              <button
                type="button"
                className="b"
                aria-label="Alıcıyı değiştir"
                onClick={() => setTo(null)}
              >
                <Icon name="x" size={12} sw={2} />
              </button>
            </span>
          ) : (
            <input
              ref={toRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKeyTo}
              placeholder="Ad, @kullanıcı adı, e-posta ya da numara…"
              aria-label="Alıcı ara"
              spellCheck={false}
            />
          )}
          <span className="kbd">Esc</span>
        </div>
        {!to ? (
          <div className="pal-list" ref={listRef}>
            <div className="pal-h">
              {q.trim() ? "Eşleşen sohbetler" : "Son yazışılanlar"}
            </div>
            {hits.length === 0 && (
              <div className="qs-empty">
                Eşleşen sohbet yok — farklı bir ad ya da tanıtıcı dene.
              </div>
            )}
            {hits.map((c, i) => (
              <button
                key={c.id}
                type="button"
                data-i={i}
                className={`pal-row ${active === i ? "on" : ""}`}
                onMouseMove={() => setActive(i)}
                onClick={() => pick(c)}
              >
                <span className="avwrap">
                  <Avatar name={c.name} size={30} url={c.avatarUrl} />
                  <Chip platform={c.platform} size={13} ring="var(--card)" />
                </span>
                <span className="pal-t">
                  <b>{c.name}</b>
                  <span>
                    {PLATFORMS[c.platform].name}
                    {c.handle ? ` · ${c.handle}` : ""}
                    {c.kind === "group" ? " · grup" : ""}
                  </span>
                </span>
                <Icon name="chev" size={13} />
              </button>
            ))}
          </div>
        ) : (
          <div className="qs-body">
            <textarea
              ref={msgRef}
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyMsg}
              spellCheck={getPrefs().spellcheck}
              placeholder={
                mail
                  ? `${to.name} dizisine yanıt yaz…`
                  : `${to.name} kişisine yaz…`
              }
              aria-label="Mesaj"
            />
            <div className="qs-foot">
              <span className="qs-hint">
                <span className="kbd">Enter</span> gönder ·{" "}
                <span className="kbd">
                  {MOD_KEY === "⌘" ? "⌘Enter" : "Ctrl+Enter"}
                </span>{" "}
                gönder ve aç · <span className="kbd">Shift+Enter</span> yeni
                satır
              </span>
              <button
                type="button"
                className="btn ghost sm b b2"
                disabled={!text.trim()}
                onClick={() => send(true)}
              >
                Gönder ve aç
              </button>
              <button
                type="button"
                className="btn primary sm b b2"
                disabled={!text.trim()}
                onClick={() => send(false)}
              >
                <Icon name="send" size={14} sw={2} /> Gönder
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- arka planda gelen bildirimler (pencere öne gelince kart) ----------
let background: Array<{ chat: Chat; text: string; at: number }> = [];
/** Pencere arka plandayken sistem bildirimi gösterilen mesajı hatırla (en çok 3; aynı sohbetten yalnız sonuncusu) */
export function rememberBackground(chat: Chat, text: string): void {
  background = [
    ...background.filter((b) => b.chat.id !== chat.id),
    { chat, text, at: Date.now() },
  ].slice(-3);
}
/** Web bildirimine tıklanınca / pencere öne gelince bekleyen kartları göster (30 dk'dan eskiler atılır) */
export function takeBackground(
  chatId?: string,
): Array<{ chat: Chat; text: string }> {
  const fresh = background.filter((b) => Date.now() - b.at < 30 * 60_000);
  const out = chatId ? fresh.filter((b) => b.chat.id === chatId) : fresh;
  background = chatId ? fresh.filter((b) => b.chat.id !== chatId) : [];
  return out;
}
/** Pencere odak kazanınca (Dock/tepsi tıklaması, bildirim tıklaması, Alt+Tab) bekleyenleri karta çevir */
export function useRevealOnFocus(
  push: (chat: Chat, text: string) => void,
  visibleChatId: () => string | null,
): void {
  const pushRef = useRef(push);
  pushRef.current = push;
  useEffect(() => {
    const reveal = () => {
      if (document.visibilityState === "hidden") return;
      for (const b of takeBackground())
        if (b.chat.id !== visibleChatId()) pushRef.current(b.chat, b.text);
    };
    window.addEventListener("focus", reveal);
    document.addEventListener("visibilitychange", reveal);
    return () => {
      window.removeEventListener("focus", reveal);
      document.removeEventListener("visibilitychange", reveal);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// ---------- sağ üst kart yığını ----------
export interface InToast {
  id: number;
  chat: Chat;
  text: string;
}
const TOAST_MS = 8000;

function ReplyCard({
  t,
  onDismiss,
  onOpen,
}: {
  t: InToast;
  onDismiss: () => void;
  onOpen: () => void;
}) {
  const [reply, setReply] = useState("");
  const [hold, setHold] = useState(false);
  const [focus, setFocus] = useState(false);
  const [open, setOpen] = useState(false);
  const canReply = !isOrderPage(t.chat) && t.chat.kind !== "channel";
  const paused = hold || focus || open || !!reply;
  const slotRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  // Çıkış: kart sağa kayıp solar (180 ms), sonra yeri yumuşakça kapanır (alttaki kartlar zıplamaz); ancak sonra listeden düşer
  const leaving = useRef(false);
  const dismiss = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    const slot = slotRef.current;
    const card = cardRef.current;
    if (!slot || !card || reducedMotion()) return onDismissRef.current();
    slot.style.pointerEvents = "none";
    const h = slot.offsetHeight;
    animate(shadowRef.current, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: EASE.out, fill: "forwards" });
    const out = animate(card, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(40px) scale(.98)" }], { duration: 180, easing: EASE.out, fill: "forwards" });
    const done = () => onDismissRef.current();
    if (!out) return done();
    out.finished
      .then(() => {
        slot.style.overflow = "hidden";
        return animate(slot, [{ height: `${h}px`, marginBottom: "0px" }, { height: "0px", marginBottom: "-8px" }], { duration: 180, easing: EASE.std, fill: "forwards" })?.finished;
      })
      .then(done, done);
  }, []);
  // Giriş: kart sağdan gelir (320 ms), gölge 60 ms, avatar 90 ms geriden; ad ve metin kısa aralıkla belirir
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || reducedMotion()) return;
    animate(card, [{ opacity: 0, transform: "translateX(28px) scale(.96)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: EASE.in });
    animate(shadowRef.current, [{ opacity: 0, transform: "translateX(28px) scale(.96)" }, { opacity: 1, transform: "none" }], { duration: 320, delay: 60, easing: EASE.std, fill: "backwards" });
    animate(card.querySelector(".avwrap"), [{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "none" }], { duration: 280, delay: 90, easing: EASE.pop, fill: "backwards" });
    card.querySelectorAll(".qr-head .body > *").forEach((n, i) =>
      animate(n, [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 220, delay: 110 + i * 35, easing: EASE.std, fill: "backwards" }),
    );
  }, []);
  // Kalan süre: alttaki çizgi süreyle kısalır; üzerine gelince / yazarken çizgi de süre de durur, kaldığı yerden devam eder
  const left = useRef(TOAST_MS);
  const bar = useRef<Animation | null>(null);
  useEffect(() => {
    if (paused) return;
    const t0 = performance.now();
    if (!bar.current && barRef.current && typeof barRef.current.animate === "function")
      bar.current = barRef.current.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], { duration: TOAST_MS, easing: "linear", fill: "forwards" });
    bar.current?.play();
    const h = window.setTimeout(dismiss, Math.max(0, left.current));
    return () => {
      clearTimeout(h);
      left.current -= performance.now() - t0;
      bar.current?.pause();
    };
  }, [paused, dismiss]);
  const openChat = () => {
    onOpen();
    dismiss();
  };
  const send = () => {
    if (!reply.trim()) return;
    void quickSendText(t.chat, reply);
    dismiss();
  };
  return (
    <div className="qr-slot" data-k={`t${t.id}`} ref={slotRef}>
      <span className="qr-shadow" ref={shadowRef} aria-hidden="true" />
    <div
      ref={cardRef}
      className={`msgtoast qr-card ${paused ? "held" : ""}`}
      role="group"
      aria-label={`${t.chat.name} bildirimi`}
      onMouseEnter={() => setHold(true)}
      onMouseLeave={() => setHold(false)}
    >
      <div className="qr-row">
        <button
          type="button"
          className="qr-head b"
          onClick={openChat}
          title="Sohbeti aç"
        >
          <span className="avwrap">
            <Avatar name={t.chat.name} size={38} url={t.chat.avatarUrl} />
            <span className="qr-badge">
              <Chip
                platform={t.chat.platform}
                size={20}
                ring="var(--surface)"
              />
            </span>
          </span>
          <span className="body">
            <span className="top">
              <b>{t.chat.name}</b>
            </span>
            <span className="txt">
              <IconText text={t.text} size={12} />
            </span>
          </span>
        </button>
        {canReply && !open && (
          <div className="qr-acts">
            <button
              type="button"
              className="btn xs b b2"
              onClick={() => setOpen(true)}
            >
              <Icon name="reply" size={13} sw={2} /> Yanıtla
            </button>
            <button
              type="button"
              className="btn ghost xs b b2"
              onClick={openChat}
            >
              Aç
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        className="x b"
        aria-label="Kapat"
        onClick={dismiss}
      >
        <Icon name="x" size={12} sw={2} />
      </button>
      {canReply && open && (
        <form
          className="qr-reply"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            autoFocus
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape")
                (e.preventDefault(),
                  e.stopPropagation(),
                  reply ? setReply("") : setOpen(false));
            }}
            placeholder="Hızlı yanıt…"
            aria-label={`${t.chat.name} kişisine hızlı yanıt`}
          />
          <button
            type="submit"
            className={`btn ${reply.trim() ? "primary" : "ghost"} xs b b2`}
            disabled={!reply.trim()}
            aria-label="Gönder"
          >
            <Icon name="send" size={13} sw={2} />
          </button>
          <button type="button" className="btn ghost xs b b2" onClick={openChat}>
            Aç
          </button>
        </form>
      )}
      <span ref={barRef} className="qr-timer" aria-hidden="true" />
    </div>
    </div>
  );
}

export function QuickReplyStack({
  toasts,
  onDismiss,
  onOpen,
  onEdit,
}: {
  toasts: InToast[];
  onDismiss: (id: number) => void;
  onOpen: (chat: Chat) => void;
  onEdit: (chatId: string, text: string) => void;
}) {
  const outs = useOutbox();
  // FLIP: kart eklenip çıkınca (aynı sohbetin eski kartı yenisiyle değişince, üste "Gönderiliyor" hapı gelince) diğerleri kayar.
  // Eski konumlar çizimden ÖNCE okunur (kart yığını değiştiyse; kapanan kartın yeri o sırada zaten sıfırlanmış olur), yenileri
  // useLayoutEffect'te; offsetTop dönüşümden etkilenmez, en çok birkaç öğe.
  const boxRef = useRef<HTMLDivElement>(null);
  const committed = useRef("");
  const before = useRef<Map<string, number> | null>(null);
  const sig = [...outs.map((o) => `o${o.id}`), ...toasts.map((t) => `t${t.id}`)].join(",");
  const tops = (box: HTMLElement | null) => {
    const m = new Map<string, number>();
    for (const el of box ? (Array.from(box.children) as HTMLElement[]) : []) if (el.dataset.k) m.set(el.dataset.k, el.offsetTop);
    return m;
  };
  if (sig !== committed.current) before.current = tops(boxRef.current);
  useLayoutEffect(() => {
    committed.current = sig;
    const prev = before.current;
    before.current = null;
    const box = boxRef.current;
    if (!prev || !box || reducedMotion()) return;
    const next = tops(box);
    for (const el of Array.from(box.children) as HTMLElement[]) {
      const a = prev.get(el.dataset.k ?? ""), b = next.get(el.dataset.k ?? "");
      if (a == null || b == null || Math.abs(a - b) < 0.5) continue;
      animate(el, [{ transform: `translateY(${a - b}px)` }, { transform: "none" }], { duration: 300, easing: EASE.std });
    }
  }, [sig]);
  if (!toasts.length && !outs.length) return null;
  return (
    <div className="msgtoasts" aria-live="polite" ref={boxRef}>
      {outs.map((o) => (
        <div
          key={o.id}
          data-k={`o${o.id}`}
          className={`qs-out ${o.state}`}
          role={o.state === "error" ? "alert" : undefined}
        >
          <Chip platform={o.chat.platform} size={14} />
          <span className="t">
            {o.state === "sending"
              ? "Gönderiliyor"
              : o.state === "sent"
                ? "Gönderildi"
                : "Gönderilemedi"}{" "}
            → <b>{o.chat.name}</b>
            {o.state === "error" && o.error && (
              <em>{o.error.replace(/^Gönderilemedi:\s*/, "")}</em>
            )}
          </span>
          {o.state === "sending" && <span className="spin" />}
          {o.state === "sent" && <Icon name="check" size={13} sw={2.2} />}
          {o.state === "error" && (
            <>
              <button
                type="button"
                className="btn ghost xs b b2"
                onClick={() => (
                  setOutbox((x) => x.filter((y) => y.id !== o.id)),
                  void quickSendText(o.chat, o.text)
                )}
              >
                Yeniden dene
              </button>
              <button
                type="button"
                className="btn ghost xs b b2"
                onClick={() => (
                  setOutbox((x) => x.filter((y) => y.id !== o.id)),
                  onEdit(o.chat.id, o.text)
                )}
              >
                Düzenle
              </button>
              <button
                type="button"
                className="x b"
                aria-label="Kapat"
                onClick={() => setOutbox((x) => x.filter((y) => y.id !== o.id))}
              >
                <Icon name="x" size={12} sw={2} />
              </button>
            </>
          )}
        </div>
      ))}
      {toasts.map((t) => (
        <ReplyCard
          key={t.id}
          t={t}
          onDismiss={() => onDismiss(t.id)}
          onOpen={() => onOpen(t.chat)}
        />
      ))}
    </div>
  );
}
