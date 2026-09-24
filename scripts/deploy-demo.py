#!/usr/bin/env python3
"""Statik demoyu (apps/web/dist) cPanel FTP'sine (TLS) yükler. Bu sunucuda SSH/SFTP (22) kapalı, FTP (21) açık.
Şifre çalıştıran kişiden istenir; hiçbir yere yazılmaz. Kullanım: python3 scripts/deploy-demo.py"""
import ftplib, getpass, os, ssl, sys

HOST = os.environ.get("MIVELO_FTP_HOST", "kaantiftikci.com")
USER = os.environ.get("MIVELO_FTP_USER", "kaa300ftikcicom")
REMOTE = os.environ.get("MIVELO_FTP_DIR", "mivelo.kaantiftikci.com")  # cPanel belge kökü (ana dizine göre)
LOCAL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "apps", "web", "dist")

if not os.path.isfile(os.path.join(LOCAL, "index.html")):
    sys.exit("dist yok: önce VITE_STATIC_DEMO=1 npm run build -w apps/web")

pw = getpass.getpass(f"{USER}@{HOST} FTP şifresi: ")
ctx = ssl.create_default_context()
try:
    ftp = ftplib.FTP_TLS(HOST, context=ctx, timeout=30)
    ftp.login(USER, pw)
    ftp.prot_p()
    print("bağlandı (FTP + TLS)")
except Exception as e:  # sertifika/TLS yoksa düz FTP'ye düş (şifre şifresiz gider; hosting genelde TLS destekler)
    print(f"TLS ile bağlanamadı ({e}); düz FTP deneniyor")
    ftp = ftplib.FTP(HOST, timeout=30)
    ftp.login(USER, pw)

def ensure_dir(path):
    parts = [p for p in path.split("/") if p]
    cur = ""
    for p in parts:
        cur = f"{cur}/{p}" if cur else p
        try:
            ftp.mkd(cur)
        except ftplib.error_perm:
            pass  # zaten var

count = 0
for root, dirs, files in os.walk(LOCAL):
    rel = os.path.relpath(root, LOCAL)
    remote_dir = REMOTE if rel == "." else f"{REMOTE}/{rel.replace(os.sep, '/')}"
    ensure_dir(remote_dir)
    for name in files:
        if name.startswith("."):
            continue
        local = os.path.join(root, name)
        with open(local, "rb") as fh:
            ftp.storbinary(f"STOR {remote_dir}/{name}", fh)
        count += 1
        print(f"  ↑ {remote_dir}/{name}")
ftp.quit()
print(f"✓ {count} dosya yüklendi → https://mivelo.kaantiftikci.com")
