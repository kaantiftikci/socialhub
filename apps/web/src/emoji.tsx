import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './ui';

/**
 * Emoji seçici: kategori sekmeleri + arama (Türkçe/İngilizce anahtar sözcükler) + "son kullanılanlar" (localStorage).
 * Bağımlılık yok; liste gömülü.
 */
const CATS: Array<{ id: string; label: string; icon: string; list: string }> = [
  { id: 'smileys', label: 'Yüzler', icon: '😀', list: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾' },
  { id: 'gestures', label: 'El', icon: '👍', list: '👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👋 🤚 🖐️ ✋ 🖖 👏 🙌 🤝 🙏 ✍️ 💪 🦾 🫶 🤲 👐 🫡 🫰 🤜 🤛 ✊ 👊' },
  { id: 'hearts', label: 'Kalpler', icon: '❤️', list: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❤️‍🩹 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💯 💢 💥 💫 💦 💨 🕳️ 💬 👁️‍🗨️ 🗨️ 🗯️ 💭 💤' },
  { id: 'objects', label: 'Nesneler', icon: '🎉', list: '🎉 🎊 🎈 🎁 🎂 🍰 🧁 ☕ 🍵 🍺 🍻 🥂 🍷 🍕 🍔 🍟 🌮 🍣 🍜 🍩 🍪 🍫 🍎 🍌 🍇 🍓 🥑 🌸 🌹 🌻 🌷 🌈 ☀️ 🌙 ⭐ 🌟 ✨ ⚡ 🔥 💧 🌊 🎵 🎶 🎧 🎤 🎸 📱 💻 ⌚ 📷 📸 🎥 📺 📚 📖 ✏️ 📝 📌 📎 🔍 🔑 🔒 🔓 💡 🔔 📣 📢 📦 📬 ✉️ 💌 💰 💳 🛒 🛍️ 🎯 🏆 🥇 🎮 🚀 ✈️ 🚗 🚲 🏠 🏢' },
  { id: 'symbols', label: 'Semboller', icon: '✅', list: '✅ ❌ ❎ ✔️ ☑️ ⭕ ❗ ❓ ⚠️ 🚫 ♻️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🔺 🔻 🔶 🔷 ➕ ➖ ➗ ✖️ 💲 ➡️ ⬅️ ⬆️ ⬇️ ↩️ ↪️ 🔁 🔄 ⏰ ⏳ ⌛ 🕐 📅 📆 🆗 🆕 🆓 🔝 🔜 🔚 🏁 🚩 🇹🇷' },
];
const KEYWORDS: Record<string, string> = {
  '👍': 'beğen tamam like ok thumbs', '👎': 'olmaz dislike', '❤️': 'kalp aşk sev heart love', '😂': 'gül komik lol laugh', '🔥': 'ateş fire harika', '👏': 'alkış clap bravo', '😮': 'şaşkın wow', '🎉': 'kutlama parti tebrik party', '✅': 'tamam onay check yes', '❌': 'hayır iptal no x',
  '🙏': 'teşekkür rica pray', '😊': 'gülümse smile', '😢': 'üzgün ağla sad cry', '🤔': 'düşün think', '🚀': 'roket rocket hız', '💯': 'yüz 100', '👀': 'göz bak eyes', '⭐': 'yıldız star', '☕': 'kahve coffee', '🎂': 'doğum günü pasta', '💪': 'güç muscle', '🤝': 'anlaştık el sıkışma deal', '📅': 'takvim tarih', '⏰': 'saat alarm', '💡': 'fikir idea',
};
const RECENT_KEY = 'mivelo.emoji.recent';
function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}
export function rememberEmoji(e: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...readRecent().filter((x) => x !== e)].slice(0, 24)));
  } catch {
    /* yok */
  }
}

export function EmojiPicker({ onPick, onClose, compact = false }: { onPick: (e: string) => void; onClose?: () => void; compact?: boolean }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('recent');
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose?.();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose?.();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const list = useMemo(() => {
    const s = q.trim().toLocaleLowerCase('tr-TR');
    if (s) {
      const all = CATS.flatMap((c) => c.list.split(' '));
      return all.filter((e) => (KEYWORDS[e] ?? '').includes(s) || e === s);
    }
    if (cat === 'recent') return recent.length ? recent : CATS[0].list.split(' ').slice(0, 24);
    return CATS.find((c) => c.id === cat)?.list.split(' ') ?? [];
  }, [q, cat, recent]);
  const pick = (e: string) => {
    rememberEmoji(e);
    setRecent(readRecent());
    onPick(e);
  };
  return (
    <div className={`emoji-pop ${compact ? 'compact' : ''}`} ref={ref} role="dialog" aria-label="Emoji seç">
      <label className="emoji-search">
        <Icon name="search" size={13} />
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ara (gül, kalp, tamam…)" />
      </label>
      {!q && (
        <div className="emoji-cats" role="tablist">
          <button role="tab" aria-selected={cat === 'recent'} className={cat === 'recent' ? 'on' : ''} onClick={() => setCat('recent')} title="Son kullanılanlar">
            🕘
          </button>
          {CATS.map((c) => (
            <button key={c.id} role="tab" aria-selected={cat === c.id} className={cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)} title={c.label}>
              {c.icon}
            </button>
          ))}
        </div>
      )}
      <div className="emoji-grid">
        {list.length === 0 && <span className="emoji-empty">Eşleşen emoji yok</span>}
        {list.map((e, i) => (
          <button key={e + i} type="button" onClick={() => pick(e)} title={KEYWORDS[e]?.split(' ')[0]}>
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
