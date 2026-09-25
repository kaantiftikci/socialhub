/**
 * Demo varlıkları (public/demo/…): normalde sitenin /demo/ klasöründen; tek dosyalık HTML demoda (scripts/demo-html.mjs)
 * dosyaya gömülü base64 haritasından (window.__MIVELO_ASSETS) blob: adresine çevrilerek (yeni sekmede açılabilsin diye).
 */
const cache = new Map<string, string>();

export function demoAsset(p: string): string {
  return publicAsset(`demo/${p}`);
}

/** public/ altındaki dosya (ör. "brands/n11.png"): gömülüyse blob: adresi, değilse /<yol> */
export function publicAsset(p: string): string {
  const map = (globalThis as { __MIVELO_ASSETS?: Record<string, { t: string; d: string }> }).__MIVELO_ASSETS;
  const hit = map?.[p];
  if (!hit) return `/${p}`;
  const cached = cache.get(p);
  if (cached) return cached;
  const bin = atob(hit.d);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: hit.t }));
  cache.set(p, url);
  return url;
}
