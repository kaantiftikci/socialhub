import type { Attachment, Chat, Platform } from './types';
import { PLATFORMS } from './types';

type Line = [fromMe: boolean, text: string, attachments?: Attachment[]];
export interface Script {
  remoteId: string;
  name: string;
  kind: Chat['kind'];
  tags: string[];
  unread: number;
  handle?: string;
  /** public/demo/avatars içindeki dosya adı */
  avatar: string;
  /** Sağ paneldeki Özet kutusu için örnek maddeler */
  summary?: string[];
  /** Sağ paneldeki Not kartı */
  note?: string;
  lines: Line[];
}

const pdf = (name: string, size = 128_440): Attachment => ({ kind: 'file', name, mime: 'application/pdf', size, link: '/demo/files/ornek.pdf' });
const csv = (name: string, size = 18_420): Attachment => ({ kind: 'file', name, mime: 'text/csv', size, link: '/demo/files/siparisler.csv' });
const pic = (name: string, file = 'urun.jpg', size = 140_000): Attachment => ({ kind: 'image', name, mime: 'image/jpeg', size, url: `/demo/files/${file}` });
const vid = (name: string, file: string, poster: string, size: number): Attachment => ({ kind: 'video', name, mime: 'video/mp4', size, link: `/demo/files/${file}`, url: `/demo/files/${poster}` });

/** Bağlı her uygulamanın örnek sohbetleri. Alışveriş kanalları müşteri sorusu olarak yazılır. */
export const SCRIPTS: Partial<Record<Platform, Script[]>> = {
  whatsapp: [
    {
      remoteId: 'ayse', name: 'Ayşe Demir', kind: 'direct', tags: ['müşteri'], unread: 2, handle: '+90 532 000 00 01', avatar: 'ayse.jpg',
      lines: [
        [false, 'Merhaba, dün verdiğim sipariş hâlâ hazırlanıyor görünüyor. Numara 4821.'],
        [true, 'Kontrol ediyorum. Keten gömlek stoğu bu sabah geldi, paket bugün çıkacak.'],
        [false, 'Kargo firması belli mi? Adres Kadıköy, kapıcıya bırakılmasın.'],
        [true, 'Yurtiçi. Kapıya teslim notunu ekledim. Fişi de iletiyorum.'],
        [true, 'Kargo fişi ektedir.', [pdf('kargo-fisi-4821.pdf', 74_200)]],
        [false, 'Teşekkürler. Bir de fatura kesilecek mi, kurumsal istiyorum.'],
        [true, 'Evet, e-fatura yarın kesilir. Unvanı sipariş notuna yazdım.'],
        [false, 'Unvan: Demir Studio. Vergi no’yu az önce mesajda iletmiştim.'],
        [true, 'Aldım, muhasebeye ilettim. Gömleğin son hali ve paketleme videosu da burada.'],
        [true, 'Gömlek.', [pic('gomlek.jpg', 'gomlek.jpg')]],
        [true, 'Paketleme.', [vid('paketleme.mp4', 'paket.mp4', 'gomlek.jpg', 574_823)]],
        [false, 'Süper. Çıkınca takip numarasını da buradan atar mısınız?'],
      ],
    },
    {
      remoteId: 'ekip', name: 'Satış Ekibi', kind: 'group', tags: ['ekip'], unread: 1, avatar: 'ekip.jpg',
      lines: [
        [false, 'Mert: Bu hafta 31 siparişteyiz, geçen haftaya göre 8 fazla.'],
        [false, 'Zeynep: Kampanya görseli hazır, metni hâlâ bekliyorum.'],
        [true, 'Metni bu akşam kapatıyorum. İndirim yalnızca keten seride olsun.'],
        [false, 'Mert: Kupon kodu KETEN15. Stok tablosunu ekledim.'],
        [false, 'Mert: Güncel stok.', [csv('stok-keten.csv')]],
        [false, 'Zeynep: Stories için kare kırpım da lazım, yatay yetmiyor.'],
        [true, 'Kareyi de koydum. Yarın 10:00’da maile çıksın.'],
        [false, 'Zeynep: Tasarım dosyası.', [pdf('kampanya-keten.pdf', 240_110)]],
        [false, 'Mert: Mail listesinden son 30 günde alanları çıkardım.'],
        [true, 'Tamam. Gönderimden önce son okumayı ben yapacağım.'],
      ],
    },
  ],
  telegram: [
    {
      remoteId: 'can', name: 'Can Yılmaz', kind: 'direct', tags: [], unread: 1, handle: '@canyilmaz', avatar: 'can.jpg',
      lines: [
        [false, 'API dokümanını güncelledim. Webhook imzası artık zorunlu.'],
        [true, 'Bakıyorum. Eski istemciler header’sız istek atınca ne dönüyoruz?'],
        [false, '401. Örnek istek ve hata gövdesi PDF’te.'],
        [false, 'İmza örneği.', [pdf('webhook-imza.pdf', 96_300)]],
        [true, 'Tamam, doğrulamayı bu akşam eklerim. Saat farkı için tolerans var mı?'],
        [false, 'Beş dakika. Daha geniş olursa tekrar oynatılabiliyor.'],
        [true, 'Anlaşıldı. Staging’e gece basarım, sabah birlikte bakarız.'],
        [false, 'Sabah 09:30 uygun. Toplantı notunu da kanala bırakırım.'],
        [true, 'Orada olurum.'],
      ],
    },
    {
      remoteId: 'duyuru', name: 'Mivelo Duyurular', kind: 'channel', tags: [], unread: 1, avatar: 'duyuru.jpg',
      lines: [
        [false, 'Mivelo: Sürüm notu: e-posta görünümü ve sağ profil paneli yenilendi.'],
        [false, 'Mivelo: Ayrıntılar ekte.', [pdf('surum-notu.pdf', 88_400)]],
        [false, 'Mivelo: Bakım penceresi cumartesi 03:00–04:00. Bu aralıkta gelen kutusu bir iki dakika gecikebilir.'],
        [false, 'Mivelo: Bildirim sesi artık uygulama bazında seçiliyor. Ayarlar’dan kontrol edin.'],
        [false, 'Mivelo: Bilinen konu: çok uzun ek adları mobilde kırpılıyor, sıradaki sürümde düzelecek.'],
        [false, 'Mivelo: Geri bildirim için bu kanala değil, destek sohbetine yazın.'],
      ],
    },
  ],
  slack: [
    {
      remoteId: 'mert', name: 'Mert Aksoy', kind: 'direct', tags: ['ekip'], unread: 1, handle: '@mert', avatar: 'mert.jpg',
      lines: [
        [false, 'Sprint tahtasında ödeme hatası hâlâ bende görünüyor, sen mi aldın?'],
        [true, 'Aldım. Tekrar deneme sırasında çift çekim oluyormuş, sabah kapattım.'],
        [false, 'Müşteriye dönüş metnini atayım mı, yoksa sen mi yazacaksın?'],
        [true, 'Sen yaz. Tutar iade edildi, fiş ektedir de.'],
        [true, 'İade dekontu.', [pdf('iade-dekontu.pdf', 64_800)]],
        [false, 'İlettim. Yarın stand-up’ta bunu kapatılmış sayalım.'],
        [true, 'Sayalım. Yeni kartı da tahtaya koydum: kargo gecikme şablonu.'],
        [false, 'O şablonu ben akşama doldururum.'],
      ],
    },
    {
      remoteId: 'destek', name: '#destek', kind: 'channel', tags: ['ekip'], unread: 0, avatar: 'duyuru.jpg',
      lines: [
        [false, 'Ece: Trendyol sorularında beden tablosu eski, kim güncelliyor?'],
        [false, 'Mert: Tabloyu bu sabah değiştirdim, dosya burada.'],
        [false, 'Mert: Beden tablosu.', [pdf('beden-tablosu.pdf', 110_200)]],
        [true, 'Mağaza cevaplarına da aynı PDF’i ekleyin, sözle anlatmayalım.'],
        [false, 'Ece: Shopier’daki iade sorusu da aynı tabloya bakıyor, oraya da koyayım.'],
        [true, 'Koy. Üç iş günü içinde cevap sözümüz var, aşmayalım.'],
        [false, 'Ece: Bugünkü kuyruk 14 soru. Akşama sıfırlarım.'],
      ],
    },
  ],
  linkedin: [
    {
      remoteId: 'selin', name: 'Selin Arslan', kind: 'direct', tags: ['fırsat'], unread: 1, handle: 'Selin Arslan', avatar: 'selin.jpg',
      lines: [
        [false, 'Merhaba, perakende operasyonu için kısa dönem danışmanlık arıyoruz.'],
        [true, 'Merhaba Selin. Kapsam sipariş ve müşteri mesajı mı, yoksa ekip kurulumu mu?'],
        [false, 'İkisi de. Özellikle pazaryeri sorularını tek yerden yanıtlamak istiyoruz.'],
        [true, 'Bunu yapıyoruz. Örnek bir haftalık planı ekte ilettim.'],
        [true, 'Haftalık plan.', [pdf('danismanlik-plan.pdf', 156_000)]],
        [false, 'Perşembe 14:00’te 30 dakika ayırabilir misiniz?'],
        [true, 'Uygun. Görüşmede mevcut kuyruğunuzu da görmek isterim.'],
        [false, 'Takvim davetini gönderdim. Görüşürüz.'],
      ],
    },
    {
      remoteId: 'kerem', name: 'Kerem Usta', kind: 'direct', tags: ['müşteri'], unread: 0, handle: 'Kerem Usta', avatar: 'kerem.jpg',
      lines: [
        [false, 'Atölye için toptan keten bakıyoruz, katalog var mı?'],
        [true, 'Var. Minimum 20 adet, termin üç hafta. Katalog ektedir.'],
        [true, 'Toptan katalog.', [pdf('toptan-katalog.pdf', 540_200)]],
        [false, 'Fiyat listesi KDV dahil mi?'],
        [true, 'Hariç. Sipariş formunu doldurursanız proformayı aynı gün keserim.'],
        [false, 'Formu yarına bırakıyorum, renk kartelasını da isteriz.'],
        [true, 'Kartelayı da kataloğun son sayfasına koydum.'],
      ],
    },
  ],
  x: [
    {
      remoteId: 'burak', name: 'burak', kind: 'direct', tags: [], unread: 1, handle: '@burakyazar', avatar: 'burak.jpg',
      lines: [
        [false, 'Yazdığınız kargo yazısını okudum. Kaynakça için notlarınız var mı?'],
        [true, 'Var, kısa bir PDF. Rakamlar Eylül sevkiyatından.'],
        [true, 'Notlar.', [pdf('kargo-notlari.pdf', 72_100)]],
        [false, 'Alıntılayabilir miyim, adınızla?'],
        [true, 'Evet. “Mivelo operasyon notu” diye geçsin yeter.'],
        [false, 'Yarın sabah paylaşırım, linki buradan da atarım.'],
        [true, 'Tamam, bakarım.'],
      ],
    },
    {
      remoteId: 'ece', name: 'ece', kind: 'direct', tags: ['fırsat'], unread: 0, handle: '@ecemedya', avatar: 'ece.jpg',
      lines: [
        [false, 'Ürün çekimi için iki hikâye düşünüyoruz, brief’i atıyorum.'],
        [false, 'Çekim brief’i.', [pdf('cekim-brief.pdf', 210_400)]],
        [true, 'Mekân gün ışığı olsun, ürün saatte tek parça. Tarih 12 Ekim uygun.'],
        [false, '12 Ekim bizde dolu. 14 öğleden sonra?'],
        [true, '14 de olur. Referans kareyi de ekleyeyim.'],
        [true, 'Referans.', [pic('referans.jpg', 'elbise.jpg')]],
        [true, 'Kısa çekim.', [vid('cekim.mp4', 'cicek.mp4', 'elbise.jpg', 1_128_375)]],
        [false, 'Bu açı iyi. Onaylıyorum.'],
      ],
    },
  ],
  imessage: [
    {
      remoteId: 'pinar', name: 'Pınar', kind: 'direct', tags: ['kişisel'], unread: 1, handle: '+90 555 010 20 30', avatar: 'pinar.jpg',
      lines: [
        [false, 'Akşam marketten dönerken şarj aletini alır mısın?'],
        [true, 'Alırım. Hangi uç, USB-C mi?'],
        [false, 'USB-C. Mümkünse iki metrelik olsun.'],
        [true, 'Tamam. Faturayı da isteyeyim, garanti için.'],
        [false, 'İste. Bir de ekmek.'],
        [true, 'Ekmek tamam. Çıkınca yazarım.'],
        [false, 'Kapıda kimse olmayabilir, zili iki kez çal.'],
      ],
    },
    {
      remoteId: 'aile', name: 'Aile', kind: 'group', tags: ['kişisel'], unread: 0, avatar: 'duyuru.jpg',
      lines: [
        [false, 'Anne: Pazar yemeği bizde. Saat bir gibi olun.'],
        [false, 'Emre: Ben biraz gecikebilirim, treni kaçırırsam iki.'],
        [true, 'Ben birde oradayım. Tatlıyı ben getiriyorum.'],
        [false, 'Anne: Alerji listesini yine ekliyorum, unutmayın.'],
        [false, 'Anne: Liste.', [pdf('pazar-menu.pdf', 48_200)]],
        [false, 'Emre: Cevizi gördüm, o tabaktan yemeyeceğim.'],
        [true, 'Tamam, ayrı bir kâse ayırırım.'],
      ],
    },
  ],
  instagram: [
    {
      remoteId: 'selin', name: 'selin.tasarim', kind: 'direct', tags: ['fırsat'], unread: 1, handle: '@selin.tasarim', avatar: 'selin.jpg',
      lines: [
        [false, 'İş birliği için yazıyorum, keten serinizi beğendim.'],
        [true, 'Teşekkürler. Nasıl bir paylaşım düşünüyorsun?'],
        [false, 'Üç hikâye ve bir reels. Çekim bende, ürün sizden gider.'],
        [true, 'Uygun. Medya kitini ve yayın tarihini iletebilir misin?'],
        [false, 'Kit ektedir. Yayın 18 Ekim.'],
        [false, 'Medya kiti.', [pdf('medya-kiti.pdf', 320_800)]],
        [true, 'Baktım. Ürünleri çarşamba kargolarım, beden S ve M.'],
        [false, 'S ve M tamam. Kapak karesini önceden onayınıza sunarım.'],
        [true, 'Öyle yapalım. Anlaşma notunu da PDF’ye ekledim.'],
        [true, 'İş birliği notu.', [pdf('isbirligi-notu.pdf', 88_000)]],
      ],
    },
    {
      remoteId: 'deniz', name: 'deniz_87', kind: 'direct', tags: ['müşteri'], unread: 2, handle: '@deniz_87', avatar: 'deniz.jpg',
      lines: [
        [false, 'Bu gömlek 38 beden var mı, dar kalıp mı?'],
        [true, '38 var. Kalıp normal, göğüste bol durmasın diye bir beden büyük alma.'],
        [false, 'Boyum 178, kilo 74. Hangi beden rahat olur?'],
        [true, 'Sana 38 olur. Tabloyu bırakıyorum.'],
        [true, 'Beden tablosu.', [pdf('beden-tablosu.pdf', 110_200)]],
        [false, 'Kumaşın yakın fotoğrafı da var mı, keten mi pamuk mu?'],
        [true, 'Yüzde yüz keten. Yakın kare ve kısa video:'],
        [true, 'Kumaş.', [pic('keten-kumas.jpg', 'kumas.jpg')]],
        [true, 'Ürün videosu.', [vid('urun.mp4', 'cicek.mp4', 'gomlek.jpg', 1_128_375)]],
        [false, 'Tamam, birazdan siteden geçeceğim. İndirim kodu var mı?'],
        [true, 'INSTA10, bu akşam bitiyor.'],
      ],
    },
  ],
  messenger: [
    {
      remoteId: 'elif', name: 'Elif Kaya', kind: 'direct', tags: ['müşteri'], unread: 1, handle: 'Elif Kaya', avatar: 'elif.jpg',
      lines: [
        [false, 'Merhaba, mağazadaki ilanı gördüm. Ürün hâlâ duruyor mu?'],
        [true, 'Duruyor. Hangi parça, keten gömlek mi?'],
        [false, 'Evet, ekru renk. İstanbul içi bugün kargo olur mu?'],
        [true, 'Saat 15’e kadar onaylarsan bugün çıkar. Ürün fotoğrafı:'],
        [true, 'Ekru gömlek.', [pic('gomlek-ekru.jpg', 'gomlek.jpg')]],
        [false, 'Bu renk iyi. Adresimi sipariş notuna yazdım.'],
        [true, 'Gördüm. Çıkınca takip linkini buradan atarım.'],
        [false, 'Teşekkürler, bekliyorum.'],
      ],
    },
    {
      remoteId: 'nisa', name: 'Nisa', kind: 'direct', tags: ['kişisel'], unread: 0, handle: 'Nisa', avatar: 'nisa.jpg',
      lines: [
        [false, 'Sunum dosyasını masaüstünde unutmuşum, atabilir misin?'],
        [true, 'Atıyorum. Son sayfadaki rakamı sen güncelle, bende eski.'],
        [true, 'Sunum.', [pdf('lansman-sunum.pdf', 1_240_000)]],
        [false, 'Aldım. Kapanış slaytındaki tarih 15 Ekim olarak kalsın mı?'],
        [true, 'Kalsın. Basın bülteni de aynı tarihe bağlı.'],
        [false, 'Tamam, akşam 7’deki provada beraber bakarız.'],
      ],
    },
  ],
  gmail: [
    {
      remoteId: 'fatura', name: 'Eylül faturanız hazır', kind: 'direct', tags: [], unread: 1, handle: 'fatura@bulutdepo.example', avatar: 'fatura.jpg',
      lines: [
        [false, 'Merhaba,\n\nEylül ayı faturanız ektedir. Toplam 1.250,00 TL.\n\nBulut Depo', [pdf('fatura-eylul.pdf', 84_212)]],
        [true, 'Teşekkürler. Kalemde “ek depolama” görüyorum, bu hangi günler?'],
        [false, '12–18 Eylül arası ek 40 GB. Döküm ektedir.', [csv('depolama-dokum.csv')]],
        [true, 'Döküm uyuyor. Ödemeyi cuma yapacağız, dekontu iletirim.'],
        [false, 'Cuma uygun. Gecikme faizi ancak ayın 10’undan sonra işler.'],
        [true, 'Yetişir. Faturayı muhasebe klasörüne aldım.'],
      ],
    },
    {
      remoteId: 'toplanti', name: 'Toplantı özeti — lansman', kind: 'direct', tags: ['ekip'], unread: 0, handle: 'melis@nova.example', avatar: 'melis.jpg',
      lines: [
        [false, 'Lansman 15 Ekim. Basın bülteni bu hafta çıksın istedik.\n\nGündem ekte.\n\nMelis', [pdf('toplanti-gundem.pdf', 66_400)]],
        [true, 'Bülteni yarına bırakıyorum. Alıntı izinleri tamam.'],
        [false, 'Fotoğraf seçimini de bugün kapatalım, üç kare yeterli.'],
        [true, 'Seçtiklerimi ekledim.', [pic('lansman-kare.jpg', 'elbise.jpg')]],
        [false, 'İkinci kare iyi. Bülten taslağını görünce son bir tur atarım.'],
        [true, 'Taslak sabah 9’da posta kutusunda olur.'],
      ],
    },
  ],
  outlook: [
    {
      remoteId: 'teklif', name: 'Teklif: operasyon kurulumu', kind: 'direct', tags: ['fırsat'], unread: 1, handle: 'ayse.demir@nova.example', avatar: 'ayse.jpg',
      lines: [
        [false, 'Merhaba,\n\nKonuştuğumuz kapsam için teklif ektedir. Süre altı hafta.\n\nAyşe Demir', [pdf('teklif-nova.pdf', 188_600)]],
        [true, 'Teşekkürler. Üçüncü kalemdeki eğitim gün sayısı ikiye inebilir mi?'],
        [false, 'İner. Revize teklif ve taslak sözleşme ektedir.', [pdf('sozlesme-taslak.pdf', 240_000)]],
        [true, 'Hukuk bugün bakacak. İmza için cuma uygun.'],
        [false, 'Cuma 11:00’i tuttum. Eksik evrak olursa listeyi ayrıca atarım.'],
        [true, 'Tamam, takvimde görüyorum.'],
      ],
    },
    {
      remoteId: 'destek', name: 'Destek talebi #441', kind: 'direct', tags: ['müşteri'], unread: 0, handle: 'destek@nova.example', avatar: 'emre.jpg',
      lines: [
        [false, 'Kullanıcı davet postası spam klasörüne düşüyor. Kayıt ekte.', [pdf('mail-kaydi.pdf', 54_300)]],
        [true, 'SPF kaydınız eksik görünüyor. Ekleyeceğiniz satırı yazdım.'],
        [false, 'Ekledik. Yeniden denemede yine spam.'],
        [true, 'DKIM anahtarını da açmanız gerekiyor. Yarın sabah birlikte test edelim.'],
        [false, '09:00 uygun. Teşekkürler.'],
      ],
    },
  ],
  yahoo: [
    {
      remoteId: 'siparis', name: 'Siparişiniz alındı', kind: 'direct', tags: ['müşteri'], unread: 1, handle: 'siparis@dukkan.example', avatar: 'fatura.jpg',
      lines: [
        [false, 'Merhaba Deniz,\n\n4821 numaralı siparişiniz alındı. Özet ektedir.', [pdf('siparis-4821.pdf', 61_200)]],
        [true, 'Adres satırında daire no yok, 6/2 olarak düzeltir misiniz?'],
        [false, 'Düzelttim. Kargo yarın çıkacak, etiket ektedir.', [pdf('kargo-etiket.pdf', 44_800)]],
        [true, 'Teşekkürler. Faturayı da aynı adrese değil, e-posta ile istiyorum.'],
        [false, 'E-fatura kesildiğinde bu yazışmaya düşecek.'],
      ],
    },
    {
      remoteId: 'bulten', name: 'Ekim bülteni', kind: 'direct', tags: [], unread: 0, handle: 'bulten@dukkan.example', avatar: 'melis.jpg',
      lines: [
        [false, 'Ekim seçkisi hazır. Ürün listesi ve fiyatlar ektedir.', [csv('ekim-secisi.csv')]],
        [true, 'Üçüncü sıradaki kupa stokta yoktu, listeden düşün.'],
        [false, 'Düştüm. Güncel dosya:', [csv('ekim-secisi-v2.csv')]],
        [true, 'Bu haliyle cuma gönderilebilir.'],
      ],
    },
  ],
  icloud: [
    {
      remoteId: 'okan', name: 'Okan', kind: 'direct', tags: ['kişisel'], unread: 1, handle: 'okan@icloud.example', avatar: 'emre.jpg',
      lines: [
        [false, 'Hafta sonu için evin anahtarını nereye bıraktığını yazmamışsın.'],
        [true, 'Komşuda, 4 numarada. Notu da fotoğrafladım.'],
        [true, 'Not.', [pic('anahtar-notu.jpg', 'kumas.jpg')]],
        [false, 'Gördüm. Çiçekleri de sularım.'],
        [true, 'Sağ ol. Market listesi duruyorsa onu da halledersin.'],
        [false, 'Listede yalnızca süt ve ekmek var, tamam.'],
      ],
    },
    {
      remoteId: 'not', name: 'Ortak notlar', kind: 'direct', tags: [], unread: 0, handle: 'notlar@icloud.example', avatar: 'pinar.jpg',
      lines: [
        [false, 'Tatil taslağını güncelledim. Uçuş PDF’te.'],
        [false, 'Uçuş.', [pdf('ucus-bilgi.pdf', 77_500)]],
        [true, 'Dönüş 19:40 iyi. Otel onayını da ekler misin?'],
        [false, 'Ekledim.', [pdf('otel-onay.pdf', 69_100)]],
        [true, 'İkisi de duruyor, tamam.'],
      ],
    },
  ],
  imap: [
    {
      remoteId: 'muhasebe', name: 'Eylül mutabakat', kind: 'direct', tags: ['ekip'], unread: 1, handle: 'muhasebe@atolye.example', avatar: 'fatura.jpg',
      lines: [
        [false, 'Merhaba,\n\nEylül mutabakatı ektedir. İki kalem açıkta.\n\nMuhasebe', [pdf('mutabakat-eylul.pdf', 132_000)]],
        [true, 'Açık kalemlerden 7781 iade edildi, dekontu iletiyorum.'],
        [true, 'Dekont.', [pdf('dekont-7781.pdf', 58_400)]],
        [false, 'İşlendi. Kalan tek kalem kargo farkı, 86 TL.'],
        [true, 'Onu da bu hafta kapatırız. Güncel dökümü CSV olarak atayım.'],
        [true, 'Döküm.', [csv('mutabakat.csv')]],
        [false, 'CSV uyuyor. Teşekkürler.'],
      ],
    },
    {
      remoteId: 'kurumsal', name: 'Kurumsal destek', kind: 'direct', tags: [], unread: 0, handle: 'it@atolye.example', avatar: 'mert.jpg',
      lines: [
        [false, 'Posta kutusu doluluk uyarısı veriyor. Kota artışı için onay gerekir.'],
        [true, '20 GB artırın. Onay formunu imzalayıp ekliyorum.'],
        [true, 'Onay.', [pdf('kota-onay.pdf', 41_200)]],
        [false, 'İşleme alındı. Bu akşam yansır.'],
        [true, 'Tamam, yarın kontrol ederim.'],
      ],
    },
  ],
  shopier: [
    {
      remoteId: 'elif', name: 'Elif Kaya · sipariş 4821', kind: 'direct', tags: ['müşteri'], unread: 2, handle: 'Elif Kaya', avatar: 'elif.jpg',
      lines: [
        [false, 'Merhaba, 4821 numaralı siparişimde beden yanlış seçmiş olabilirim. M ile S arasındaki fark ne?'],
        [true, 'Merhaba Elif. Gömlekte M, göğüste 4 cm daha bol. Boyunuz 165 civarıysa S rahat olur.'],
        [false, '165, 58 kilo. S’e çevirebilir misiniz, kargo çıkmadan?'],
        [true, 'Çevirdim, henüz paketlenmemişti. Beden tablosunu da bırakıyorum.'],
        [true, 'Beden tablosu.', [pdf('beden-tablosu.pdf', 110_200)]],
        [false, 'Teşekkürler. Fatura bireysel kalsın, kargo yarın mı çıkar?'],
        [true, 'Yarın öğleden önce Yurtiçi’ne verilir. Çıkınca kodu buraya yazacağım.'],
        [false, 'Adreste kapıcıya bırakılmasın, not düşer misiniz?'],
        [true, 'Düştüm. Başka sorunuz olursa bu siparişten yazmanız yeterli.'],
      ],
    },
    {
      remoteId: 'kerem', name: 'Kerem Aydın · iade', kind: 'direct', tags: ['müşteri'], unread: 1, handle: 'Kerem Aydın', avatar: 'kerem.jpg',
      lines: [
        [false, 'Kupa çatlamış geldi, fotoğrafını çektim. İade etmek istiyorum.'],
        [false, 'Fotoğraf.', [pic('hasarli-kupa.jpg', 'kupa.jpg')]],
        [false, 'Bir de kısa video çektim.', [vid('kupa.mp4', 'paket.mp4', 'kupa.jpg', 574_823)]],
        [true, 'Üzüldüm, değişim ya da iade yapabiliriz. Hangisini istersiniz?'],
        [false, 'İade olsun. Ücret karta geri döner mi?'],
        [true, 'Evet, ürün bize ulaşınca 3 iş günü. Form ektedir, kargo ücretsiz.'],
        [true, 'İade formu.', [pdf('iade-formu.pdf', 52_600)]],
        [false, 'Formu doldurdum. Kodu nereye yazacağım?'],
        [true, 'Shopier iade kodunu paketin üstüne yazmanız yeterli. Takip numarasını da buraya bırakın.'],
        [false, 'Yarın veririm, numarayı akşam atarım.'],
      ],
    },
  ],
  trendyol: [
    {
      remoteId: 'soru-kalip', name: 'Müşteri sorusu · keten elbise', kind: 'direct', tags: ['müşteri'], unread: 1, handle: 'Deniz K.', avatar: 'deniz.jpg',
      lines: [
        [false, 'Bu elbise kalıp olarak dar mı? 38 beden alıyorum normalde, yorumlarda küçük duruyor demişler.'],
        [true, 'Kalıp regular. 38 beden giyiyorsanız 38 alın. Göğüs ve bel ölçüleri tabloda.'],
        [true, 'Beden tablosu.', [pdf('beden-tablosu.pdf', 110_200)]],
        [false, 'Boyum 170, kilo 62. Yine 38 mi?'],
        [true, 'Evet, 38. Boy option’ı standart, 162–175 arasına göre kesildi.'],
        [false, 'Kumaş kırışıyor mu, ütü istiyor mu?'],
        [true, 'Keten olduğu için kırışır, bu dokusunun parçası. Nemli ütüyle düzelir. Yakın kare:'],
        [true, 'Kumaş.', [pic('keten-kumas.jpg', 'kumas.jpg')]],
        [true, 'Elbise videosu.', [vid('elbise.mp4', 'cicek.mp4', 'elbise.jpg', 1_128_375)]],
        [false, 'Anladım, teşekkürler. Siparişi bu akşam geçeceğim.'],
      ],
    },
    {
      remoteId: 'soru-kargo', name: 'Sipariş 1042931 · kargo', kind: 'direct', tags: ['müşteri'], unread: 1, handle: 'Nisa A.', avatar: 'nisa.jpg',
      lines: [
        [false, 'Sipariş 1042931 üç gündür kargoya verilmedi yazıyor. Ne zaman çıkar?'],
        [true, 'Merhaba. Ürün dün depoya indi, bugün 16:00’ya kadar çıkacak.'],
        [false, 'Hangi kargo? Adres Ankara, Çankaya.'],
        [true, 'Trendyol Express. Etiket hazır, fişi iletiyorum.'],
        [true, 'Kargo fişi.', [pdf('kargo-1042931.pdf', 48_900)]],
        [false, 'Faturayı da görebilir miyim, kurumsal kesecektim.'],
        [true, 'Kurumsal bilgi siparişte yoktu. Unvan ve vergi numarasını yazarsanız bugün keseriz.'],
        [false, 'Unvan: Ada Studio, vergi no mesajda. Teşekkürler.'],
        [true, 'Aldım, faturayı kesince buraya PDF olarak bırakacağım.'],
      ],
    },
  ],
  hepsiburada: [
    {
      remoteId: 'soru-renk', name: 'Soru · ekru / bej', kind: 'direct', tags: ['müşteri'], unread: 2, handle: 'Pınar S.', avatar: 'pinar.jpg',
      lines: [
        [false, 'İlandaki ekru ile bej aynı mı? Ekranda ikisi de açık duruyor.'],
        [true, 'Aynı ürün değil. Ekru daha sıcak, bej griye yakın. Yan yana kare:'],
        [true, 'Renk karşılaştırması.', [pic('renk-ekru-bej.jpg', 'elbise.jpg')]],
        [false, 'Ekru istiyorum. Stokta 36 var mı?'],
        [true, '36 ekru var, 4 adet. Bej 36 tükendi.'],
        [false, 'Bugün sipariş versem pazartesi gelir mi, İzmir.'],
        [true, 'Hepsijet ile genellikle ertesi gün. Kesin söz veremeyiz, çıkıştan sonra süre işler.'],
        [false, 'Tamam, ekru 36 geçiyorum.'],
      ],
    },
    {
      remoteId: 'soru-fatura', name: 'Soru · fatura 77812', kind: 'direct', tags: ['müşteri'], unread: 0, handle: 'Emre T.', avatar: 'emre.jpg',
      lines: [
        [false, '77812 numaralı siparişin faturası mailime düşmedi. Yeniden gönderebilir misiniz?'],
        [true, 'Gönderiyorum. Kurumsal mı bireysel mi kesilmişti?'],
        [false, 'Bireysel. Ama muhasebe PDF istiyor, link yetmiyor.'],
        [true, 'PDF ektedir.', [pdf('fatura-77812.pdf', 79_400)]],
        [false, 'Geldi, teşekkürler. İade olursa bu fatura ile mi işlem açacağım?'],
        [true, 'Evet, iade talebinde fatura numarası yeterli. 14 gününüz var.'],
      ],
    },
  ],
  etsy: [
    {
      remoteId: 'lina', name: 'Lina · kolye bakımı', kind: 'direct', tags: ['müşteri'], unread: 1, handle: 'Lina M.', avatar: 'ece.jpg',
      lines: [
        [false, 'Merhaba, kolye günlük kullanıma uygun mu, duşta çıkarmalı mıyım?'],
        [true, 'Merhaba Lina. Altın kaplama, duşta ve parfüm sonrası takmayın. Ömrü uzar.'],
        [false, 'Deniz suyunda? Tatilde takmak istiyorum.'],
        [true, 'Deniz suyunda çıkarın. Bakım notunu ekliyorum, kutusuna da aynı kâğıt gidiyor.'],
        [true, 'Bakım notu.', [pdf('kolye-bakim.pdf', 46_200)]],
        [true, 'Kolye.', [pic('kolye.jpg', 'kolye.jpg')]],
        [true, 'Ürün videosu.', [vid('kolye.mp4', 'cicek.mp4', 'kolye.jpg', 1_128_375)]],
        [false, 'Zincir uzatma istiyorum, 5 cm mümkün mü?'],
        [true, 'Mümkün, sipariş notuna yazın ya da buradan onay verin, ücretsiz ekleriz.'],
        [false, 'Onaylıyorum, 5 cm uzatma olsun.'],
        [true, 'İşlemi siparişe ekledim. Kargoya yarın verilir.'],
      ],
    },
    {
      remoteId: 'gecikme', name: 'Sipariş gecikmesi · 2291', kind: 'direct', tags: ['müşteri'], unread: 1, handle: 'Jonas K.', avatar: 'burak.jpg',
      lines: [
        [false, '2291 numaralı sipariş tahmini tarihi geçti. Nerede acaba?'],
        [true, 'Merhaba. Parça atölyede, sıradan bir gün kaydı. Yarın kargoya veriyoruz.'],
        [false, 'Hediye, cuma lazım. Yetişir mi?'],
        [true, 'Yurt içi ise cuma gelir. Yurt dışı bu tarihe yetişmez, onu baştan söyleyeyim.'],
        [false, 'Yurt içi, Ankara. Tamam.'],
        [true, 'Etiketi kestik. Fiş ektedir, takip yarın akşam düşer.'],
        [true, 'Kargo fişi.', [pdf('kargo-2291.pdf', 51_000)]],
        [false, 'Teşekkürler, cuma kontrol ederim.'],
      ],
    },
  ],
  shopify: [
    {
      remoteId: 'odeme', name: 'Ödeme sorunu · #1088', kind: 'direct', tags: ['müşteri'], unread: 1, handle: 'ayca@posta.example', avatar: 'nisa.jpg',
      lines: [
        [false, 'Sepeti onaylıyorum ama kart çekilmeden hata veriyor. Sipariş oluştu mu?'],
        [true, '1088 taslak olarak duruyor, çekim yok. Hangi kart, ticari mi?'],
        [false, 'Bireysel, 3D doğrulama ekranı açılmadan dönüyor.'],
        [true, 'Bunu banka kesiyor. Linki yeniledim, bu bağlantıdan tekrar deneyin. Olmazsa havale de olur.'],
        [false, 'Havale yapayım. IBAN ve açıklamayı yazar mısınız?'],
        [true, 'Açıklamaya 1088 yazın. Bilgi formu ektedir.', [pdf('havale-bilgi.pdf', 38_700)]],
        [false, 'Az önce gönderdim. Dekontu da ekleyeyim.'],
        [false, 'Dekont.', [pdf('dekont-1088.pdf', 61_500)]],
        [true, 'Dekont geldi, siparişi ödemesi alındı diye işaretledim. Yarın kargoda.'],
      ],
    },
    {
      remoteId: 'toptan', name: 'Toptan sorusu', kind: 'direct', tags: ['fırsat'], unread: 0, handle: 'kerem@atolye.example', avatar: 'kerem.jpg',
      lines: [
        [false, 'Mağazanızdan toptan almak istiyoruz. Minimum adet ve iskonto nedir?'],
        [true, '20 adetten itibaren yüzde 15. Katalog ve güncel fiyat ektedir.'],
        [true, 'Katalog.', [pdf('toptan-katalog.pdf', 540_200)]],
        [false, 'Keten gömlekten 20 ekru, 10 bej düşünüyoruz. Termin?'],
        [true, 'Üç hafta. Renk kırılımını onaylarsanız proformayı bugün keserim.'],
        [false, 'Onaylıyorum. Fatura atölye unvanına kesilsin, bilgileri katalogdaki forma yazdım.'],
        [true, 'Proforma akşam posta kutunuzda olur. Sorunuz olursa bu yazışmadan devam edelim.'],
      ],
    },
  ],
  amazon: [
    {
      remoteId: 'alici-kargo', name: 'Alıcı · sipariş 405-8821943', kind: 'direct', tags: ['müşteri'], unread: 1, handle: 'Selin A.', avatar: 'selin.jpg',
      lines: [
        [false, 'Merhaba, 405-8821943-221 numaralı siparişim dün teslim edildi görünüyor ama kutu bana gelmedi.'],
        [true, 'Merhaba. Takip koduna göre bina görevlisine bırakılmış. Kapıcıya sordunuz mu?'],
        [false, 'Sordum, onda yok. Fotoğraftaki kapı da bizim değil.'],
        [true, 'Yanlış adrese bırakılmış. Yenisini bugün çıkarıyorum, eskisini aramanıza gerek yok.'],
        [true, 'Yeni kargo fişi.', [pdf('amazon-kargo-405.pdf', 52_400)]],
        [false, 'Teşekkürler. Bu sefer kapıya teslim olsun, görevliye bırakılmasın.'],
        [true, 'Notu siparişe işledim. Takip kodu düşünce buradan yazacağım.'],
      ],
    },
    {
      remoteId: 'iade-beden', name: 'İade · beden uyumsuz', kind: 'direct', tags: ['müşteri'], unread: 1, handle: 'Emre K.', avatar: 'emre.jpg',
      lines: [
        [false, 'Gömlek dar geldi, iade etmek istiyorum. Sipariş 112-4402918-773.'],
        [true, '30 gün içinde iade açık. Etiketi Seller Central’dan kesiyorum, ücreti biz karşılıyoruz.'],
        [true, 'İade etiketi.', [pdf('amazon-iade-112.pdf', 48_100)]],
        [false, 'Aynı modeli bir büyük alabilir miyim, yoksa para iadesi mi?'],
        [true, 'L stokta var. İade depoya düşünce yeni siparişi ben oluştururum, kartınıza fark yansımaz.'],
        [true, 'Beden karşılaştırması.', [pic('beden.jpg', 'gomlek.jpg')]],
        [false, 'L olsun. Etiketi bugün yapıştırıp veriyorum.'],
        [true, 'Tamam. Ürün bize ulaşınca L’yi aynı adrese çıkarırız.'],
      ],
    },
  ],
};

const FOLK: Array<{ id: string; name: string; avatar: string; user: string }> = [
  { id: 'leyla', name: 'Leyla Koç', avatar: 'ayse.jpg', user: 'leylako' },
  { id: 'tarik', name: 'Tarık Uçar', avatar: 'can.jpg', user: 'tarikucar' },
  { id: 'beren', name: 'Beren Ak', avatar: 'selin.jpg', user: 'berenak' },
  { id: 'cem', name: 'Cem Polat', avatar: 'mert.jpg', user: 'cempolat' },
  { id: 'defne', name: 'Defne Sarı', avatar: 'elif.jpg', user: 'defnesari' },
  { id: 'onur', name: 'Onur Bilgin', avatar: 'burak.jpg', user: 'onurbilgin' },
  { id: 'asli', name: 'Aslı Er', avatar: 'nisa.jpg', user: 'aslier' },
  { id: 'koray', name: 'Koray Demir', avatar: 'emre.jpg', user: 'koraydemir' },
  { id: 'yalcin', name: 'Ece Yalçın', avatar: 'ece.jpg', user: 'eceyalcin' },
  { id: 'solmaz', name: 'Pınar Solmaz', avatar: 'pinar.jpg', user: 'pinarsolmaz' },
  { id: 'sen', name: 'Kerem Şen', avatar: 'kerem.jpg', user: 'keremsen' },
  { id: 'ari', name: 'Melis Arı', avatar: 'melis.jpg', user: 'melisari' },
  { id: 'kurt', name: 'Deniz Kurt', avatar: 'deniz.jpg', user: 'denizkurt' },
  { id: 'sevgi', name: 'Sevgi Han', avatar: 'fatura.jpg', user: 'sevgihan' },
];

const PER_APP = 9;

function handleFor(platform: Platform, folk: (typeof FOLK)[number], n: number): string | undefined {
  const cat = PLATFORMS[platform].category;
  if (cat === 'mail') return `${folk.user}@posta.example`;
  if (cat === 'shop') return folk.name;
  if (platform === 'whatsapp' || platform === 'imessage') return `+90 53${n % 10} ${200 + n} 40 ${String(10 + n).padStart(2, '0')}`;
  if (platform === 'slack') return `@${folk.user}`;
  if (platform === 'linkedin') return folk.name;
  return `@${folk.user}`;
}

/** Var olan iki örneğin üstüne, uygulamaya uygun ek sohbetler. Alışverişte hepsi müşteri sorusu. */
function extraScripts(platform: Platform, used: Set<string>): Script[] {
  const shop = PLATFORMS[platform].category === 'shop';
  const mail = PLATFORMS[platform].category === 'mail';
  const shift = (Object.keys(SCRIPTS) as Platform[]).indexOf(platform);
  const pool = FOLK.filter((f) => !used.has(f.id));
  const folk = [...pool.slice(shift % pool.length), ...pool.slice(0, shift % pool.length)];
  const out: Script[] = [];
  const orders = [5510, 6621, 7732, 8843, 9054, 2267, 3378, 4489];
  folk.slice(0, PER_APP).forEach((f, i) => {
    const topic = (i + shift) % 8;
    const no = orders[(i + shift) % orders.length];
    const unread = i % 3 === 0 ? 2 : i % 3 === 1 ? 1 : 0;
    const base = { remoteId: f.id, handle: handleFor(platform, f, i), avatar: f.avatar, unread };
    if (shop) {
      const pack = shopThread(topic, f.name, no);
      out.push({ ...base, name: pack.name, kind: 'direct', tags: pack.tags, lines: pack.lines });
      return;
    }
    if (mail) {
      const pack = mailThread(topic, f.name, no);
      out.push({ ...base, name: pack.name, kind: 'direct', tags: pack.tags, lines: pack.lines });
      return;
    }
    if (i === 2) {
      out.push({
        ...base,
        remoteId: `grup-${f.id}`,
        name: i % 2 === 0 ? 'Operasyon' : 'Sabah ekibi',
        kind: 'group',
        tags: ['ekip'],
        avatar: 'ekip.jpg',
        handle: undefined,
        lines: [
          [false, 'Mert: Bugünkü kuyruk 18 mesaj. Öğlene kadar yarısını kapatabiliriz.'],
          [false, 'Zeynep: Beden sorularına tabloyu ekleyin, her seferinde yazmayalım.'],
          [true, 'Tablo duruyor. Kargo gecikenlere de fişi iliştirelim.'],
          [false, 'Mert: Stok dökümü.', [csv(`stok-${no}.csv`)]],
          [false, 'Zeynep: Öğleden sonra iki iade var, formları ben doldururum.'],
          [true, 'Tamam. Akşam kısa bir tur daha atarız, taşan kalmasın.'],
          [false, 'Mert: Anlaşıldı.'],
        ],
      });
      return;
    }
    const pack = chatThread(topic, f.name, no);
    out.push({ ...base, name: f.name, kind: 'direct', tags: pack.tags, lines: pack.lines });
  });
  return out;
}

function chatThread(i: number, name: string, no: number): { tags: string[]; lines: Line[] } {
  const first = name.split(' ')[0];
  const threads: Array<{ tags: string[]; lines: Line[] }> = [
    {
      tags: ['müşteri'],
      lines: [
        [false, `Merhaba, ${no} numaralı siparişin kargosu hâlâ hareket etmiyor.`],
        [true, 'Bakıyorum. Dün depoya inmiş, etiket bu sabah kesildi.'],
        [false, 'Hangi firma? Adres değişikliği yapabilir miyim, ofise gelsin.'],
        [true, 'Yurtiçi. Adresi güncelledim, fişi de bırakıyorum.'],
        [true, 'Kargo fişi.', [pdf(`kargo-${no}.pdf`, 62_400)]],
        [false, 'Teşekkürler. Çıkınca takip numarasını da yazar mısınız?'],
        [true, 'Numara sisteme düşünce buradan ileteceğim.'],
      ],
    },
    {
      tags: ['müşteri'],
      lines: [
        [false, 'Bu model bana dar gelir mi? Normalde M alıyorum.'],
        [true, 'Kalıp regular. M giyiyorsanız M alın, bir büyük almanıza gerek yok.'],
        [false, 'Boyum 172. Tabloyu atabilir misiniz?'],
        [true, 'Tablo ektedir. 170–176 arası M rahat duruyor.'],
        [true, 'Beden tablosu.', [pdf(`beden-${no}.pdf`, 98_200)]],
        [false, 'Kumaşın yakını da var mı?'],
        [true, 'Var.', [pic('kumas.jpg', 'kumas.jpg')]],
        [false, 'Tamam, M ile ilerliyorum.'],
      ],
    },
    {
      tags: ['ekip'],
      lines: [
        [false, 'Toplantıyı yarına alabilir miyiz? Bugün sevkiyat var.'],
        [true, 'Yarın 11:00 uygun. Gündemi kısa tutalım.'],
        [false, 'Gündem taslağını ekledim.'],
        [false, 'Gündem.', [pdf(`gundem-${no}.pdf`, 54_100)]],
        [true, 'Baktım. Kargo maddesini üste alalım.'],
        [false, 'Aldım. Daveti güncelliyorum.'],
      ],
    },
    {
      tags: ['fırsat'],
      lines: [
        [false, `${first}, katalogdaki üçüncü modele benzer bir çekim düşünüyoruz.`],
        [true, 'Uygun. Referans kare ve kısa videoyu bırakıyorum.'],
        [true, 'Referans.', [pic('referans.jpg', 'elbise.jpg')]],
        [true, 'Kısa video.', [vid(`cekim-${no}.mp4`, 'cicek.mp4', 'elbise.jpg', 1_128_375)]],
        [false, 'Bu açı iyi. Tarih için perşembe olur mu?'],
        [true, 'Perşembe öğleden sonra uygun.'],
      ],
    },
    {
      tags: ['müşteri'],
      lines: [
        [false, 'Ürün kutusu ezik geldi. Fotoğrafını çektim.'],
        [false, 'Fotoğraf.', [pic('kutu.jpg', 'kupa.jpg')]],
        [true, 'Üzüldük. Değişim ya da iade, hangisini istersiniz?'],
        [false, 'Değişim olsun, aynı ürün tekrar gelsin.'],
        [true, 'Yeni paket yarın çıkar. İade formu gerekmez, fotoğraf yeterli.'],
        [false, 'Tamam, takip kodunu bekliyorum.'],
        [true, 'Çıkınca buraya yazacağım.'],
      ],
    },
    {
      tags: ['kişisel'],
      lines: [
        [false, 'Akşamki yemeği 8’e çekebilir miyiz?'],
        [true, '8 iyi. Ben biraz erken çıkarım.'],
        [false, 'Listede hâlâ süt var, bakkala uğrarsın.'],
        [true, 'Uğrarım. Anahtar sende mi?'],
        [false, 'Bende. Kapıda buluşalım.'],
      ],
    },
    {
      tags: ['müşteri'],
      lines: [
        [false, 'Faturayı kurumsal kesebilir misiniz? Unvanı yazıyorum.'],
        [true, 'Keseriz. Vergi numarasını da iletin, bugün içinde çıkar.'],
        [false, 'Unvan posta ile gitti. PDF olarak da isterim.'],
        [true, 'Kesen kopya ektedir.', [pdf(`fatura-${no}.pdf`, 81_300)]],
        [false, 'Geldi, muhasebeye ilettim. Teşekkürler.'],
      ],
    },
    {
      tags: [],
      lines: [
        [false, 'Dün konuştuğumuz dosyayı bulamadım, bir daha atar mısın?'],
        [true, 'Atıyorum. Son sayfadaki tarihi sen güncelle.'],
        [true, 'Dosya.', [pdf(`not-${no}.pdf`, 66_000)]],
        [false, 'Aldım. Akşam birlikte bakarız.'],
        [true, 'Tamam, 7’de yaz.'],
      ],
    },
  ];
  return threads[i % threads.length];
}

function mailThread(i: number, name: string, no: number): { name: string; tags: string[]; lines: Line[] } {
  const threads: Array<{ name: string; tags: string[]; lines: Line[] }> = [
    {
      name: `Kargo bildirimi — ${no}`,
      tags: ['müşteri'],
      lines: [
        [false, `Merhaba,\n\n${no} numaralı gönderiniz yola çıktı. Etiket ektedir.\n\n${name}`, [pdf(`etiket-${no}.pdf`, 44_200)]],
        [true, 'Teşekkürler. Adreste daire numarası eksik, ekler misiniz?'],
        [false, 'Ekledim. Teslimat yarına kaldı, yeni fiş ektedir.', [pdf(`etiket-${no}-v2.pdf`, 46_100)]],
        [true, 'Tamam, kapıcıya bırakılmasın notunu da görüyorum.'],
      ],
    },
    {
      name: `Fatura ${no}`,
      tags: [],
      lines: [
        [false, `Merhaba,\n\n${no} numaralı faturanız ektedir.\n\n${name}`, [pdf(`fatura-${no}.pdf`, 79_500)]],
        [true, 'Kalemlerden biri fazla görünüyor. Dökümü atabilir misiniz?'],
        [false, 'Döküm ektedir.', [csv(`dokum-${no}.csv`)]],
        [true, 'Şimdi uyuyor. Ödemeyi cuma yapacağız.'],
        [false, 'Cuma uygun. Dekontu bu yazışmaya eklemeniz yeterli.'],
      ],
    },
    {
      name: `Toplantı notu — ${name.split(' ')[0]}`,
      tags: ['ekip'],
      lines: [
        [false, `Gündem ektedir. Saat 11:00, süre yarım saat.\n\n${name}`, [pdf(`gundem-${no}.pdf`, 52_000)]],
        [true, 'Kargo maddesini üste aldım. Sunumu da ekliyorum.'],
        [true, 'Sunum.', [pdf(`sunum-${no}.pdf`, 240_000)]],
        [false, 'İkinci slayt yeterli. Yarın kısa tutalım.'],
      ],
    },
    {
      name: `Teklif revizyonu ${no}`,
      tags: ['fırsat'],
      lines: [
        [false, `Revize teklif ektedir. Eğitim günü ikiye indi.\n\n${name}`, [pdf(`teklif-${no}.pdf`, 188_000)]],
        [true, 'Uygun. Sözleşme taslağını da isteriz.'],
        [false, 'Taslak ektedir.', [pdf(`sozlesme-${no}.pdf`, 210_000)]],
        [true, 'Hukuk yarına bakar. İmzayı bu hafta kapatırız.'],
      ],
    },
    {
      name: `Destek kaydı #${no}`,
      tags: ['müşteri'],
      lines: [
        [false, `Davet postası yine spamde. Kayıt ektedir.\n\n${name}`, [pdf(`kayit-${no}.pdf`, 48_600)]],
        [true, 'SPF satırını eklemeniz gerekiyor. Yarın sabah test edelim.'],
        [false, 'Ekledik. 09:30 uygun.'],
        [true, 'Takvime yazdım.'],
      ],
    },
    {
      name: `Sipariş özeti ${no}`,
      tags: ['müşteri'],
      lines: [
        [false, `Siparişiniz alındı. Özet ektedir.\n\n${name}`, [pdf(`siparis-${no}.pdf`, 61_000)]],
        [true, 'Ürün görselini de görebilir miyim, renk tutsun.'],
        [false, 'Görsel ektedir.', [pic('urun.jpg', 'gomlek.jpg')]],
        [true, 'Bu renk doğru. Faturayı e-posta ile istiyorum.'],
        [false, 'E-fatura kesilince bu zincire düşecek.'],
      ],
    },
    {
      name: `Mutabakat ${no}`,
      tags: ['ekip'],
      lines: [
        [false, `Açık iki kalem var. Liste ektedir.\n\n${name}`, [csv(`mutabakat-${no}.csv`)]],
        [true, 'Birincisi iade, dekontu iletiyorum.'],
        [true, 'Dekont.', [pdf(`dekont-${no}.pdf`, 58_000)]],
        [false, 'İşlendi. Kalan kalem kargo farkı.'],
        [true, 'Onu da bu hafta kapatırız.'],
      ],
    },
    {
      name: `Ekim seçkisi`,
      tags: [],
      lines: [
        [false, `Liste ve fiyatlar ektedir.\n\n${name}`, [csv(`secim-${no}.csv`)]],
        [true, 'Üçüncü sırayı çıkarın, stok yok.'],
        [false, 'Güncel dosya ektedir.', [csv(`secim-${no}-v2.csv`)]],
        [true, 'Bu haliyle cuma gidebilir. Kısa videoyu da koydum.'],
        [true, 'Video.', [vid(`secim-${no}.mp4`, 'paket.mp4', 'elbise.jpg', 574_823)]],
      ],
    },
  ];
  return threads[i % threads.length];
}

function shopThread(i: number, name: string, no: number): { name: string; tags: string[]; lines: Line[] } {
  const first = name.split(' ')[0];
  const threads: Array<{ name: string; tags: string[]; lines: Line[] }> = [
    {
      name: `${first} · sipariş ${no}`,
      tags: ['müşteri'],
      lines: [
        [false, `Merhaba, ${no} numaralı siparişim hâlâ hazırlanıyor. Ne zaman çıkar?`],
        [true, 'Bugün 16:00’ya kadar kargoya veriyoruz. Adres notunu kontrol ettim.'],
        [false, 'Kapıcıya bırakılmasın. Fiş varsa atar mısınız?'],
        [true, 'Notu düştüm. Fiş ektedir.', [pdf(`kargo-${no}.pdf`, 48_900)]],
        [false, 'Teşekkürler. Takip kodu düşünce buradan yazın lütfen.'],
        [true, 'Yazarım. Başka sorunuz olursa bu siparişten devam edin.'],
      ],
    },
    {
      name: `${first} · beden sorusu`,
      tags: ['müşteri'],
      lines: [
        [false, 'Normalde 38 alıyorum, bu model küçük mü duruyor?'],
        [true, 'Kalıp regular. 38 giyiyorsanız 38 alın.'],
        [false, 'Boyum 168, kilo 60. Emin olamadım.'],
        [true, 'Size 38 olur. Ölçü tablosu ektedir.', [pdf(`beden-${no}.pdf`, 110_200)]],
        [false, 'Kumaş pamuk mu keten mi?'],
        [true, 'Keten. Yakın kare:', [pic('kumas.jpg', 'kumas.jpg')]],
        [false, 'Anladım, 38 geçiyorum.'],
      ],
    },
    {
      name: `${first} · iade ${no}`,
      tags: ['müşteri'],
      lines: [
        [false, 'Ürün beklediğim gibi değil, iade etmek istiyorum.'],
        [true, '14 gün içinde ücretsiz iade var. Formu iletiyorum.'],
        [true, 'İade formu.', [pdf(`iade-${no}.pdf`, 52_600)]],
        [false, 'Karta ne zaman döner?'],
        [true, 'Ürün bize ulaşınca 3 iş günü. Kodu paketin üstüne yazmanız yeterli.'],
        [false, 'Yarın kargoya veririm.'],
      ],
    },
    {
      name: `${first} · renk ve stok`,
      tags: ['müşteri'],
      lines: [
        [false, 'Ekranda ekru ve bej aynı görünüyor. Hangisi daha sıcak?'],
        [true, 'Ekru daha sıcak. Yan yana kare:'],
        [true, 'Renkler.', [pic('renk.jpg', 'elbise.jpg')]],
        [false, 'Ekru olsun. 36 stokta var mı?'],
        [true, '36 ekru var, 3 adet. Bugün onaylarsanız yarın çıkar.'],
        [false, 'Onaylıyorum.'],
      ],
    },
    {
      name: `${first} · fatura ${no}`,
      tags: ['müşteri'],
      lines: [
        [false, `${no} faturası mailime düşmedi. PDF gönderebilir misiniz?`],
        [true, 'Gönderiyorum. Bireysel kesilmişti.'],
        [true, 'Fatura.', [pdf(`fatura-${no}.pdf`, 79_400)]],
        [false, 'Kurumsala çevirebilir miyiz? Unvanı yazayım.'],
        [true, 'Sipariş kapanmadan çevirebiliriz. Unvan ve vergi numarasını bırakın.'],
        [false, 'Az önce yazdım.'],
      ],
    },
    {
      name: `${first} · hasarlı ürün`,
      tags: ['müşteri'],
      lines: [
        [false, 'Kutu ezik geldi, ürün de çizilmiş. Fotoğraf ve video çektim.'],
        [false, 'Fotoğraf.', [pic('hasar.jpg', 'kupa.jpg')]],
        [false, 'Video.', [vid(`hasar-${no}.mp4`, 'paket.mp4', 'kupa.jpg', 574_823)]],
        [true, 'İnceledim. Değişim yapalım, yenisi yarın çıkar. Bunu geri göndermeniz yeterli.'],
        [false, 'Kargo ücretini ben mi ödeyeceğim?'],
        [true, 'Hayır, iade kodu bizden. Form ektedir.', [pdf(`iade-${no}.pdf`, 52_600)]],
      ],
    },
    {
      name: `${first} · ödeme ${no}`,
      tags: ['müşteri'],
      lines: [
        [false, 'Kart çekilmeden hata verdi. Sipariş oluştu mu?'],
        [true, `${no} taslak duruyor, çekim yok. Linki yeniledim.`],
        [false, 'Yine olmadı. Havale yapayım.'],
        [true, 'Açıklamaya sipariş numarasını yazın. Bilgi ektedir.', [pdf(`havale-${no}.pdf`, 38_700)]],
        [false, 'Gönderdim. Dekont da ektedir.', [pdf(`dekont-${no}.pdf`, 61_500)]],
        [true, 'Ödeme işlendi. Yarın kargoda.'],
      ],
    },
    {
      name: `${first} · ürün videosu`,
      tags: ['fırsat'],
      lines: [
        [false, 'Kumaşın dökümünü videoda görebilir miyim? Fotoğraf yetmedi.'],
        [true, 'Kısa çekim ve yakın kare ektedir.'],
        [true, 'Video.', [vid(`urun-${no}.mp4`, 'cicek.mp4', 'kumas.jpg', 1_128_375)]],
        [true, 'Yakın kare.', [pic('yakin.jpg', 'kumas.jpg')]],
        [false, 'Tamam, bu haliyle sipariş vereceğim. Beden M.'],
        [true, 'M stokta. Sorunuz olursa buradan devam edin.'],
      ],
    },
  ];
  return threads[i % threads.length];
}

for (const platform of Object.keys(SCRIPTS) as Platform[]) {
  const have = SCRIPTS[platform] ?? [];
  const used = new Set(have.map((s) => s.remoteId));
  const need = PER_APP - have.length;
  if (need > 0) SCRIPTS[platform] = [...have, ...extraScripts(platform, used).slice(0, need)];
}

/** Bazı profillerde sağ panel Özet kutusu dolu gelsin. */
const SAMPLE_SUMMARY: Partial<Record<Platform, Record<string, string[]>>> = {
  whatsapp: {
    ayse: ['4821 numaralı sipariş bugün Yurtiçi ile çıkacak, kapıcıya bırakılmayacak.', 'Kurumsal e-fatura yarın kesilecek; unvan Demir Studio.', 'Takip numarası kargo sisteme düşünce iletilecek.'],
    ekip: ['Bu hafta 31 sipariş, keten seride KETEN15 kuponu var.', 'Kampanya maili yarın 10:00’da çıkacak; son okuma sende.', 'Stok tablosu ve kare görsel ekte.'],
  },
  telegram: {
    can: ['Webhook imzası zorunlu; imzasız istek 401 dönüyor.', 'Saat farkı toleransı beş dakika.', 'Doğrulama bu gece staging’e basılacak, sabah 09:30 bakılacak.'],
  },
  slack: {
    mert: ['Çift çekim sabah kapatıldı, tutar iade edildi.', 'Müşteriye dönüşü Mert yazacak.', 'Kargo gecikme şablonu akşama doldurulacak.'],
  },
  instagram: {
    selin: ['Keten seri için üç hikâye ve bir reels; yayın 18 Ekim.', 'Ürünler çarşamba S ve M olarak kargolanacak.', 'Kapak karesi yayın öncesi onaya sunulacak.'],
  },
  gmail: {
    fatura: ['Eylül faturası 1.250 TL; ek depolama 12–18 Eylül.', 'Döküm uyuyor, ödeme cuma.', 'Dekont bu yazışmaya eklenecek.'],
  },
  shopier: {
    elif: ['4821 siparişte beden M’den S’e çevrildi, henüz paketlenmemişti.', 'Fatura bireysel kalacak, kargo yarın öğleden önce.', 'Kapıcıya bırakılmaması notu düşüldü.'],
  },
  trendyol: {
    'soru-kalip': ['Keten elbise kalıbı regular; 170 cm / 62 kg için 38 önerildi.', 'Keten kırışır, nemli ütüyle düzelir.', 'Müşteri siparişi bu akşam geçecek.'],
  },
  etsy: {
    lina: ['Kolye altın kaplama; duşta, parfümden sonra ve denizde çıkarılmalı.', '5 cm zincir uzatma onaylandı, ücretsiz.', 'Yarın kargoya verilecek.'],
  },
  amazon: {
    'alici-kargo': ['405-8821943 yanlış adrese bırakılmış, kutu müşteriye ulaşmadı.', 'Yeni paket bugün çıkıyor, eskisini aramasına gerek yok.', 'Bu sefer kapıya teslim, görevliye bırakılmayacak.'],
  },
};
for (const platform of Object.keys(SAMPLE_SUMMARY) as Platform[]) {
  const map = SAMPLE_SUMMARY[platform] ?? {};
  for (const s of SCRIPTS[platform] ?? []) if (map[s.remoteId]) s.summary = map[s.remoteId];
}

/** Bazı profillerde kayıtlı not görünsün. */
const SAMPLE_NOTE: Partial<Record<Platform, Record<string, string>>> = {
  whatsapp: {
    ayse: 'Kurumsal fatura: Demir Studio. Kapıcıya bırakılmasın. Takip kodunu çıkınca yaz.',
  },
  slack: {
    mert: 'İade dekontu iletildi. Kargo gecikme şablonunu akşam hatırlat.',
  },
  gmail: {
    fatura: 'Ödeme cuma. Dekont gelince bu kaydı kapat.',
  },
  shopier: {
    elif: 'Beden S’e çevrildi. Fatura bireysel. Yarın Yurtiçi, kapıcıya yok.',
    kerem: 'Kupa çatlak geldi. İade seçti; karta 3 iş günü, kargo ücretsiz.',
  },
  trendyol: {
    'soru-kargo': '1042931 bugün 16:00’ya kadar Trendyol Express ile çıkacak. Adres Ankara, Çankaya.',
  },
  etsy: {
    lina: '5 cm zincir uzatma onaylı. Duş ve deniz uyarısı verildi.',
  },
  amazon: {
    'alici-kargo': 'Yanlış adrese bırakılmış. Yeni paket bugün, bu sefer kapıya teslim.',
  },
};
for (const platform of Object.keys(SAMPLE_NOTE) as Platform[]) {
  const map = SAMPLE_NOTE[platform] ?? {};
  for (const s of SCRIPTS[platform] ?? []) if (map[s.remoteId]) s.note = map[s.remoteId];
}

/** Kanal satırındaki bildirim: her uygulamada başka bir toplam. Kanallar sayıma girmez. */
const BADGE: Partial<Record<Platform, number>> = {
  whatsapp: 4,
  telegram: 18,
  slack: 1,
  imessage: 27,
  linkedin: 7,
  x: 13,
  instagram: 3,
  messenger: 36,
  gmail: 9,
  outlook: 22,
  yahoo: 0,
  icloud: 11,
  imap: 16,
  shopier: 5,
  trendyol: 29,
  hepsiburada: 2,
  etsy: 14,
  shopify: 8,
  amazon: 6,
};

function spreadUnread(total: number, slots: number): number[] {
  const out = Array(slots).fill(0);
  if (total <= 0 || slots === 0) return out;
  const used = Math.min(slots, total >= 10 ? 4 : total >= 4 ? 3 : total);
  let left = total;
  for (let i = 0; i < used; i++) {
    const give = i === used - 1 ? left : Math.max(1, Math.ceil(left / (used - i + 0.4)));
    const n = Math.min(left, give);
    out[i] = n;
    left -= n;
  }
  if (left > 0) out[0] += left;
  return out;
}

for (const platform of Object.keys(SCRIPTS) as Platform[]) {
  const chats = SCRIPTS[platform] ?? [];
  const idx = chats.map((s, i) => (s.kind === 'channel' ? -1 : i)).filter((i) => i >= 0);
  for (const s of chats) if (s.kind !== 'channel') s.unread = 0;
  const parts = spreadUnread(BADGE[platform] ?? 0, idx.length);
  idx.forEach((at, i) => {
    chats[at].unread = parts[i] ?? 0;
  });
}

/** Yahoo ve diğer e-posta demoda bağlı gelmez. Sohbet, e-posta ve alışveriş örnekleri kalır. */
const DEMO_SKIP: Platform[] = ['yahoo', 'imap'];
export const DEMO_APPS: Platform[] = (Object.keys(PLATFORMS) as Platform[]).filter((p) => p !== 'demo' && !DEMO_SKIP.includes(p) && SCRIPTS[p]);
