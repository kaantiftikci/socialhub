#!/usr/bin/env bash
# Mivelo sunucu çekirdeği kurulumu — Ubuntu 24.04 (x86_64 ya da arm64/Ampere), root olarak. Tekrar çalıştırılabilir (güncel
# sürüme getirir, ayarları korur). Kullanım:
#   curl -fsSL https://raw.githubusercontent.com/kaantiftikci/socialhub/main/deploy/server/setup.sh | sudo bash -s -- --domain core.mivelo.app --secret <SIR>
# Seçenekler: --domain <alan adı>  --secret <CORE_SECRET, ≥32>  [--origins https://demo.mivelo.app]  [--max-cores N]
#             [--idle-minutes 120]  [--branch main]  [--repo https://github.com/kaantiftikci/socialhub]
# Ortam değişkeni olarak da verilebilir: DOMAIN, CORE_SECRET, ALLOWED_ORIGINS, MAX_CORES, IDLE_MINUTES, BRANCH, REPO_URL.
# Ayrıntı: deploy/server/README.md

main() {
  set -Eeuo pipefail
  trap 'echo "HATA: kurulum satır $LINENO civarında durdu (yukarıdaki çıktıya bak). Betik tekrar çalıştırılabilir." >&2' ERR

  local REPO_URL=${REPO_URL:-https://github.com/kaantiftikci/socialhub}
  local BRANCH=${BRANCH:-main}
  local DOMAIN=${DOMAIN:-} SECRET=${CORE_SECRET:-} ORIGINS=${ALLOWED_ORIGINS:-} MAX=${MAX_CORES:-} IDLE=${IDLE_MINUTES:-}
  local APP_DIR=/opt/mivelo DATA_DIR=/var/lib/mivelo ENV_FILE=/etc/mivelo/gateway.env
  local USERS_DIR=$DATA_DIR/users PW_DIR=$APP_DIR/.pw
  while [ $# -gt 0 ]; do
    case "$1" in --domain | --secret | --origins | --max-cores | --idle-minutes | --branch | --repo) [ $# -ge 2 ] || die "$1 bir değer ister" ;; esac
    case "$1" in
      --domain) DOMAIN=${2:-}; shift 2 ;;
      --secret) SECRET=${2:-}; shift 2 ;;
      --origins) ORIGINS=${2:-}; shift 2 ;;
      --max-cores) MAX=${2:-}; shift 2 ;;
      --idle-minutes) IDLE=${2:-}; shift 2 ;;
      --branch) BRANCH=${2:-}; shift 2 ;;
      --repo) REPO_URL=${2:-}; shift 2 ;;
      -h | --help) usage; return 0 ;;
      *) die "Bilinmeyen seçenek: $1" ;;
    esac
  done

  [ "$(id -u)" -eq 0 ] || die "root olarak çalıştır: ... | sudo bash -s -- --domain ... --secret ..."
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] || warn "Ubuntu dışı sistem (${PRETTY_NAME:-?}); Ubuntu 24.04 için yazıldı"
  [ "${VERSION_ID:-}" = 24.04 ] || warn "Ubuntu ${VERSION_ID:-?}; 24.04 için denendi"
  local ARCH
  ARCH=$(dpkg --print-architecture)
  case "$ARCH" in amd64 | arm64) ;; *) die "Desteklenmeyen mimari: $ARCH (amd64 ya da arm64)" ;; esac

  # --- ayarlar: verilmeyenler önceki kurulumdan (gateway.env), yoksa varsayılan ---
  [ -n "$SECRET" ] || SECRET=$(envget CORE_SECRET "$ENV_FILE")
  [ -n "$DOMAIN" ] || DOMAIN=$(envget DOMAIN "$ENV_FILE")
  [ -n "$ORIGINS" ] || ORIGINS=$(envget ALLOWED_ORIGINS "$ENV_FILE")
  [ -n "$MAX" ] || MAX=$(envget MAX_CORES "$ENV_FILE")
  [ -n "$IDLE" ] || IDLE=$(envget IDLE_MINUTES "$ENV_FILE")
  ORIGINS=${ORIGINS:-https://demo.mivelo.app}
  IDLE=${IDLE:-120}
  local MEM_MB
  MEM_MB=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)
  if [ -z "$MAX" ]; then
    # ortalama üye ~1 GB (çekirdek ~200 MB + tarayıcılı kanallar ~300-500 MB), sistem ~1 GB; 4 GB takas yedekte (8 GB → 7, 14 GB → 13)
    MAX=$(((MEM_MB - 1024) / 1024))
    [ "$MAX" -ge 2 ] || MAX=2
    [ "$MAX" -le 40 ] || MAX=40
  fi
  [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] && [[ "$DOMAIN" == *.* ]] || die "--domain gerekli (ör. core.mivelo.app)"
  [ -n "$SECRET" ] || die "--secret gerekli (Mivelo Admin → Demo → Sunucu çekirdeği kartındaki sır)"
  [[ "$SECRET" =~ ^[A-Za-z0-9._~+/=-]{32,256}$ ]] || die "Sır en az 32 karakter olmalı ve yalnız harf, rakam, . _ ~ + / = - içermeli"
  [[ "$ORIGINS" =~ ^https?://[^[:space:]\"\'\\]+$ ]] || die "--origins geçersiz: $ORIGINS"
  [[ "$MAX" =~ ^[0-9]+$ ]] && [ "$MAX" -ge 1 ] || die "--max-cores sayı olmalı"
  [[ "$IDLE" =~ ^[0-9]+$ ]] && [ "$IDLE" -ge 1 ] || die "--idle-minutes sayı olmalı"

  step "Sistem paketleri (git, derleyici, Xvfb, ffmpeg)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y -q
  apt-get install -y -q --no-install-recommends ca-certificates curl gnupg git build-essential python3 xvfb ffmpeg \
    debian-keyring debian-archive-keyring apt-transport-https iptables </dev/null

  step "Node.js 22"
  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -q nodejs </dev/null
  fi
  echo "node $(node -v), npm $(npm -v)"

  step "Caddy (otomatik HTTPS)"
  if [ ! -s /usr/share/keyrings/caddy-stable-archive-keyring.gpg ] || [ ! -s /etc/apt/sources.list.d/caddy-stable.list ]; then
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y -q
  fi
  apt-get install -y -q caddy </dev/null

  step "Kullanıcı ve klasörler"
  id mivelo >/dev/null 2>&1 || useradd --system --user-group --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin mivelo
  install -d -o mivelo -g mivelo -m 0750 "$DATA_DIR"
  install -d -o mivelo -g mivelo -m 0700 "$USERS_DIR"
  install -d -o root -g root -m 0755 /etc/mivelo

  step "Kod: $REPO_URL ($BRANCH) → $APP_DIR"
  if [ -d "$APP_DIR/.git" ]; then
    chown -R mivelo:mivelo "$APP_DIR"
    as_mivelo git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
    as_mivelo git -C "$APP_DIR" checkout --quiet "$BRANCH"
    as_mivelo git -C "$APP_DIR" merge --ff-only --quiet "origin/$BRANCH" || die "$APP_DIR ileri sarılamadı (yerel değişiklik?): git -C $APP_DIR status"
  else
    if [ -d "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then die "$APP_DIR boş değil ve git deposu değil"; fi
    install -d -o mivelo -g mivelo -m 0755 "$APP_DIR"
    as_mivelo git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
  install -d -o mivelo -g mivelo -m 0755 "$PW_DIR"
  grep -qxF '/.pw/' "$APP_DIR/.git/info/exclude" 2>/dev/null || echo '/.pw/' >>"$APP_DIR/.git/info/exclude"
  echo "sürüm: $(as_mivelo git -C "$APP_DIR" log -1 --format='%h %s')"

  step "Bağımlılıklar (npm ci) ve çekirdek derlemesi"
  # yeniden kurulumda çalışan çekirdekler node_modules silinirken modül yüklemeye çalışmasın
  systemctl stop mivelo-gateway.service 2>/dev/null || true
  (cd "$APP_DIR" && as_mivelo npm ci --no-audit --no-fund </dev/null)
  (cd "$APP_DIR" && as_mivelo npm run build -w packages/core </dev/null)

  step "Chromium (Playwright) ve sistem kütüphaneleri"
  (cd "$APP_DIR" && ./node_modules/.bin/playwright install-deps chromium </dev/null)
  (cd "$APP_DIR" && as_mivelo ./node_modules/.bin/playwright install chromium </dev/null)

  step "Ayarlar: $ENV_FILE"
  local tmp
  tmp=$(mktemp /etc/mivelo/.gateway.env.XXXXXX)
  chmod 600 "$tmp"
  {
    echo "# Mivelo ağ geçidi ayarları — setup.sh yazar (yeniden çalıştırınca aşağıdaki anahtarlar güncellenir, eklediğin diğer satırlar korunur)"
    echo "CORE_SECRET=$SECRET"
    echo "DOMAIN=$DOMAIN"
    echo "ALLOWED_ORIGINS=$ORIGINS"
    echo "USERS_DIR=$USERS_DIR"
    echo "GATEWAY_HOST=127.0.0.1"
    echo "GATEWAY_PORT=8787"
    echo "MAX_CORES=$MAX"
    echo "IDLE_MINUTES=$IDLE"
    echo "DISPLAY=:99"
    echo "PLAYWRIGHT_BROWSERS_PATH=$PW_DIR"
    echo "TZ=Europe/Istanbul"
    if [ -f "$ENV_FILE" ]; then
      grep -vE '^(#|CORE_SECRET=|DOMAIN=|ALLOWED_ORIGINS=|USERS_DIR=|GATEWAY_HOST=|GATEWAY_PORT=|MAX_CORES=|IDLE_MINUTES=|DISPLAY=|PLAYWRIGHT_BROWSERS_PATH=|TZ=)' "$ENV_FILE" | grep -v '^[[:space:]]*$' || true
    fi
  } >"$tmp"
  chown root:root "$tmp"
  mv -f "$tmp" "$ENV_FILE"
  echo "MAX_CORES=$MAX (bellek ${MEM_MB} MB), IDLE_MINUTES=$IDLE, ALLOWED_ORIGINS=$ORIGINS"

  step "Güvenlik duvarı: 80 ve 443"
  open_ports

  if [ "$MEM_MB" -lt 6000 ] && [ -z "$(swapon --show --noheadings 2>/dev/null)" ] && [ ! -e /swapfile ]; then
    step "Takas alanı (4 GB; bellek ${MEM_MB} MB)"
    if fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
      grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
    else
      warn "takas alanı oluşturulamadı (kurulum sürüyor)"
      rm -f /swapfile
    fi
  fi

  step "systemd birimleri"
  install -m 0644 "$APP_DIR"/deploy/server/mivelo-*.service "$APP_DIR"/deploy/server/mivelo-*.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --quiet mivelo-xvfb.service mivelo-gateway.service mivelo-update.timer
  systemctl restart mivelo-xvfb.service
  systemctl restart mivelo-gateway.service
  systemctl start mivelo-update.timer
  as_mivelo git -C "$APP_DIR" rev-parse HEAD >"$DATA_DIR/deployed-commit"

  step "Caddy: https://$DOMAIN → 127.0.0.1:8787"
  if [ -f /etc/caddy/Caddyfile ] && ! grep -q '^# Mivelo' /etc/caddy/Caddyfile; then
    cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%Y%m%d%H%M%S)"
  fi
  cat >/etc/caddy/Caddyfile <<CADDY
# Mivelo — setup.sh yazdı (yeniden çalıştırınca üzerine yazılır). Sertifika Let's Encrypt'ten kendiliğinden alınır/yenilenir.
$DOMAIN {
	encode zstd gzip
	request_body {
		max_size 80MB
	}
	reverse_proxy 127.0.0.1:8787
}
CADDY
  caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null
  systemctl enable --quiet caddy
  systemctl reload caddy 2>/dev/null || systemctl restart caddy

  step "Denetim"
  local ok=0 _
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:8787/gw/health >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  [ "$ok" = 1 ] || die "Ağ geçidi yanıt vermiyor: journalctl -u mivelo-gateway -n 50"
  echo "ağ geçidi (yerel): $(curl -fsS http://127.0.0.1:8787/gw/health)"
  local ip dns
  ip=$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || true)
  dns=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1 {print $1}' || true)
  echo
  echo "Kurulum tamam."
  echo "  Sunucunun genel IP'si : ${ip:-bilinmiyor}"
  echo "  $DOMAIN DNS kaydı     : ${dns:-yok}"
  if [ -n "$ip" ] && [ "$dns" != "$ip" ]; then
    echo "  → DNS'te A kaydı ekle: $DOMAIN → $ip (Türkticaret DNS). Kayıt yayılınca Caddy sertifikayı kendisi alır."
  fi
  echo "  Denetim               : curl https://$DOMAIN/gw/health"
  echo "  Günlükler             : journalctl -u mivelo-gateway -f   ·   üye: $USERS_DIR/<uid>/core.log"
}

usage() {
  cat <<'USAGE'
Mivelo sunucu çekirdeği kurulumu (Ubuntu 24.04, root):
  curl -fsSL https://raw.githubusercontent.com/kaantiftikci/socialhub/main/deploy/server/setup.sh | sudo bash -s -- --domain core.mivelo.app --secret <SIR>
Seçenekler: --domain  --secret  [--origins https://demo.mivelo.app]  [--max-cores N]  [--idle-minutes 120]  [--branch main]  [--repo URL]
USAGE
}

die() {
  echo "HATA: $*" >&2
  exit 1
}
warn() { echo "UYARI: $*" >&2; }
step() { printf '\n==> %s\n' "$*"; }
envget() { [ -f "$2" ] && sed -n "s/^$1=//p" "$2" | tail -n1 || true; }
as_mivelo() { runuser -u mivelo -- env HOME=/var/lib/mivelo PATH="$PATH" PLAYWRIGHT_BROWSERS_PATH=/opt/mivelo/.pw "$@"; }

# Oracle Cloud Ubuntu imajları INPUT zincirinin sonunda REJECT kuralıyla gelir (VCN güvenlik listesine ek olarak): 80/443 açılır
# ve netfilter-persistent ile kalıcı yapılır. ufw etkinse ona da izin eklenir. Kuralsız sistemlerde (Hetzner) dokunulmaz.
open_ports() {
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    ufw allow 443/udp >/dev/null
    echo "ufw: 80/tcp, 443/tcp, 443/udp açıldı"
  fi
  local ipt changed=0 rule
  for ipt in iptables ip6tables; do
    command -v "$ipt" >/dev/null || continue
    "$ipt" -S INPUT 2>/dev/null | grep -qE -- '-j (REJECT|DROP)|^-P INPUT DROP' || continue
    for rule in "tcp 80" "tcp 443" "udp 443"; do
      # shellcheck disable=SC2086 # bilerek bölünüyor: protokol + port
      set -- $rule
      if ! "$ipt" -C INPUT -p "$1" -m conntrack --ctstate NEW -m "$1" --dport "$2" -j ACCEPT 2>/dev/null; then
        "$ipt" -I INPUT 1 -p "$1" -m conntrack --ctstate NEW -m "$1" --dport "$2" -j ACCEPT
        changed=1
      fi
    done
    echo "$ipt: 80/tcp, 443/tcp, 443/udp açık"
  done
  if [ "$changed" = 1 ]; then
    if ! command -v netfilter-persistent >/dev/null; then apt-get install -y -q iptables-persistent </dev/null; fi
    netfilter-persistent save >/dev/null 2>&1 && echo "kurallar kalıcı yapıldı (netfilter-persistent)"
  fi
  return 0
}

main "$@"
exit $?
