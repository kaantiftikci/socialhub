/**
 * "Yenilikler" penceresinin içeriği (WhatsNew.tsx). Yeni sürüm çıkarken EN ÜSTE bir kayıt ekle: `id` benzersiz (tarih + sıra).
 * Maddeler kullanıcı diliyle, iki üç cümle: ne değişti + nerede bulunur / ne işe yarar (teknik ayrıntı yok, emoji yok).
 * Pencere, kullanıcının son gördüğü kayıttan sonra eklenenleri gösterir; maddeler sırayla numaralanır.
 */
export interface ChangeItem {
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
    id: '2026-09-30d',
    date: '2026-09-30',
    title: 'Her uygulamada tepki, daha canlı Miveloji',
    items: [
      { title: 'TikTok, X, Messenger ve iMessage’da tepki', text: 'Mesajın üzerine gelip emoji seçebilirsin. Bu uygulamaların tepki özelliğine dışarıdan ulaşılamadığı için tepki, mesajı alıntılayan kısa bir emoji yanıtı olarak gider; Mivelo’da mesajın altında tepki olarak görünür.' },
      { title: 'Miveloji’de uygulamaya dokun', text: 'Platformlar kartındaki halkaya ya da listedeki bir uygulamaya bastığında tüm rapor o uygulamaya göre değişir. Tekrar basınca ya da “Tümünü göster” ile hepsine dönersin.' },
      { title: 'Günlere göre grafik', text: 'Isı haritasının altında haftanın her günü için bir çubuk var; en yoğun günün ve en sessiz saatin tek bakışta görünüyor.' },
      { title: 'Video önizlemeleri', text: 'Medya kütüphanesinde küçük resmi olmayan videolar artık ilk kareleriyle görünüyor; yalnız ekrana geldiklerinde ve birkaçı birden yükleniyor.' },
    ],
  },
  {
    id: '2026-09-30c',
    date: '2026-09-30',
    title: 'Yepyeni ayarlar',
    items: [
      { title: 'Baştan tasarlanan ayarlar', text: 'Ayarlar artık solda aranabilir, renkli simgeli bölümlerle geliyor. Aradığın ayarın adını yaz; tek dokunuşla o satıra gider ve vurgular. ⌘, (Windows’ta Ctrl+,) ile her yerden açılır.' },
      { title: 'Gizli okuma', text: 'Genel bölümünden açarsan sohbeti okuduğunda karşı tarafa “görüldü” gitmez; mesajlar yalnız Mivelo’da okundu sayılır. Birine hemen dönmek istemediğin anlar için.' },
      { title: 'Daha akıllı bildirimler', text: 'Aynı kişiden art arda gelen mesajlar istersen tek bildirimde toplanır. Okumadığın bir sohbet için belirlediğin süre sonunda bir kez daha hatırlatılırsın.' },
      { title: 'Depolama', text: 'Mivelo’nun bilgisayarında ne kadar yer kapladığını türlere göre görürsün. İndirilmiş eski fotoğraf ve videoları tek tuşla temizleyebilirsin; mesajların silinmez.' },
      { title: 'Görünüm ve yazma', text: 'Açık, koyu ya da sistem teması; arayüz boyutu ve hareketleri azaltma seçenekleri eklendi. Uzun mesaj yazanlar için Enter yerine ⌘+Enter ile gönderme de var.' },
      { title: 'Her uygulamada yanıtla', text: 'Mesajı sağa çekerek ya da “Yanıtla”ya basarak yanıt verme artık TikTok, X, Messenger, LinkedIn ve iMessage’da da var. Bu uygulamalarda mesajın başına kısa bir alıntı satırı eklenir; Mivelo onu balonda alıntı kutusu olarak gösterir.' },
      { title: 'Miveloji', text: 'Raporum’un yeni adı Miveloji: mesajlaşma alışkanlıklarının bilimi. İçerik aynı, ismi artık bizden.' },
      { title: 'Yardım ve Hakkında', text: 'Sık sorulan soruların cevapları, sorun bildirme ve kısayollar listesi artık ayarların içinde. Hakkında bölümünde güncel sürümde olup olmadığını görürsün.' },
    ],
  },
  {
    id: '2026-09-30b',
    date: '2026-09-30',
    title: 'Raporun daha derin, bildirimler daha sade',
    items: [
      { title: 'Uygulama uygulama rapor', text: 'Miveloji’nin (eski adıyla Raporum) üstündeki uygulama düğmelerinden birini seç; tüm sayılar, kişiler ve saatler yalnız o uygulamaya göre yeniden hesaplanır. WhatsApp’ta kimlerle, Instagram’da hangi saatlerde konuştuğunu ayrı ayrı görebilirsin.' },
      { title: 'Dokunulabilen ısı haritası', text: 'Haftanın hangi gün ve saatinde yazıştığını gösteren haritada artık 24 saatin hepsi yazıyor. Bir kareye dokununca o saatte en çok hangi uygulamada ve kimlerle konuştuğun altta açılır.' },
      { title: 'Günün hangi bölümünde', text: 'Isı haritasının altında sabah, öğle, akşam ve gece paylarını görürsün. Hafta içi ile hafta sonu alışkanlıkların da yan yana karşılaştırılır.' },
      { title: 'Daha sade bildirim kartı', text: 'Sağ üstte çıkan mesaj kartında uygulama adı yerine küçük logosu var ve mesajın daha uzun kısmı okunuyor. Yanıt kutusu artık kendiliğinden açılmıyor; “Yanıtla”ya basınca geliyor.' },
      { title: 'TikTok videoları oynuyor', text: 'TikTok sohbetlerinde paylaşılan videolara dokununca artık uygulamanın içinde oynatıcı açılıyor. Tarayıcıya geçmen gerekmiyor.' },
      { title: 'Medya’da hızlı arama', text: 'Medya kütüphanesinde arama kutusu uygulama düğmelerinin hemen yanına taşındı. Bir uygulama seçip aynı satırda dosya adıyla arayabilirsin.' },
    ],
  },
  {
    id: '2026-09-30a',
    date: '2026-09-30',
    title: 'Sekiz yeni özellik',
    items: [
      { title: 'Miveloji', text: 'Ayın ve yılın iletişim özetin: en çok yazıştığın kişiler, en hareketli günlerin, yanıt hızın ve serilerin. İsimleri gizleyip paylaşılabilir bir kart olarak kaydedebilirsin.' },
      { title: 'Medya kütüphanesi', text: 'Tüm uygulamalardan gelen fotoğraf, video, dosya ve bağlantılar tek bir yerde toplanıyor. Türe ve uygulamaya göre süzebilir, bir öğeden doğrudan sohbetine gidebilirsin.' },
      { title: 'Kişi birleştirme', text: 'Aynı kişiyle farklı uygulamalardaki sohbetlerin tek bir zaman çizelgesinde birleşiyor. Mivelo aynı numara ya da e-postayı fark edince birleştirmeyi önerir; onay senden.' },
      { title: 'Sesli mesajlar yazıya', text: 'Sesli mesajların altında okunabilir metni belirir. Döküm senin bilgisayarında yapılır; ses hiçbir sunucuya gönderilmez.' },
      { title: 'Doğal dille arama', text: '⌘K arama penceresinde “Anlamsal”ı açıp “geçen ay gelen fatura” gibi yazman yeterli. Kelimesi kelimesine geçmese de anlamca yakın mesajlar bulunur.' },
      { title: 'Hızlı gönder', text: '⌘⇧K ile hangi ekranda olursan ol kişiyi seç, mesajını yaz, gönder. Sohbeti açman gerekmez; gönderim durumu sağ üstte görünür.' },
      { title: 'Pazaryeri gün sonu', text: 'Mağazan için günün siparişleri, cirosu ve bekleyen soruları her akşam özetlenir. Ürün sorularına geçmiş cevaplarından yararlanan bir yanıt taslağı da hazırlanabilir.' },
    ],
  },
];
