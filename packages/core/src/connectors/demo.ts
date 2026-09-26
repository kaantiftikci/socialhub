import { BaseConnector } from './base.js';
import type { Attachment } from '../model.js';

/**
 * Demo connector: gerçek bir hesap bağlamadan arayüzü denemek için örnek sohbetler
 * üretir ve arada bir "gelen mesaj" simüle eder. `npm run demo` ile açılır.
 */
const PEOPLE = [
  { id: 'deniz', name: 'Deniz Kaya', kind: 'direct' as const, tags: ['müşteri'] },
  { id: 'lansman', name: '#lansman', kind: 'group' as const, tags: ['ekip'] },
  { id: 'ayse', name: 'Ayşe Demir', kind: 'direct' as const, tags: ['fırsat'] },
  { id: 'annem', name: 'Annem', kind: 'direct' as const, tags: ['kişisel'] },
  { id: 'burak', name: 'Burak Şen', kind: 'direct' as const, tags: ['müşteri'] },
  { id: 'elif', name: 'Elif Arslan', kind: 'direct' as const, tags: ['müşteri'] },
  { id: 'can', name: 'Can Öztürk', kind: 'direct' as const, tags: ['müşteri'], daysAgo: 3 },
  { id: 'selin', name: 'Selin Aydın', kind: 'direct' as const, tags: ['fırsat'], daysAgo: 5 },
  { id: 'duyurular', name: 'Şirket duyuruları', kind: 'channel' as const, tags: ['sessiz'], daysAgo: 1 },
];

type Line = [boolean, string, Attachment[]?];
const SCRIPT: Record<string, Line[]> = {
  deniz: [
    [false, 'Merhaba Kaan, teklifi ekiple birlikte inceledik. Genel olarak çok beğendik!'],
    [false, 'Tek sorumuz ikinci fazın teslim tarihi. Mart sonuna yetişir mi?', [{ kind: 'file', name: 'Teklif_v3.pdf', mime: 'application/pdf', size: 1_240_000 }]],
    [true, 'Merhaba Deniz, geri dönüşün için teşekkürler!'],
    [true, 'Anasayfa taslağı v2 · onayına', [{ kind: 'image', name: 'Anasayfa_v2.png', mime: 'image/png', size: 840_000 }]],
    [true, 'İlk iki hafta tasarım onayını alırsak Mart sonu rahat yetişir. Perşembe kısa bir görüşme yapalım mı?'],
    [false, 'Perşembe 14:00 bize uyar. Bu arada sözleşme taslağını bugün gönderebilir misin? Hukuk ekibi hafta sonundan önce bakmak istiyor.'],
  ],
  lansman: [
    [false, 'Emre: Staging ortamı hazır, test linki kanalda.'],
    [false, 'Zeynep: Landing sayfasındaki başlığı bir tık büyütelim mi?'],
    [true, 'Bakıyorum, öğleden sonra dönerim.'],
  ],
  ayse: [[false, 'Merhaba Kaan Bey, profilinizi inceledim. Yapay zekâ danışmanlığı için kısa bir görüşme yapabilir miyiz?']],
  annem: [
    [false, 'Akşam yemeğe geliyor musun?'],
    [false, 'Cevap ver oğlum'],
  ],
  burak: [
    [true, 'Selam Burak, faturayı gönderdiğinde haber ver.'],
    [false, 'Sunucu faturası ekte, kontrol edersen sevinirim.'],
  ],
  elif: [[false, 'Merhaba, Cumartesi 4 kişilik rezervasyon yapabilir miyiz?']],
  can: [
    [false, 'Faturayı aldım, muhasebeye ilettim.'],
    [true, 'Süper, ödeme onayını iletir misin?'],
  ],
  selin: [
    [false, 'Referans yazısı için teşekkürler!'],
    [true, 'Rica ederim Selin, sen de bizim için bir referans yazabilir misin?'],
  ],
  duyurular: [[false, 'Cuma günü ofis 16:00’da kapanacak.']],
};

const LIVE = [
  ['deniz', 'Bir de logoların vektör halini rica edeceğim, baskıya gidecek.'],
  ['lansman', 'Emre: Build yeşil, deploy için onay bekliyoruz.'],
  ['burak', 'Kaan, fatura konusunda dönüş yapabildin mi?'],
  ['ayse', 'Uygun olduğunuz bir gün varsa takvimimi ona göre ayarlarım.'],
];

export class DemoConnector extends BaseConnector {
  private timer?: NodeJS.Timeout;
  private tick = 0;

  async start(): Promise<void> {
    this.setStatus('connected');
    const now = Date.now();
    PEOPLE.forEach((p, i) => {
      const chat = this.upsertChat({ remoteId: p.id, name: p.name, kind: p.kind });
      if (chat.tags.length === 0) this.store.setTags(chat.id, p.tags);
      const lines = SCRIPT[p.id] ?? [];
      const base = now - ((p as { daysAgo?: number }).daysAgo ?? 0) * 86_400_000;
      lines.forEach(([fromMe, text, attachments], j) => {
        const ts = base - (PEOPLE.length - i) * 3_600_000 - (lines.length - j) * 240_000;
        this.upsertMessage({
          remoteChatId: p.id,
          remoteId: `seed-${j}`,
          senderId: fromMe ? 'me' : p.id,
          senderName: fromMe ? 'Ben' : p.name,
          fromMe,
          text,
          ts,
          status: fromMe ? 'read' : 'delivered',
          attachments,
        });
      });
      const last = lines[lines.length - 1];
      if (last && !last[0] && !(p as { daysAgo?: number }).daysAgo) this.upsertChat({ remoteId: p.id, name: p.name, kind: p.kind, unread: p.id === 'lansman' ? 3 : 1 });
    });
    this.timer = setInterval(() => this.live(), 45_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.setStatus('disconnected');
  }

  async sendText(remoteChatId: string, text: string): Promise<{ remoteId: string }> {
    const id = `demo-${Date.now()}`;
    this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'sent' });
    setTimeout(() => {
      this.upsertMessage({ remoteChatId, remoteId: id, senderId: 'me', senderName: 'Ben', fromMe: true, text, ts: Date.now(), status: 'read' });
    }, 1500);
    // E2E aracı (scripts/e2e.mjs) demo çekirdeğiyle sınanabilsin: "#e2e-…" etiketli mesaja karşı taraf 2 sn sonra etiketle cevap verir
    const tag = /#e2e-[a-z0-9]+(?:-g)?/.exec(text)?.[0];
    if (tag && /#e2e-[a-z0-9]+-d\b/.test(text)) return { remoteId: id }; // dönüş mesajına yankı yok
    if (tag) {
      const p = PEOPLE.find((x) => x.id === remoteChatId);
      setTimeout(() => {
        this.upsertMessage({ remoteChatId, remoteId: `echo-${Date.now()}`, senderId: remoteChatId, senderName: p?.name ?? 'Demo', fromMe: false, text: `${tag} dönüş · teşekkürler 👍`, ts: Date.now() - 400, status: 'delivered' }, { live: true });
      }, 2000);
    }
    return { remoteId: id };
  }

  private live(): void {
    const [id, text] = LIVE[this.tick++ % LIVE.length];
    const p = PEOPLE.find((x) => x.id === id)!;
    this.upsertMessage(
      { remoteChatId: id, remoteId: `live-${Date.now()}`, senderId: id, senderName: p.name, fromMe: false, text, ts: Date.now(), status: 'delivered' },
      { live: true },
    );
  }
}
