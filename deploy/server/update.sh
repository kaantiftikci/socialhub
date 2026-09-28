#!/usr/bin/env bash
# Mivelo sunucu güncellemesi — mivelo-update.timer 5 dk'da bir, root olarak çalıştırır (elle: sudo systemctl start mivelo-update).
# origin/<dal>'ı çeker (yalnız ileri sarma); son BAŞARILI kurulumdan (/var/lib/mivelo/deployed-commit) bu yana değişenlere göre:
#   package-lock.json / package.json   → npm ci + Playwright Chromium (sürüm değişmiş olabilir) + çekirdek derlemesi
#   packages/core/**                    → çekirdek derlemesi
#   apps/gateway/**, çekirdek derlendi  → ağ geçidi yeniden başlar (üyelerin çekirdekleri de; sonraki istekte kendiliğinden açılır)
#   deploy/server/*.service|*.timer     → systemd birimleri yenilenir
# Yalnız arayüz (apps/web, apps/landing) değiştiyse hiçbir şey yeniden başlamaz. Adım yarıda kalırsa sonraki tur yeniden dener.
# Betiğin tamamı { } içinde: git bu dosyayı çalışırken değiştirse de bash eski sürümü baştan sona okumuş olur.
{
set -Eeuo pipefail
APP_DIR=${APP_DIR:-/opt/mivelo}
DATA_DIR=${DATA_DIR:-/var/lib/mivelo}
BRANCH=${BRANCH:-main}
PW_DIR="$APP_DIR/.pw"
STATE="$DATA_DIR/deployed-commit"
export DEBIAN_FRONTEND=noninteractive

as_mivelo() { runuser -u mivelo -- env HOME="$DATA_DIR" PATH="$PATH" PLAYWRIGHT_BROWSERS_PATH="$PW_DIR" "$@"; }
say() { echo "[mivelo-update] $*"; }
trap 'say "HATA (satır $LINENO): güncelleme yarıda kaldı; sonraki turda yeniden denenecek"' ERR

cd "$APP_DIR"
as_mivelo git fetch --quiet origin "$BRANCH"
if [ "$(as_mivelo git rev-parse HEAD)" != "$(as_mivelo git rev-parse "origin/$BRANCH")" ]; then
  if ! as_mivelo git merge --ff-only --quiet "origin/$BRANCH"; then
    say "ileri sarılamadı (sunucuda yerel değişiklik ya da ayrışmış geçmiş var): git -C $APP_DIR status"
    exit 1
  fi
fi
head=$(as_mivelo git rev-parse HEAD)
deployed=$(cat "$STATE" 2>/dev/null || true)
[ "$head" = "$deployed" ] && exit 0

if [ -n "$deployed" ] && as_mivelo git cat-file -e "${deployed}^{commit}" 2>/dev/null; then
  changed=$(as_mivelo git diff --name-only "$deployed" "$head")
  say "güncellendi: ${deployed:0:7} → ${head:0:7}"
else
  changed='*'
  say "ilk kurulum/bilinmeyen durum → ${head:0:7}: tüm adımlar"
fi
has() { [ "$changed" = '*' ] || grep -qE "$1" <<<"$changed"; }

need_build=0
need_restart=0
need_xvfb=0
if has '^(package-lock\.json|package\.json|packages/core/package\.json|apps/[^/]+/package\.json)$'; then
  say "bağımlılıklar değişti: npm ci (ağ geçidi bu sırada durur)"
  # çalışan çekirdekler node_modules yeniden kurulurken modül yüklemeye çalışmasın; sonunda yeniden başlatılır
  systemctl stop mivelo-gateway.service
  as_mivelo npm ci --no-audit --no-fund
  # Playwright sürümü değiştiyse yeni Chromium gerekir (sistem kütüphaneleri root ile, tarayıcı mivelo ile)
  "$APP_DIR/node_modules/.bin/playwright" install-deps chromium >/dev/null
  as_mivelo "$APP_DIR/node_modules/.bin/playwright" install chromium
  need_build=1
fi
has '^packages/core/' && need_build=1
if [ "$need_build" = 1 ]; then
  say "çekirdek derleniyor"
  as_mivelo npm run build -w packages/core >/dev/null
  need_restart=1
fi
has '^apps/gateway/' && need_restart=1
if has '^deploy/server/[^/]+\.(service|timer)$'; then
  say "systemd birimleri yenileniyor"
  install -m 0644 "$APP_DIR"/deploy/server/mivelo-*.service "$APP_DIR"/deploy/server/mivelo-*.timer /etc/systemd/system/
  systemctl daemon-reload
  has '^deploy/server/mivelo-xvfb\.service$' && need_xvfb=1
  need_restart=1
fi
if [ "$need_xvfb" = 1 ]; then systemctl restart mivelo-xvfb.service; fi
if [ "$need_restart" = 1 ]; then
  say "ağ geçidi yeniden başlatılıyor"
  systemctl restart mivelo-gateway.service
fi
echo "$head" >"$STATE"
say "tamam (${head:0:7})"
exit 0
}
