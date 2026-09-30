import { api, USE_STATIC } from './api';
import { isTauri } from './desktop';

/**
 * Dosya kaydet (Raporum paylaşım kartı, kütüphaneden seçilenler). Web: <a download>. Masaüstü (Tauri/WKWebView `download`
 * özniteliğini yok sayar): çekirdek İndirilenler klasörüne yazar ve Finder'da gösterir. Dönüş: kullanıcıya gösterilecek kısa metin.
 */
export async function saveBlob(name: string, blob: Blob): Promise<string> {
  if (isTauri && !USE_STATIC) {
    const data = await blobToBase64(blob);
    const r = await api.saveDownload(name, data);
    return `İndirilenler klasörüne kaydedildi: ${r.name}`;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return `${name} indirildi`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('Dosya okunamadı'));
    r.readAsDataURL(blob);
  });
}

/** Paylaşım sayfası (mobil/Safari): dosyayı sistem paylaşımına ver; desteklenmiyorsa false */
export async function shareFile(name: string, blob: Blob, text?: string): Promise<boolean> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (isTauri || !nav.share || !nav.canShare) return false;
  const file = new File([blob], name, { type: blob.type });
  if (!nav.canShare({ files: [file] })) return false;
  try {
    await nav.share({ files: [file], text });
    return true;
  } catch (e) {
    // kullanıcı paylaşım penceresini kapattı: sessiz
    return (e as Error).name === 'AbortError';
  }
}
