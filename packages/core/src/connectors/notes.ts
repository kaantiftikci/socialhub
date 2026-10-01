import { BaseConnector } from './base.js';

/**
 * "Kendime not" (Telegram Saved Messages / WhatsApp "Sen" gibi): platforma bağlanmayan tek sohbetlik yerel kanal.
 * Hesap `mivelo` platformunda tek; açılışta registry kendiliğinden ekler (index.ts). Gönderilen her şey yalnız bu
 * cihazdaki veritabanına yazılır; dosya/sesli mesaj da (server /send-file → sendFile) aynı sohbete düşer.
 */
export const NOTES_CHAT = 'notes';

export class NotesConnector extends BaseConnector {
  async start(): Promise<void> {
    this.upsertChat({ remoteId: NOTES_CHAT, name: 'Kendime not', kind: 'direct', handle: 'Yalnız sende' });
    this.setStatus('connected');
  }

  async stop(): Promise<void> {
    this.setStatus('disconnected');
  }

  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    const remoteId = `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.upsertMessage({ remoteChatId: NOTES_CHAT, remoteId, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'read' });
    void remoteChatId;
    return { remoteId };
  }
}
