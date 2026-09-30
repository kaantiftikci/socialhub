import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { api } from './api';
import { mediaUrl } from './desktop';
import { PLATFORMS, type Attachment, type LinkPreview, type Platform } from './types';
import type { LibFacets, LibItem, LibKind } from './insights-types';
import { Chip, Icon } from './ui';
import { MediaLightbox, isMediaFileUrl } from './Conversation';
import { saveBlob } from './save-file';

/**
 * Medya ve dosya kütüphanesi: tüm platformlardan fotoğraf, video, dosya, ses ve bağlantılar tek ekranda.
 * Veri çekirdekte ön hesaplanmış `library_items` tablosundan imleçli sayfalarla gelir (packages/core/src/library.ts); demoda
 * demo-insights.ts. Tıklayınca sohbetteki medya penceresi (Lightbox) açılır; bağlantılar da uygulama içinde (yeni sekme yok).
 */

type Tab = 'all' | LibKind;
const TABS: Array<[Tab, string, string]> = [
  ['all', 'Tümü', 'grid'],
  ['image', 'Fotoğraf', 'image'],
  ['video', 'Video', 'play'],
  ['file', 'Dosya', 'file'],
  ['audio', 'Ses', 'mic'],
  ['link', 'Bağlantı', 'link'],
];
const PAGE = 60;

function fmtSize(n?: number): string {
  if (!n) return '';
  if (n > 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' MB';
  if (n > 1e3) return Math.round(n / 1e3) + ' KB';
  return n + ' B';
}
function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
}
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
/** Tarih grubu: Bugün · Dün · Bu hafta · Eylül 2026 */
function groupOf(ts: number, now = new Date()): string {
  const d = new Date(ts);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= start) return 'Bugün';
  if (ts >= start - 86_400_000) return 'Dün';
  const weekStart = start - ((now.getDay() + 6) % 7) * 86_400_000;
  if (ts >= weekStart) return 'Bu hafta';
  if (ts >= weekStart - 7 * 86_400_000) return 'Geçen hafta';
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: new Date(ts).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });

/** Küçük resim adresi (görselin önizlemesi ya da dosyanın kendisi) */
function thumbOf(a: Attachment): string | undefined {
  if (a.url) return mediaUrl(a.url);
  if (a.kind === 'image' && a.link && isMediaFileUrl(a.link)) return mediaUrl(a.link);
  return undefined;
}
/** İndirilebilir dosya adresi (dış sayfa bağlantısı değil) */
function fileOf(it: LibItem): string | undefined {
  const a = it.att;
  if (it.kind === 'link') return undefined;
  if (a.link && !/^https?:\/\//i.test(a.link)) return mediaUrl(a.link);
  if (a.link && isMediaFileUrl(a.link)) return a.link;
  if (it.kind === 'image' && a.url) return mediaUrl(a.url);
  return undefined;
}
function extOf(it: LibItem): string {
  const n = it.name || it.att.name || '';
  const m = /\.([a-z0-9]{1,5})$/i.exec(n);
  if (m) return m[1].toUpperCase();
  if (it.att.mime?.includes('pdf')) return 'PDF';
  return { image: 'JPG', video: 'MP4', audio: 'SES', file: 'DOSYA', link: 'WEB' }[it.kind];
}
const nameOf = (it: LibItem) => it.name || it.att.name || { image: 'Fotoğraf', video: 'Video', audio: 'Sesli mesaj', file: 'Dosya', link: 'Bağlantı' }[it.kind];

/* Bağlantı önizlemesi: yalnız görünen satırlar için, en çok 2 eşzamanlı istek (istek yağmuru yok), önbellekli */
const previewCache = new Map<string, Promise<LinkPreview>>();
const queue: Array<() => void> = [];
let active = 0;
function queued(url: string): Promise<LinkPreview> {
  let p = previewCache.get(url);
  if (p) return p;
  p = new Promise<LinkPreview>((resolve) => {
    const run = () => {
      active++;
      api
        .preview(url)
        .catch(() => ({ url, none: true }) as LinkPreview)
        .then(resolve)
        .finally(() => {
          active--;
          queue.shift()?.();
        });
    };
    if (active < 2) run();
    else queue.push(run);
  });
  previewCache.set(url, p);
  return p;
}
function useVisible<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [vis, setVis] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || vis) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (setVis(true), io.disconnect()), { rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, [vis]);
  return [ref, vis];
}

export function MediaLibrary({ notify, onMenu, onOpenMessage }: { notify: (t: string, err?: boolean) => void; onMenu?: () => void; onOpenMessage: (chatId: string, messageId: string, ts: number) => void }) {
  const [tab, setTab] = useState<Tab>('all');
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [chat, setChat] = useState<string>('');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<LibItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [facets, setFacets] = useState<LibFacets | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const reqRef = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 250);
    return () => clearTimeout(t);
  }, [qInput]);

  // sayılar + dizin durumu (hazırlanıyorsa 3 sn'de bir; hazır olunca liste yenilenir)
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const load = (first: boolean) =>
      api
        .libraryFacets()
        .then((f) => {
          if (!alive) return;
          setFacets((old) => {
            if (!first && old && !old.progress.ready && f.progress.ready) setReload((x) => x + 1);
            return f;
          });
          if (!f.progress.ready) timer = window.setTimeout(() => void load(false), 3000);
        })
        .catch(() => undefined);
    void load(true);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [reload]);

  const query = useMemo(() => ({ kind: tab === 'all' ? undefined : tab, platform: platform ?? undefined, chat: chat || undefined, q: q || undefined, limit: PAGE }), [tab, platform, chat, q]);
  useEffect(() => {
    const id = ++reqRef.current;
    setLoading(true);
    setSel(new Set());
    api
      .library(query)
      .then((p) => {
        if (id !== reqRef.current) return;
        setItems(p.items);
        setNext(p.next);
      })
      .catch((e) => id === reqRef.current && notify((e as Error).message, true))
      .finally(() => id === reqRef.current && setLoading(false));
  }, [query, reload, notify]);

  const loadMore = useCallback(() => {
    if (!next || loading) return;
    const id = ++reqRef.current;
    setLoading(true);
    api
      .library({ ...query, before: next })
      .then((p) => {
        if (id !== reqRef.current) return;
        setItems((old) => [...old, ...p.items.filter((x) => !old.some((o) => o.id === x.id))]);
        setNext(p.next);
      })
      .catch(() => undefined)
      .finally(() => id === reqRef.current && setLoading(false));
  }, [next, loading, query]);

  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = moreRef.current;
    if (!el || !next) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && loadMore(), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [next, loadMore]);

  const groups = useMemo(() => {
    const out: Array<{ label: string; items: Array<{ it: LibItem; i: number }> }> = [];
    const now = new Date();
    items.forEach((it, i) => {
      const g = groupOf(it.ts, now);
      const last = out[out.length - 1];
      if (last?.label === g) last.items.push({ it, i });
      else out.push({ label: g, items: [{ it, i }] });
    });
    return out;
  }, [items]);

  const asList = tab === 'file' || tab === 'audio' || tab === 'link';
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const selecting = sel.size > 0;

  async function downloadSelected() {
    const chosen = items.filter((i) => sel.has(i.id));
    const files = chosen.filter((i) => fileOf(i));
    if (!files.length) return notify('Seçilenlerde indirilebilir dosya yok (bağlantılar indirilemez)', true);
    let ok = 0;
    for (const it of files) {
      try {
        const res = await fetch(fileOf(it)!);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const base = nameOf(it).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'mivelo';
        const ext = /\.[a-z0-9]{1,5}$/i.test(base) ? '' : `.${(blob.type.split('/')[1] ?? 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '')}`;
        await saveBlob(base + ext, blob);
        ok++;
      } catch {
        /* sonraki */
      }
    }
    notify(ok === files.length ? `${ok} dosya indirildi` : `${ok}/${files.length} dosya indirildi`, ok < files.length);
    if (ok) setSel(new Set());
  }

  const kinds = facets?.kinds ?? {};
  const allCount = Object.values(kinds).reduce((a, b) => a + (b ?? 0), 0);
  const cur = open != null ? items[open] : undefined;
  const lbList = useMemo(() => items.map((it) => it.att), [items]);

  return (
    <section className="medialib" aria-label="Medya kütüphanesi">
      <div className="ml-head">
        {onMenu && (
          <button className="btn icon b b2" aria-label="Menü" title="Menü" onClick={onMenu}>
            <Icon name="grip" size={16} sw={2} />
          </button>
        )}
        <div className="ml-title">
          <h1>Medya</h1>
          <span>{facets ? `${allCount.toLocaleString('tr-TR')} öğe · tüm uygulamalardan` : ' '}</span>
        </div>
        <span style={{ flexGrow: 1 }} />
        <label className="ml-search">
          <Icon name="search" size={15} />
          <input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Ada, sohbete göre ara" aria-label="Medyada ara" />
          {qInput && (
            <button type="button" className="b" aria-label="Aramayı temizle" onClick={() => setQInput('')}>
              <Icon name="x" size={12} sw={2} />
            </button>
          )}
        </label>
      </div>

      <div className="ml-filters">
        <div className="tabs ml-tabs" role="tablist" aria-label="Tür">
          {TABS.map(([k, label, icon]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
              <Icon name={icon} size={13} /> {label}
              {facets && <span className="c">{(k === 'all' ? allCount : kinds[k] ?? 0).toLocaleString('tr-TR')}</span>}
            </button>
          ))}
        </div>
        <div className="ml-row2">
          <div className="ml-plats" role="group" aria-label="Uygulama">
            <button className={`ml-pchip b ${!platform ? 'on' : ''}`} onClick={() => setPlatform(null)}>
              Tümü
            </button>
            {(facets?.platforms ?? []).map((p) => (
              <button key={p.platform} className={`ml-pchip b ${platform === p.platform ? 'on' : ''}`} onClick={() => setPlatform(platform === p.platform ? null : p.platform)} title={`${PLATFORMS[p.platform]?.name}: ${p.count}`}>
                <Chip platform={p.platform} size={15} /> {PLATFORMS[p.platform]?.name ?? p.platform}
              </button>
            ))}
          </div>
          <select className="ml-chat" value={chat} onChange={(e) => setChat(e.target.value)} aria-label="Kişi / sohbet">
            <option value="">Tüm kişi ve sohbetler</option>
            {(facets?.chats ?? []).map((c) => (
              <option key={c.chatId} value={c.chatId}>
                {c.name} · {PLATFORMS[c.platform]?.name ?? c.platform} ({c.count})
              </option>
            ))}
          </select>
        </div>
      </div>

      {facets && !facets.progress.ready && (
        <div className="ml-indexing" role="status">
          <span className="spin" /> Kütüphane hazırlanıyor… %{facets.progress.pct} — eski mesajlardaki medya taranıyor, yeni gelenler hemen görünür.
        </div>
      )}
      {selecting && (
        <div className="ml-selbar" role="toolbar" aria-label="Seçim">
          <b>{sel.size} seçili</b>
          <span style={{ flexGrow: 1 }} />
          <button className="btn sm b b2" onClick={() => setSel(new Set(items.map((i) => i.id)))}>
            Tümünü seç
          </button>
          <button className="btn sm primary b" onClick={() => void downloadSelected()}>
            <Icon name="download" size={14} /> İndir
          </button>
          <button className="btn sm icon b b2" aria-label="Seçimi temizle" title="Seçimi temizle" onClick={() => setSel(new Set())}>
            <Icon name="x" size={13} sw={2} />
          </button>
        </div>
      )}

      <div className="ml-body">
        {!loading && items.length === 0 && (
          <div className="ml-empty">
            <span className="ml-empty-ic">
              <Icon name={tab === 'all' ? 'image' : TABS.find(([k]) => k === tab)![2]} size={28} />
            </span>
            <b>{q || platform || chat ? 'Bu süzgeçle sonuç yok' : 'Kütüphane boş'}</b>
            <span>{q || platform || chat ? 'Aramayı ya da süzgeçleri değiştirmeyi dene.' : 'Sohbetlerinde paylaşılan fotoğraf, video, dosya ve bağlantılar burada toplanır.'}</span>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.label} className="ml-group">
            <h3 className="ml-gh">{g.label}</h3>
            {asList ? (
              <div className="ml-list">
                {g.items.map(({ it, i }) => (
                  <ListRow key={it.id} it={it} selected={sel.has(it.id)} selecting={selecting} onToggle={() => toggle(it.id)} onOpen={() => setOpen(i)} onShow={() => onOpenMessage(it.chatId, it.messageId, it.ts)} />
                ))}
              </div>
            ) : (
              <div className="ml-grid">
                {g.items.map(({ it, i }) => (
                  <Tile key={it.id} it={it} selected={sel.has(it.id)} selecting={selecting} onToggle={() => toggle(it.id)} onOpen={() => setOpen(i)} />
                ))}
              </div>
            )}
          </div>
        ))}
        <div ref={moreRef} className="ml-more">
          {loading && <span className="spin" />}
        </div>
      </div>

      {open != null && cur && (
        <>
          <MediaLightbox list={lbList} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
          <div className="ml-lbinfo" role="group" aria-label="Öğe bilgisi">
            <Chip platform={cur.platform} size={16} />
            <span className="t">
              <b>{cur.fromMe ? 'Sen' : cur.senderName || cur.chatName}</b>
              <span>
                {cur.chatName} · {fmtDate(cur.ts)}
              </span>
            </span>
            {fileOf(cur) && (
              <button
                className="ml-lbbtn b"
                onClick={() =>
                  void fetch(fileOf(cur)!)
                    .then((r) => r.blob())
                    .then((b) => saveBlob(nameOf(cur), b))
                    .then((m) => notify(m))
                    .catch((e) => notify((e as Error).message, true))
                }
              >
                <Icon name="download" size={13} /> İndir
              </button>
            )}
            <button className="ml-lbbtn b primary" onClick={() => (setOpen(null), onOpenMessage(cur.chatId, cur.messageId, cur.ts))}>
              <Icon name="thread" size={13} /> Sohbette göster
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Check({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`ml-check ${on ? 'on' : ''}`}
      role="checkbox"
      aria-checked={on}
      aria-label={on ? 'Seçimi kaldır' : 'Seç'}
      onClick={(e) => (e.stopPropagation(), onToggle())}
    >
      {on && <Icon name="check" size={12} sw={3} />}
    </button>
  );
}

function Tile({ it, selected, selecting, onToggle, onOpen }: { it: LibItem; selected: boolean; selecting: boolean; onToggle: () => void; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  const thumb = broken ? undefined : thumbOf(it.att);
  const media = it.kind === 'image' || it.kind === 'video';
  return (
    <div className={`ml-tile ${media ? 'media' : 'doc'} ${selected ? 'sel' : ''}`}>
      <button type="button" className="ml-tile-btn" onClick={selecting ? onToggle : onOpen} title={`${nameOf(it)} · ${it.chatName}`}>
        {media && thumb ? (
          <img src={thumb} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        ) : (
          <span className="ml-doc">
            <span className={`ml-doc-ic k-${it.kind}`}>
              <Icon name={it.kind === 'link' ? 'link' : it.kind === 'audio' ? 'mic' : it.kind === 'video' ? 'play' : it.kind === 'image' ? 'image' : 'file'} size={20} />
            </span>
            <span className="ml-doc-n">{it.kind === 'link' ? hostOf(it.att.page ?? it.att.link ?? '') : nameOf(it)}</span>
            <span className="ml-doc-m">{it.kind === 'link' ? 'Bağlantı' : [extOf(it), fmtSize(it.att.size)].filter(Boolean).join(' · ')}</span>
          </span>
        )}
        {it.kind === 'video' && thumb && (
          <span className="ml-play">
            <Icon name="play" size={16} />
          </span>
        )}
        <span className="ml-src">
          <Chip platform={it.platform} size={14} />
        </span>
      </button>
      <Check on={selected} onToggle={onToggle} />
    </div>
  );
}

function ListRow({ it, selected, selecting, onToggle, onOpen, onShow }: { it: LibItem; selected: boolean; selecting: boolean; onToggle: () => void; onOpen: () => void; onShow: () => void }) {
  const page = it.kind === 'link' ? (it.att.page ?? it.att.link) : undefined;
  const [ref, vis] = useVisible<HTMLDivElement>();
  const [pv, setPv] = useState<LinkPreview | null>(null);
  useEffect(() => {
    if (!page || !vis) return;
    let alive = true;
    void queued(page).then((p) => alive && setPv(p));
    return () => {
      alive = false;
    };
  }, [page, vis]);
  const ok = pv && !pv.none;
  const title = page ? (ok && pv.title) || hostOf(page) : nameOf(it);
  const sub = page ? (ok && pv.site) || hostOf(page) : [extOf(it), fmtSize(it.att.size)].filter(Boolean).join(' · ');
  return (
    <div ref={ref} className={`ml-row ${selected ? 'sel' : ''}`}>
      <Check on={selected} onToggle={onToggle} />
      <button type="button" className="ml-row-btn b" onClick={selecting ? onToggle : onOpen}>
        <span className={`ml-doc-ic k-${it.kind}`}>
          {ok && pv.image ? <img src={pv.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} /> : <Icon name={it.kind === 'link' ? 'link' : it.kind === 'audio' ? 'mic' : 'file'} size={18} />}
        </span>
        <span className="ml-row-t">
          <b>{title}</b>
          <span>
            {sub}
            {page && ok && pv.title ? ` · ${hostOf(page)}` : ''}
          </span>
        </span>
        <span className="ml-row-who">
          <Chip platform={it.platform} size={14} />
          <span>
            <b>{it.fromMe ? 'Sen' : it.senderName || it.chatName}</b>
            <span>
              {it.chatName} · {fmtDate(it.ts)}
            </span>
          </span>
        </span>
      </button>
      <button type="button" className="btn sm icon b b2 ml-row-go" aria-label="Sohbette göster" title="Sohbette göster" onClick={onShow}>
        <Icon name="thread" size={14} />
      </button>
    </div>
  );
}
