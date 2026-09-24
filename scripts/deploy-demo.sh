#!/usr/bin/env bash
# Statik demoyu (apps/web/dist) mivelo.kaantiftikci.com alt alanına SFTP ile yükler. Şifreyi sen girersin.
# Kullanım: scripts/deploy-demo.sh   (önce: VITE_STATIC_DEMO=1 npm run build -w apps/web)
set -euo pipefail
HOST="${MIVELO_SFTP_HOST:-python01.turkticaret.net}"
USER="${MIVELO_SFTP_USER:-kaa300ftikcicom}"
DIR="${MIVELO_SFTP_DIR:-mivelo.kaantiftikci.com}"   # cPanel belge kökü (ana dizine göre)
cd "$(dirname "$0")/../apps/web/dist"
[ -f index.html ] || { echo "dist yok: önce VITE_STATIC_DEMO=1 npm run build -w apps/web"; exit 1; }
echo "→ $USER@$HOST:$DIR  (dosyalar: $(find . -type f | wc -l | tr -d ' '))"
# scp -r: assets/ ve api/ dahil her şeyi kökün altına kopyalar; eski assets dosyaları sunucuda kalır (zararsız)
scp -r ./* "$USER@$HOST:$DIR/"
echo "✓ yüklendi: https://mivelo.kaantiftikci.com"
