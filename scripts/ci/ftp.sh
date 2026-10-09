# CI'da mivelo.app sunucusuna FTP (TLS) erişimi — kaynak olarak yüklenir: `. scripts/ci/ftp.sh`
# Sonuç: CURL (dizi: kimlik + TLS seçenekleri) ve FTP_URL (ftp://<ad>). Gerekir: FTP_PASSWORD.
# Paylaşımlı barındırmada FTP sertifikası alan adına (kaantiftikci.com) değil sunucunun kendi adına düzenlenmiş olabiliyor:
# curl ad uyuşmazlığında haklı olarak reddeder (eski FTP-Deploy-Action varsayılan "loose" kipte hiç doğrulamıyordu). Önce
# sertifikadaki adlar denenir (bağlantı yine aynı sunucuya, --connect-to; TLS bu adla DOĞRULANIR); hiçbiri tutmazsa uyarıyla
# doğrulamasız TLS (eski eylemle aynı düzey).
FTP_REAL_HOST="${FTP_REAL_HOST:-kaantiftikci.com}"
FTP_PORT="${FTP_PORT:-21}"
CURL=(curl -sS --ssl-reqd -u "kaa300ftikcicom:$FTP_PASSWORD")
FTP_URL="ftp://$FTP_REAL_HOST:$FTP_PORT"
if ! "${CURL[@]}" -l -o /dev/null "$FTP_URL/" 2>/dev/null; then
  names=$(echo | openssl s_client -starttls ftp -connect "$FTP_REAL_HOST:$FTP_PORT" 2>/dev/null | openssl x509 -noout -text 2>/dev/null \
    | grep -o 'DNS:[^, ]*' | sed 's/^DNS://' | grep -v '^\*' | sort -u)
  ok=""
  for n in $names; do
    if "${CURL[@]}" --connect-to "$n:$FTP_PORT:$FTP_REAL_HOST:$FTP_PORT" -l -o /dev/null "ftp://$n:$FTP_PORT/" 2>/dev/null; then
      CURL+=(--connect-to "$n:$FTP_PORT:$FTP_REAL_HOST:$FTP_PORT"); FTP_URL="ftp://$n:$FTP_PORT"; ok=1
      echo "FTP TLS: sertifika '$n' adıyla doğrulandı"; break
    fi
  done
  if [ -z "$ok" ]; then
    echo "::warning::FTP sertifikası doğrulanamadı (sertifikadaki adlar: ${names:-yok}); doğrulamasız TLS kullanılıyor"
    CURL+=(-k)
  fi
fi
