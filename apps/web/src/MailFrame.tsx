import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { mediaUrl } from './desktop';

/* E-postanın özgün HTML gövdesi: betik çalıştırmayan, form göndermeyen iframe (sandbox'ta allow-scripts YOK; aynı köken yalnız
   yüksekliği ölçmek için). İçerik ayrıca CSP ile sınırlı; bağlantılar yeni sekmede açılır. Yüklenemezse düz metin gösterilir. */
const cache = new Map<string, string>();

const CSP = "default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline' *; font-src * data:; media-src * data: blob:";
const BASE_CSS = `html,body{margin:0;padding:0;background:#fff;color:#1f1f1f}
body{padding:14px 16px;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;overflow-wrap:anywhere;overflow-x:auto}
img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}a{color:#1a56db}blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:3px solid #ddd;color:#555}`;

function doc(html: string): string {
  // çekirdeğin yerel ek adresleri (gömülü cid: görselleri): çekirdek adresi + belirteç
  const fixed = html.replace(/(["'(])\/api\/media\/([^"')\s]+)/g, (_m, q: string, rest: string) => q + (mediaUrl('/api/media/' + rest.replace(/&amp;/g, '&')) ?? ''));
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><base target="_blank"><meta name="color-scheme" content="light"><style>${BASE_CSS}</style></head><body>${fixed}</body></html>`;
}

export function MailFrame({ messageId, fallback }: { messageId: string; fallback: string }) {
  const [html, setHtml] = useState<string | null | undefined>(cache.get(messageId));
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(120);

  useEffect(() => {
    if (cache.has(messageId)) return setHtml(cache.get(messageId));
    let dead = false;
    api
      .messageHtml(messageId)
      .then((r) => {
        cache.set(messageId, r.html);
        if (!dead) setHtml(r.html);
      })
      .catch(() => !dead && setHtml(null));
    return () => {
      dead = true;
    };
  }, [messageId]);

  // Yükseklik bir sonraki karede ve yalnız gerçekten değişince yazılır: aynı karede iframe boyunu değiştirmek gözlemciyi yeniden
  // tetikliyordu ("ResizeObserver loop completed with undelivered notifications"). Gövde gözlenir (iframe'e bağlı html değil).
  const raf = useRef(0);
  const measure = () => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const b = ref.current?.contentDocument?.body;
      if (!b) return;
      const next = Math.min(20000, Math.max(40, Math.ceil(b.getBoundingClientRect().height) + 2));
      setH((cur) => (Math.abs(cur - next) > 2 ? next : cur));
    });
  };
  const onLoad = () => {
    measure();
    const d = ref.current?.contentDocument;
    if (!d?.body) return;
    // geç yüklenen görseller yüksekliği değiştirir
    const ro = new ResizeObserver(measure);
    ro.observe(d.body);
    for (const img of Array.from(d.images)) img.addEventListener('load', measure);
    ref.current!.addEventListener('load', () => ro.disconnect(), { once: true });
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  if (html === null) return <div className="mail-body">{fallback}</div>;
  if (html === undefined) return <div className="mail-body mail-loading">{fallback.slice(0, 300)}</div>;
  return (
    <iframe
      ref={ref}
      className="mail-frame"
      title="E-posta içeriği"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={doc(html)}
      style={{ height: h }}
      onLoad={onLoad}
    />
  );
}
