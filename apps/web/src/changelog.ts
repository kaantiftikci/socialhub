/**
 * "Yenilikler" penceresinin içeriği (WhatsNew.tsx). Yeni sürüm çıkarken EN ÜSTE bir kayıt ekle: `id` benzersiz (tarih + sıra),
 * maddeler kullanıcı diliyle kısa (teknik ayrıntı yok). Pencere, kullanıcının son gördüğü kayıttan sonra eklenenleri gösterir.
 * İkon adları ui.tsx `Icon` kümesinden; emoji yazma.
 */
export interface ChangeItem {
  icon: string;
  title: string;
  text: string;
}
export interface ChangeEntry {
  id: string;
  date: string;
  title: string;
  items: ChangeItem[];
}

export const CHANGELOG: ChangeEntry[] = [
  {
    id: '2026-09-30b',
    date: '2026-09-30',
    title: 'Raporun daha derin, bildirimler daha sade',
    items: [
      { icon: 'chart', title: 'Uygulama uygulama rapor', text: 'Raporum’da bir uygulama seç, yalnız onun istatistiklerini gör.' },
      { icon: 'grid', title: 'Tıklanabilir ısı haritası', text: 'Bir saate dokun: o saatte hangi uygulamada, kimle konuştuğunu gör. Artık 24 saatin hepsi yazıyor.' },
      { icon: 'sun', title: 'Günün hangi saatinde', text: 'Sabah, öğle, akşam ve gece payların; hafta içi ile hafta sonu farkın.' },
      { icon: 'bell', title: 'Daha sade bildirim kartı', text: 'Mesajın daha uzun görünür; yanıt kutusu yalnız “Yanıtla” deyince açılır.' },
      { icon: 'play', title: 'TikTok videoları oynuyor', text: 'Sohbette paylaşılan TikTok videoları artık uygulamanın içinde açılıyor.' },
      { icon: 'search', title: 'Medya’da hızlı arama', text: 'Arama kutusu uygulama düğmelerinin yanına taşındı.' },
    ],
  },
  {
    id: '2026-09-30a',
    date: '2026-09-30',
    title: 'Sekiz yeni özellik',
    items: [
      { icon: 'chart', title: 'Raporum', text: 'Ayın ve yılın iletişim özeti; paylaşılabilir, isimsiz kart.' },
      { icon: 'image', title: 'Medya kütüphanesi', text: 'Tüm uygulamalardan gelen fotoğraf, video, dosya ve bağlantılar tek yerde.' },
      { icon: 'users', title: 'Kişi birleştirme', text: 'Aynı kişinin farklı uygulamalardaki sohbetleri tek zaman çizelgesinde.' },
      { icon: 'transcript', title: 'Sesli mesajlar yazıya', text: 'Sesli mesajların altında metni; bilgisayarında, internete gitmeden.' },
      { icon: 'sparkle', title: 'Doğal dille arama', text: '⌘K → Anlamsal: “geçen ay gelen fatura” gibi ara.' },
      { icon: 'send', title: 'Hızlı gönder', text: '⌘⇧K ile her yerden kişi seç, yaz, gönder.' },
      { icon: 'receipt', title: 'Pazaryeri gün sonu', text: 'Günün siparişleri, cirosu ve bekleyen soruları; ürün sorularına AI taslak.' },
    ],
  },
];
