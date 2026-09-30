import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';
import { peopleApi, type PersonChat, type PersonSuggestion } from './people-api';
import { refreshPeople, usePeople } from './people-store';
import { Avatar, Chip, Icon } from './ui';
import { PLATFORMS, type Chat, type Platform } from './types';

/**
 * Kişi birleştirme arayüzü: sağ ayrıntı panelindeki "Kişi" bölümü (bu kişinin diğer kanalları, Bağla…, Ayır, öneri),
 * "Birleştirme önerileri" toplu penceresi ve listedeki ek platform logoları (PersonLogos).
 */

const EXCLUDED = new Set<Platform>(['shopier', 'trendyol', 'hepsiburada', 'etsy', 'shopify', 'n11', 'amazon', 'pttavm']);
export const personable = (c: Pick<Chat, 'kind' | 'platform'>) => c.kind === 'direct' && !EXCLUDED.has(c.platform);

const pname = (p: Platform) => PLATFORMS[p]?.name ?? p;
/** Kanal satırı etiketi: e-postada adres, diğerlerinde ad (+ tanıtıcı) */
function chatLabel(c: PersonChat): string {
  if (PLATFORMS[c.platform]?.category === 'mail') return c.handle ?? c.name;
  return c.handle && c.handle !== c.name && !c.name.includes(c.handle) ? `${c.name} · ${c.handle}` : c.name;
}
/** Önerideki "diğer" kanalların kısa özeti: "Instagram @x, Gmail" */
function otherSummary(s: PersonSuggestion, selfId?: string, selfName?: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const c of s.chats) {
    if (c.id === selfId) continue;
    const k = `${c.platform}|${PLATFORMS[c.platform]?.category === 'mail' ? c.handle : c.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const h = c.handle && (c.handle.startsWith('@') || PLATFORMS[c.platform]?.category === 'mail') ? ` ${c.handle}` : c.name && c.name !== selfName ? ` · ${c.name}` : '';
    parts.push(`${pname(c.platform)}${h}`);
  }
  return parts.slice(0, 4).join(', ') + (parts.length > 4 ? ` +${parts.length - 4}` : '');
}
const fold = (s: string) => s.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/\p{M}+/gu, '');

/** Sağ panel → Kişi */
export function PersonPanel({ chat, onSelectChat, notify }: { chat: Chat; onSelectChat?: (id: string) => void; notify: (t: string, err?: boolean) => void }) {
  const { byChat, suggestByChat, suggestions } = usePeople();
  const [picker, setPicker] = useState(false);
  const [all, setAll] = useState(false);
  const [askUnlink, setAskUnlink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => (setPicker(false), setAskUnlink(null)), [chat.id]);
  if (!personable(chat)) return null;
  const person = byChat.get(chat.id);
  const mine = suggestByChat.get(chat.id) ?? [];
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await refreshPeople();
      if (ok) notify(ok);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ctx-sec person-sec">
      <span className="label">
        Kişi{person ? ` · ${person.chats.length} kanal` : ''}
        {suggestions.length > 0 && (
          <button type="button" className="ps-all b" onClick={() => setAll(true)} title="Tüm birleştirme önerileri">
            Öneriler · {suggestions.length}
          </button>
        )}
      </span>
      {person ? (
        <div className="acts pchats">
          {person.chats.map((c) => (
            <div key={c.id} className={`pchat ${c.id === chat.id ? 'self' : ''}`}>
              <button type="button" className="act b" disabled={c.id === chat.id} onClick={() => onSelectChat?.(c.id)} title={c.id === chat.id ? 'Bu sohbet' : `${pname(c.platform)} sohbetine geç`}>
                <Chip platform={c.platform} size={16} />
                <span>{chatLabel(c)}</span>
                {c.id === chat.id && <em className="pc-self">bu sohbet</em>}
              </button>
              {askUnlink === c.id ? (
                <button type="button" className="btn xs danger b" disabled={busy} onClick={() => void run(() => peopleApi.unlink(person.id, c.id), 'Sohbet kişiden ayrıldı')}>
                  Emin misin? Ayır
                </button>
              ) : (
                <button type="button" className="btn ghost xs icon b" aria-label="Kişiden ayır" title="Kişiden ayır" onClick={() => setAskUnlink(c.id)}>
                  <Icon name="x" size={12} sw={2} />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <span className="hint ps-hint">Bu kişinin başka uygulamalardaki sohbetlerini bağla: tek profil, tek zaman çizelgesi.</span>
      )}
      {mine.map((s) => (
        <div key={s.key} className={`psug ${s.strong ? 'strong' : ''}`}>
          <span className="ps-t">
            <b>Aynı kişi olabilir:</b> {otherSummary(s, chat.id, chat.name)}
          </span>
          <span className="ps-why">
            {s.reasons.join(' · ')} · %{Math.round(s.score * 100)}
          </span>
          <span className="ps-acts">
            <button type="button" className="btn xs primary b" disabled={busy} onClick={() => void run(() => peopleApi.mergeSuggestion(s.key), 'Birleştirildi')}>
              Birleştir
            </button>
            <button type="button" className="btn xs b b2" disabled={busy} onClick={() => void run(() => peopleApi.dismiss(s.key))}>
              Hayır
            </button>
          </span>
        </div>
      ))}
      <button type="button" className="btn xs b b2 ps-link" onClick={() => setPicker(true)}>
        <Icon name="link" size={13} /> Bağla…
      </button>
      {picker && (
        <LinkPicker
          chat={chat}
          exclude={new Set(person?.chats.map((c) => c.id) ?? [chat.id])}
          onClose={() => setPicker(false)}
          onPick={(other) => void run(() => peopleApi.merge([chat.id, other.id], { personId: person?.id ?? byChat.get(other.id)?.id }), `${other.name} bağlandı`).then(() => setPicker(false))}
        />
      )}
      {all && <SuggestionsModal onClose={() => setAll(false)} notify={notify} onSelectChat={onSelectChat} />}
    </div>
  );
}

/** Elle bağlama: sohbet arama seçicisi (birebir, pazaryeri dışı) */
function LinkPicker({ chat, exclude, onPick, onClose }: { chat: Chat; exclude: Set<string>; onPick: (c: Chat) => void; onClose: () => void }) {
  const [list, setList] = useState<Chat[] | null>(null);
  const [q, setQ] = useState(() => chat.name.split(/\s+/)[0] ?? '');
  const inRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    api
      .chats()
      .then((c) => live && setList(c.filter((x) => personable(x) && !exclude.has(x.id))))
      .catch(() => live && setList([]));
    inRef.current?.select();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const shown = useMemo(() => {
    if (!list) return [];
    const words = fold(q).split(/\s+/).filter(Boolean);
    const hit = (c: Chat) => {
      const hay = fold(`${c.name} ${c.handle ?? ''} ${c.participants?.[0]?.name ?? ''} ${pname(c.platform)}`);
      return words.every((w) => hay.includes(w));
    };
    return list.filter(hit).sort((a, b) => Number(b.platform !== chat.platform) - Number(a.platform !== chat.platform) || b.lastMessageAt - a.lastMessageAt).slice(0, 60);
  }, [list, q, chat.platform]);
  // sağ panelin (animasyonlu, taşması kırpılan) içinde değil, sayfanın üstünde
  return createPortal(
    <div className="overlay" onClick={onClose}>
      <div className="modal people-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Sohbet bağla" onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), onClose())}>
        <div className="pm-head">
          <div>
            <h3>Aynı kişinin sohbetini bağla</h3>
            <span className="hint">{chat.name} ile birleştirilecek sohbeti seç</span>
          </div>
          <button type="button" className="btn icon b b2" onClick={onClose} aria-label="Kapat">
            <Icon name="x" size={15} sw={2} />
          </button>
        </div>
        <label className="pm-search">
          <Icon name="search" size={14} />
          <input ref={inRef} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ad, @kullanıcı adı, e-posta ya da uygulama" />
        </label>
        <div className="pm-list">
          {list === null && <div className="empty">Sohbetler yükleniyor…</div>}
          {list && shown.length === 0 && <div className="empty">Eşleşen birebir sohbet yok.</div>}
          {shown.map((c) => (
            <button key={c.id} type="button" className="pm-row b" onClick={() => onPick(c)}>
              <span className="avwrap">
                <Avatar name={c.name} size={32} url={c.avatarUrl} />
                <Chip platform={c.platform} size={14} ring="var(--bg)" />
              </span>
              <span className="pm-body">
                <b>{PLATFORMS[c.platform]?.category === 'mail' ? c.participants?.[0]?.name ?? c.handle ?? c.name : c.name}</b>
                <span>
                  {pname(c.platform)}
                  {c.handle ? ` · ${c.handle}` : ''}
                </span>
              </span>
              <Icon name="plus" size={14} sw={2} />
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Tüm birleştirme önerileri: Birleştir / Hayır; "Tümünü birleştir" yalnız güçlü (telefon/e-posta) eşleşmeler */
export function SuggestionsModal({ onClose, notify, onSelectChat }: { onClose: () => void; notify: (t: string, err?: boolean) => void; onSelectChat?: (id: string) => void }) {
  const { suggestions } = usePeople();
  const [busy, setBusy] = useState<string | null>(null);
  const strong = suggestions.filter((s) => s.strong);
  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      await refreshPeople();
      if (ok) notify(ok);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  // sağ panelin (animasyonlu, taşması kırpılan) içinde değil, sayfanın üstünde
  return createPortal(
    <div className="overlay" onClick={onClose}>
      <div className="modal people-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Birleştirme önerileri" onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), onClose())}>
        <div className="pm-head">
          <div>
            <h3>Birleştirme önerileri</h3>
            <span className="hint">Aynı kişinin farklı uygulamalardaki sohbetleri. Hiçbiri sen onaylamadan birleştirilmez.</span>
          </div>
          <button type="button" className="btn icon b b2" onClick={onClose} aria-label="Kapat">
            <Icon name="x" size={15} sw={2} />
          </button>
        </div>
        {strong.length > 1 && (
          <div className="pm-bulk">
            <span>
              <b>{strong.length}</b> öneri aynı telefon numarası ya da e-posta adresiyle eşleşiyor.
            </span>
            <button type="button" className="btn xs primary b" disabled={!!busy} onClick={() => void act('*', async () => notify(`${(await peopleApi.mergeAllStrong()).merged} kişi birleştirildi`))}>
              Tümünü birleştir
            </button>
          </div>
        )}
        <div className="pm-list">
          {suggestions.length === 0 && <div className="empty">Şimdilik öneri yok. Yeni sohbetler eşitlendikçe öneriler burada görünür.</div>}
          {suggestions.map((s) => (
            <div key={s.key} className={`pm-sug ${s.strong ? 'strong' : ''}`}>
              <div className="pm-sug-top">
                <Avatar name={s.name} size={34} url={s.chats.find((c) => c.avatarUrl)?.avatarUrl} />
                <span className="pm-body">
                  <b>{s.name}</b>
                  <span>
                    {s.reasons.join(' · ')} · %{Math.round(s.score * 100)}
                  </span>
                </span>
                <span className="ps-acts">
                  <button type="button" className="btn xs primary b" disabled={!!busy} onClick={() => void act(s.key, () => peopleApi.mergeSuggestion(s.key), `${s.name} birleştirildi`)}>
                    Birleştir
                  </button>
                  <button type="button" className="btn xs b b2" disabled={!!busy} onClick={() => void act(s.key, () => peopleApi.dismiss(s.key))}>
                    Hayır
                  </button>
                </span>
              </div>
              <div className="pm-chips">
                {s.chats.slice(0, 8).map((c) => (
                  <button key={c.id} type="button" className="pm-chip b" title={`${pname(c.platform)} sohbetini aç`} onClick={() => (onSelectChat?.(c.id), onClose())}>
                    <Chip platform={c.platform} size={16} />
                    <span>{chatLabel(c)}</span>
                  </button>
                ))}
                {s.chats.length > 8 && <span className="pm-more">+{s.chats.length - 8}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Listede: aynı kişinin başka kanalları (küçük logolar) */
export function PersonLogos({ chatId, platform }: { chatId: string; platform: Platform }) {
  const { byChat } = usePeople();
  const person = byChat.get(chatId);
  if (!person) return null;
  const others = [...new Set(person.chats.map((c) => c.platform))].filter((p) => p !== platform);
  if (!others.length) return null;
  return (
    <span className="plogos" title={`${person.name}: ${[platform, ...others].map(pname).join(', ')}`} aria-label={`Ayrıca ${others.map(pname).join(', ')}`}>
      {others.slice(0, 3).map((p) => (
        <Chip key={p} platform={p} size={14} />
      ))}
      {others.length > 3 && <span className="plogos-n">+{others.length - 3}</span>}
    </span>
  );
}
