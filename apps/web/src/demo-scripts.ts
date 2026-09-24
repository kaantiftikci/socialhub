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
  lines: Line[];
}

const pdf = (name: string, size = 128_440): Attachment => ({ kind: 'file', name, mime: 'application/pdf', size, link: '/demo/files/ornek.pdf' });
const csv = (name: string, size = 18_420): Attachment => ({ kind: 'file', name, mime: 'text/csv', size, link: '/demo/files/siparisler.csv' });
const pic = (name: string, size = 86_400): Attachment => ({ kind: 'image', name, mime: 'image/jpeg', size, url: '/demo/files/urun.jpg' });

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
        [true, 'Aldım, muhasebeye ilettim.'],
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
        [true, 'Referans.', [pic('referans.jpg')]],
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
        [true, 'Yüzde yüz keten. Yakın kare:'],
        [true, 'Kumaş.', [pic('keten-kumas.jpg')]],
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
        [true, 'Ekru gömlek.', [pic('gomlek-ekru.jpg')]],
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
        [true, 'Seçtiklerimi ekledim.', [pic('lansman-kare.jpg')]],
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
        [true, 'Not.', [pic('anahtar-notu.jpg')]],
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
        [false, 'Fotoğraf.', [pic('hasarli-kupa.jpg')]],
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
        [true, 'Kumaş.', [pic('keten-kumas.jpg')]],
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
        [true, 'Renk karşılaştırması.', [pic('renk-ekru-bej.jpg')]],
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
};

export const DEMO_APPS: Platform[] = (Object.keys(PLATFORMS) as Platform[]).filter((p) => p !== 'demo' && SCRIPTS[p]);
