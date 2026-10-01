import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Chat, Message } from './types';
import { Avatar, Chip, Icon, fmtDay, fmtTime } from './ui';
import { parseQuoteLine } from './types';

/**
 * İşaretliler (yıldızlı mesajlar; WhatsApp yıldız / Slack "Later" gibi): tüm uygulamalardan, en yeni önce, güne göre gruplu.
 * Yıldız yerel bayraktır (platforma gitmez). `rev` App'ten gelir (message.upsert sayacı) → kısa gecikmeyle yeniden okunur.
 */
export function Starred({ rev, onMenu, onOpenMessage, notify }: { rev: number; onMenu?: () => void; onOpenMessage: (chatId: string, messageId: string, ts: number) => void; notify: (t: string, err?: boolean) => void }) {
  const [items, setItems] = useState<Array<{ message: Message; chat: Chat }> | null>(null);
  const timer = useRef(0);
  useEffect(() => {
    let alive = true;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () => {
        api
          .starred(300)
          .then((r) => alive && setItems(r))
          .catch((e: Error) => alive && (setItems([]), notify(e.message, true)));
      },
      items ? 400 : 0,
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);
  const unstar = (m: Message) => api.setStarred(m.id, false).then(() => setItems((x) => x?.filter((i) => i.message.id !== m.id) ?? x)).catch((e: Error) => notify(e.message, true));
  // güne göre başlıklar
  const groups: Array<{ day: string; list: Array<{ message: Message; chat: Chat }> }> = [];
  for (const it of items ?? []) {
    const day = fmtDay(it.message.ts);
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.list.push(it);
    else groups.push({ day, list: [it] });
  }
  return (
    <div className="st-view">
      <div className="ml-head">
        {onMenu && (
          <button className="btn icon b b2" aria-label="Menü" title="Menü" onClick={onMenu}>
            <Icon name="grip" size={16} sw={2} />
          </button>
        )}
        <div className="ml-title">
          <h1>İşaretliler</h1>
          <span>{items ? (items.length ? `${items.length} yıldızlı mesaj · tüm uygulamalardan` : 'Mesajın üstüne gelip yıldıza bas; burada toplanır') : ' '}</span>
        </div>
      </div>
      <div className="st-body">
        {items && items.length === 0 && (
          <div className="st-empty">
            <Icon name="star" size={28} />
            <p>Henüz yıldızlı mesaj yok. Bir mesajın üstüne gelince çıkan yıldıza bas; adres, kod, karar gibi sonra lazım olacaklar burada durur.</p>
          </div>
        )}
        {groups.map((g) => (
          <section key={g.day} className="st-day">
            <h2>{g.day}</h2>
            {g.list.map(({ message: m, chat }) => {
              const text = parseQuoteLine(m.text)?.rest ?? m.text;
              return (
                <article key={m.id} className="st-item" onClick={() => onOpenMessage(chat.id, m.id, m.ts)} title="Sohbette göster">
                  <Avatar name={chat.name} size={30} url={chat.avatarUrl} />
                  <div className="st-main">
                    <div className="st-top">
                      <Chip platform={chat.platform} size={14} />
                      <b>{chat.name}</b>
                      <span className="st-who">{m.fromMe ? 'Sen' : m.senderName}</span>
                      <time>{fmtTime(m.ts)}</time>
                    </div>
                    <p className="st-text">{text || m.attachments?.[0]?.name || 'Ek'}</p>
                  </div>
                  <button type="button" className="btn icon b st-x" aria-label="Yıldızı kaldır" title="Yıldızı kaldır" onClick={(e) => (e.stopPropagation(), void unstar(m))}>
                    <Icon name="starfill" size={14} />
                  </button>
                </article>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
