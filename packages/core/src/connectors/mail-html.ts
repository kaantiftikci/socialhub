/**
 * E-posta HTML gövdesini saklamadan önce temizler. Arayüz gövdeyi betiksiz, formsuz bir iframe'de (sandbox, CSP) gösterir;
 * bu temizlik ikinci savunma hattıdır: betik/çerçeve/nesne/form öğeleri, on* olay öznitelikleri ve javascript: adresleri atılır,
 * göreli adresler için <base> eklenir (tarayıcı yolunda Gmail/Yahoo gövdeleri göreli bağlantı içerebilir).
 */
export function cleanMailHtml(html: string | undefined | null, base?: string): string | undefined {
  if (!html || !html.trim()) return undefined;
  let s = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<(iframe|frame|object|embed|applet|audio|video)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(iframe|frame|frameset|object|embed|applet|meta|link|base)\b[^>]*>/gi, (tag, name: string) =>
      // dış stil dosyaları (link rel=stylesheet) biçim için gerekli olabilir; yalnız onları bırak
      name.toLowerCase() === 'link' && /rel\s*=\s*["']?stylesheet/i.test(tag) && /href\s*=\s*["']?https:/i.test(tag) ? tag : '',
    )
    .replace(/<\/?form\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|action|formaction|xlink:href)\s*=\s*(["']?)\s*(javascript|vbscript|data:text\/html)[^"'>\s]*\2/gi, '$1="#"');
  if (s.length > 1_500_000) s = s.slice(0, 1_500_000);
  return base ? `<base href="${base.replace(/"/g, '')}">${s}` : s;
}
