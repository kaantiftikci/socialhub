import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { PLATFORMS, type Chat, type Message, type Platform } from './types';
import { Avatar, Chip, Icon, fmtTime } from './ui';
import { mlApi, type SemanticResult } from './ml-api';
import { BorderBeam } from 'border-beam';
import { onThemeChange, resolvedTheme } from './theme';

/** Kenar ışığı ayarları: açık zeminde soluk kalıyordu (Kaan 01.10) → tam güç, daha doygun ve koyu renk, biraz daha geniş parıltı */
const DARK_BEAM = { strength: 0.7 } as const;
const LIGHT_BEAM = {
  strength: 1,
  saturation: 1.8,
  // paketin açık tema varsayılanı: kenar çizgisi %12, iç parıltı %26, dış ışık %34 opaklık → ≈%60 / %40 / %55
  style: { ['--beam-stroke-opacity' as string]: 5, ['--beam-inner-opacity' as string]: 1.5, ['--beam-bloom-opacity' as string]: 1.6 },
} as const;
import { DUR, EASE, animate, reducedMotion } from './motion/motion';
import { MvInd } from './motion/MvInd';

/** transcript: eşleşen sesli mesaj metni; via: anlamsal aramada hangi koldan geldi */
type Hit = { message: Message; chat: Chat; transcript?: string; via?: 'semantic' | 'text' | 'both' };
const SEM_KEY = 'mivelo.searchSemantic';
type Item = { kind: 'chat'; chat: Chat } | { kind: 'msg'; hit: Hit };

const norm = (s: string) => s.toLocaleLowerCase('tr-TR');

/** Aranan kelimeleri vurgula (büyük/küçük harf ve Türkçe İ/ı duyarsız) */
function Marked({ text, q }: { text: string; q: string }) {
  const words = q.trim().split(/\s+/).filter((w) => w.length >= 2);
  if (!words.length) return <>{text}</>;
  const lower = norm(text);
  const marks: Array<[number, number]> = [];
  for (const w of words) {
    const lw = norm(w);
    for (let i = lower.indexOf(lw); i >= 0; i = lower.indexOf(lw, i + lw.length)) marks.push([i, i + lw.length]);
  }
  if (!marks.length) return <>{text}</>;
  marks.sort((a, b) => a[0] - b[0]);
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const [a, b] of marks) {
    if (a < at) continue;
    out.push(text.slice(at, a), <mark key={a}>{text.slice(a, b)}</mark>);
    at = b;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

/** Uzun mesajda eşleşmenin çevresini göster (eşleşme satır sonunda kalmasın) */
function snippet(text: string, q: string): string {
  const w = q.trim().split(/\s+/)[0] ?? '';
  // konum boşlukları sıkıştırılmış metinde aranır (yoksa çok satırlı metinde kesit eşleşmeyi dışarıda bırakıyordu)
  const flat = text.replace(/\s+/g, ' ');
  const i = w ? norm(flat).indexOf(norm(w)) : -1;
  if (i < 60) return flat.slice(0, 180);
  return '…' + flat.slice(i - 40, i + 140);
}

/**
 * Genel arama (⌘K / Ctrl+K): tüm uygulamalarda sohbet adları + mesaj içerikleri + ek adları. Açık görünüm/filtre
 * sonuçları daraltmaz. Sonuçlar uygulamaya göre gruplanır; mesaja tıklayınca sohbet açılır ve o mesaja gidilip vurgulanır.
 */
export function SearchPalette({ chats, onClose, onOpenChat, onOpenMessage }: { chats: Chat[]; onClose: () => void; onOpenChat: (id: string) => void; onOpenMessage: (chatId: string, messageId: string, ts: number) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const [only, setOnly] = useState<Platform | null>(null);
  // Anlamsal (doğal dil) arama: yerel gömme modeliyle; tercih bu tarayıcıda hatırlanır
  const [theme, setTheme] = useState(() => resolvedTheme());
  useEffect(() => onThemeChange(setTheme), []);
  const [semantic, setSemantic] = useState(() => {
    try {
      return localStorage.getItem(SEM_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [sem, setSem] = useState<Pick<SemanticResult, 'mode' | 'hints' | 'index'> | null>(null);
  const [semErr, setSemErr] = useState<string | null>(null);
  const toggleSemantic = () =>
    setSemantic((v) => {
      try {
        localStorage.setItem(SEM_KEY, v ? '0' : '1');
      } catch {
        /* depolama kapalı */
      }
      return !v;
    });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const LIMIT = 200;
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    let alive = true;
    const t = window.setTimeout(
      () => {
        const run: Promise<Hit[]> = semantic
          ? mlApi.search(term, LIMIT).then((r) => {
              if (alive) (setSem({ mode: r.mode, hints: r.hints, index: r.index }), setSemErr(null));
              return r.hits;
            })
          : api.search(term, LIMIT);
        run
          .then((h) => alive && setHits(h))
          .catch((e) => {
            if (!alive) return;
            setHits([]);
            if (semantic) setSemErr((e as Error).message);
          })
          .finally(() => alive && setBusy(false));
      },
      semantic ? 320 : 180,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, semantic]);

  const chatHits = useMemo(() => {
    const term = norm(q.trim());
    if (term.length < 1) return [];
    return chats
      .filter((c) => norm(c.name).includes(term) || (c.handle && norm(c.handle).includes(term)) || c.participants?.some((p) => norm(p.name).includes(term)))
      .sort((a, b) => Number(norm(b.name).startsWith(term)) - Number(norm(a.name).startsWith(term)) || b.lastMessageAt - a.lastMessageAt)
      .slice(0, 8);
  }, [chats, q]);

  // uygulamaya göre gruplar (en çok sonuç veren üstte) + sayaç
  const groups = useMemo(() => {
    const m = new Map<Platform, Hit[]>();
    for (const h of hits) m.set(h.chat.platform, [...(m.get(h.chat.platform) ?? []), h]);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [hits]);
  const shownGroups = only ? groups.filter(([p]) => p === only) : groups;
  useEffect(() => {
    if (only && !groups.some(([p]) => p === only)) setOnly(null);
  }, [groups, only]);

  const items: Item[] = useMemo(
    () => [...(only ? [] : chatHits.map((chat) => ({ kind: 'chat' as const, chat }))), ...shownGroups.flatMap(([, hs]) => hs.map((hit) => ({ kind: 'msg' as const, hit })))],
    [chatHits, shownGroups, only],
  );
  useEffect(() => setActive(0), [q, only]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // ---- hareket (s9): açılış, sonuçların sırayla gelişi, kayan seçim vurgusu, kapanış ----
  const wrapRef = useRef<HTMLDivElement>(null);
  const palRef = useRef<HTMLDivElement>(null);
  const selRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const opened = performance.now();
    animate(wrap, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR.quick, easing: EASE.std });
    animate(palRef.current, [{ opacity: 0, transform: 'translateY(-10px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: EASE.in });
    return () => {
      // Kapanış: hangi yoldan kapanırsa kapansın (Esc, Enter, dışa tıklama, ⌘K) bileşen hemen kalkar; ekrandaki kopyası 150 ms'de
      // solar (tıklamaları almaz, sohbete gitmeyi bekletmez). StrictMode'un anlık ikinci takma turunda kopya yapılmaz.
      if (!wrap || reducedMotion() || performance.now() - opened < 60) return;
      const ghost = wrap.cloneNode(true) as HTMLElement;
      ghost.style.pointerEvents = 'none';
      ghost.setAttribute('aria-hidden', 'true');
      const scroll = wrap.querySelector('.pal-list')?.scrollTop ?? 0;
      document.body.appendChild(ghost);
      const gl = ghost.querySelector('.pal-list');
      if (gl) gl.scrollTop = scroll;
      animate(ghost.querySelector('.palette'), [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.98)' }], { duration: DUR.quick, easing: EASE.out, fill: 'forwards' });
      const a = animate(ghost, [{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: EASE.out, fill: 'forwards' });
      const rm = () => ghost.remove();
      if (a) a.finished.then(rm, rm);
      else rm();
      window.setTimeout(rm, 400);
    };
  }, []);
  // yeni gelen sonuç satırları (ilk ~8) 30 ms arayla; yerinde kalan satırlar yeniden oynamaz
  const seenRows = useRef(new WeakSet<Element>());
  useLayoutEffect(() => {
    const rows = listRef.current?.querySelectorAll('.pal-row');
    if (!rows) return;
    let k = 0;
    rows.forEach((r, i) => {
      if (seenRows.current.has(r)) return;
      seenRows.current.add(r);
      if (i < 8) animate(r, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: k++ * 30, easing: EASE.in, fill: 'backwards' });
    });
  }, [items]);
  // seçim vurgusu ayrı katman: ok tuşuyla/fareyle kayarak gider; liste değişince atlamadan yerine konur
  const selAt = useRef<{ y: number; items: Item[] } | null>(null);
  useLayoutEffect(() => {
    const sel = selRef.current;
    const row = listRef.current?.querySelector<HTMLElement>(`.pal-row[data-i="${active}"]`);
    if (!sel) return;
    if (!row) {
      sel.style.display = 'none';
      selAt.current = null;
      return;
    }
    const y = row.offsetTop;
    sel.style.display = '';
    sel.style.width = `${row.offsetWidth}px`;
    sel.style.height = `${row.offsetHeight}px`;
    sel.style.transform = `translate(${row.offsetLeft}px, ${y}px)`;
    const prev = selAt.current;
    if (prev && prev.items === items && prev.y !== y) {
      sel.getAnimations().forEach((a) => a.cancel());
      animate(sel, [{ transform: `translate(${row.offsetLeft}px, ${prev.y}px)` }, { transform: `translate(${row.offsetLeft}px, ${y}px)` }], { duration: DUR.quick, easing: EASE.std });
    }
    selAt.current = { y, items };
  }, [active, items]);

  const choose = (it: Item | undefined) => {
    if (!it) return;
    if (it.kind === 'chat') onOpenChat(it.chat.id);
    else onOpenMessage(it.hit.chat.id, it.hit.message.id, it.hit.message.ts);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(items.length - 1, a + 1)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
    else if (e.key === 'Enter') (e.preventDefault(), choose(items[active]));
    else if (e.key === 'Escape') (e.preventDefault(), onClose());
  };

  const term = q.trim();
  const total = hits.length;
  let idx = only ? 0 : chatHits.length;
  return (
    <div className="overlay palette-wrap pal-anim" ref={wrapRef} onMouseDown={onClose}>
      {/* "AI ile ara" açıkken kenarda dolaşan ışık: libraries.dev Beam (border-beam, MIT); kapalıyken söner (aynı öğe, odak kaybolmaz) */}
      <BorderBeam className="pal-beam-wrap" size="md" colorVariant="colorful" active={semantic} theme={theme} {...(theme === 'light' ? LIGHT_BEAM : DARK_BEAM)} onMouseDown={(e) => e.stopPropagation()}>
      <div className={`palette ${semantic ? 'ai' : ''}`} ref={palRef} role="dialog" aria-label="Her yerde ara" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="pal-in">
          <Icon name="search" size={17} />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={semantic ? 'Doğal dille ara — "geçen ay Ahmet’in gönderdiği fatura"' : 'Tüm uygulamalarda ara — kişi, mesaj, dosya adı…'} aria-label="Arama" spellCheck={false} />
          {busy && <span className="spin" />}
          <button type="button" className={`pal-mode b ${semantic ? 'on' : ''}`} onClick={() => (toggleSemantic(), inputRef.current?.focus())} aria-pressed={semantic} title="Yapay zekâ ile ara: kelimesi kelimesine değil, anlamca yakın mesajları bulur (bilgisayarında çalışır)">
            <Icon name="sparkle" size={13} /> AI ile ara
          </button>
          <span className="kbd">Esc</span>
        </div>
        {semantic && term.length >= 2 && (sem || semErr) && (
          <div className="pal-sem">
            {semErr ? (
              <span className="err">{semErr}</span>
            ) : sem ? (
              <>
                {sem.hints.dateLabel && (
                  <span className="pal-hint">
                    <Icon name="calendar" size={11} /> {sem.hints.dateLabel}
                  </span>
                )}
                {sem.hints.people.map((p) => (
                  <span key={p} className="pal-hint">
                    <Icon name="user" size={11} /> {p}
                  </span>
                ))}
                {sem.mode === 'text' ? (
                  <em>{sem.index.ready ? (sem.index.enabled ? 'Dizin henüz boş; tam metin sonuçları' : 'AI ile arama kapalı (Ayarlar → Yerel AI modelleri); tam metin sonuçları') : 'AI ile arama modeli henüz inmedi (Ayarlar → Yerel AI modelleri); tam metin sonuçları'}</em>
                ) : (
                  <em>Anlamca yakın mesajlar{sem.index.pct < 100 ? ` · dizin %${sem.index.pct}` : ''}</em>
                )}
              </>
            ) : null}
          </div>
        )}
        {term.length >= 2 && (
          <div className="pal-sum">
            {total > 0 ? (
              <>
                <b>
                  {groups.length} uygulamada {total >= LIMIT ? `${LIMIT}+` : total} sonuç
                </b>
                <span className="pal-chips">
                  <MvInd sel="button.on" dep={only ?? ''} variant="chip" />
                  <button type="button" className={!only ? 'on' : ''} onClick={() => setOnly(null)}>
                    Tümü
                  </button>
                  {groups.map(([p, hs]) => (
                    <button key={p} type="button" className={only === p ? 'on' : ''} onClick={() => setOnly(only === p ? null : p)}>
                      <Chip platform={p} size={14} /> {hs.length}
                    </button>
                  ))}
                </span>
              </>
            ) : busy ? (
              <span>Aranıyor…</span>
            ) : (
              <span>Mesajlarda sonuç yok{chatHits.length ? '' : ' — farklı bir kelime dene'}.</span>
            )}
          </div>
        )}
        {term && (
        <div className={`pal-list ${items.length ? 'has-sel' : ''}`} ref={listRef}>
          <div className="pal-sel" ref={selRef} aria-hidden="true" />
          {!only && chatHits.length > 0 && (
            <>
              <div className="pal-h">Sohbetler</div>
              {chatHits.map((c, i) => (
                <button key={c.id} type="button" data-i={i} className={`pal-row ${active === i ? 'on' : ''}`} onMouseMove={() => setActive(i)} onClick={() => choose({ kind: 'chat', chat: c })}>
                  <span className="avwrap">
                    <Avatar name={c.name} size={30} url={c.avatarUrl} />
                    <Chip platform={c.platform} size={13} ring="var(--card)" />
                  </span>
                  <span className="pal-t">
                    <b>
                      <Marked text={c.name} q={term} />
                    </b>
                    <span>{PLATFORMS[c.platform].name}{c.handle ? ` · ${c.handle}` : ''}</span>
                  </span>
                  <Icon name="chev" size={13} />
                </button>
              ))}
            </>
          )}
          {shownGroups.map(([p, hs]) => (
            <div key={p}>
              <div className="pal-h">
                <Chip platform={p} size={14} /> {PLATFORMS[p].name} <em>{hs.length}</em>
              </div>
              {hs.map((h) => {
                const i = idx++;
                const att = h.message.attachments?.find((a) => a.name && norm(a.name).includes(norm(term.split(/\s+/)[0] ?? '')));
                return (
                  <button key={h.message.id} type="button" data-i={i} className={`pal-row ${active === i ? 'on' : ''}`} onMouseMove={() => setActive(i)} onClick={() => choose({ kind: 'msg', hit: h })}>
                    <Avatar name={h.chat.name} size={30} url={h.chat.avatarUrl} />
                    <span className="pal-t">
                      <b>
                        {h.chat.name}
                        <time>{fmtTime(h.message.ts)}</time>
                      </b>
                      <span>
                        {h.message.fromMe ? 'Sen: ' : h.chat.kind !== 'direct' && h.message.senderName ? `${h.message.senderName}: ` : ''}
                        {h.transcript && (semantic || !norm(h.message.text).includes(norm(term.split(/\s+/)[0] ?? ''))) ? (
                          <>
                            <span className="lead-ic" aria-hidden="true">
                              <Icon name="mic" size={12} />
                            </span>
                            <Marked text={snippet(h.transcript, term)} q={term} />
                          </>
                        ) : att && !norm(h.message.text).includes(norm(term.split(/\s+/)[0] ?? '')) ? (
                          <>
                            <span className="lead-ic" aria-hidden="true">
                              <Icon name="clip" size={12} />
                            </span>
                            <Marked text={att.name ?? ''} q={term} />
                          </>
                        ) : (
                          <Marked text={snippet(h.message.text, term)} q={term} />
                        )}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        )}
        {term && (
        <div className="pal-foot">
          <span>
            <span className="kbd">↑</span>
            <span className="kbd">↓</span> seç
          </span>
          <span>
            <span className="kbd">↵</span> aç
          </span>
          <span>Mesaja gidip vurgular</span>
        </div>
        )}
      </div>
      </BorderBeam>
    </div>
  );
}

