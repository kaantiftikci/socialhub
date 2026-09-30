package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/mediaproxy"
)

// Medya: köprünün yüklediği dosyalar <net>/media/<sha256> (+ .type içerik türü) olarak durur; doğrudan medya
// (mxc://d/…) ilk istekte ağdan indirilip aynı yere yazılır. Çekirdek dosyayı yolundan okur.

func writeTypeFile(path, mime string) {
	if mime != "" {
		_ = os.WriteFile(path+".type", []byte(mime), 0o600)
	}
}

func readTypeFile(path string) string {
	b, _ := os.ReadFile(path + ".type")
	return strings.TrimSpace(string(b))
}

func (nb *netBridge) storeMedia(data []byte, fileName, mime string) (string, error) {
	sum := sha256.Sum256(data)
	name := hex.EncodeToString(sum[:])
	path := filepath.Join(nb.mediaDir, name)
	if _, err := os.Stat(path); err != nil {
		if err = writeAtomic(path, bytes.NewReader(data)); err != nil {
			return "", err
		}
	}
	if mime == "" {
		mime = http.DetectContentType(data)
	}
	writeTypeFile(path, mime)
	return mxcUpload + name, nil
}

func (nb *netBridge) storeMediaStream(cb bridgev2.FileStreamCallback) (string, error) {
	tmp, err := os.CreateTemp(nb.mediaDir, ".up-*")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	res, err := cb(tmp)
	_ = tmp.Close()
	if err != nil {
		return "", err
	}
	src := tmpName
	if res != nil && res.ReplacementFile != "" {
		src = res.ReplacementFile
		defer os.Remove(res.ReplacementFile)
	}
	f, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	name := hex.EncodeToString(h.Sum(nil))
	path := filepath.Join(nb.mediaDir, name)
	if _, err = os.Stat(path); err != nil {
		if _, err = f.Seek(0, io.SeekStart); err != nil {
			return "", err
		}
		if err = writeAtomic(path, f); err != nil {
			return "", err
		}
	}
	mime := ""
	if res != nil {
		mime = res.MimeType
	}
	writeTypeFile(path, mime)
	return mxcUpload + name, nil
}

func writeAtomic(path string, r io.Reader) error {
	tmp := path + ".tmp-" + randomString()
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err = io.Copy(f, r); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err = f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

func copyToTemp(src string) (string, error) {
	in, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer in.Close()
	out, err := os.CreateTemp("", "mivelo-media-*")
	if err != nil {
		return "", err
	}
	defer out.Close()
	if _, err = io.Copy(out, in); err != nil {
		_ = os.Remove(out.Name())
		return "", err
	}
	return out.Name(), nil
}

// mediaFile bir mxc adresini diskteki dosyaya çözer (gerekirse indirir): yol + içerik türü
func (nb *netBridge) mediaFile(ctx context.Context, uri string) (string, string, error) {
	switch {
	case strings.HasPrefix(uri, mxcFile):
		p, ok := dec(strings.TrimPrefix(uri, mxcFile))
		if !ok {
			return "", "", errCode("bad_uri", "geçersiz dosya adresi")
		}
		// yalnız köprü klasöründeki dosyalar (çekirdek gönderilecek dosyayı <ağ>/out/ altına kopyalar)
		abs, err := filepath.Abs(p)
		if err != nil {
			return "", "", errCode("bad_uri", "geçersiz dosya adresi")
		}
		if rel, err := filepath.Rel(dataRoot, abs); err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
			return "", "", errCode("bad_uri", "dosya köprü klasörü dışında")
		}
		return abs, readTypeFile(abs), nil
	case strings.HasPrefix(uri, mxcUpload):
		name := strings.TrimPrefix(uri, mxcUpload)
		if strings.ContainsAny(name, `/\.`) {
			return "", "", errCode("bad_uri", "geçersiz medya adresi")
		}
		path := filepath.Join(nb.mediaDir, name)
		if _, err := os.Stat(path); err != nil {
			return "", "", errCode("not_found", "medya bulunamadı")
		}
		return path, readTypeFile(path), nil
	case strings.HasPrefix(uri, mxcDirect):
		return nb.downloadDirect(ctx, uri)
	default:
		return "", "", errCode("bad_uri", "bilinmeyen medya adresi")
	}
}

func (nb *netBridge) downloadDirect(ctx context.Context, uri string) (string, string, error) {
	raw, err := b64.DecodeString(strings.TrimPrefix(uri, mxcDirect))
	if err != nil {
		return "", "", errCode("bad_uri", "geçersiz medya adresi")
	}
	sum := sha256.Sum256([]byte(uri))
	path := filepath.Join(nb.mediaDir, "d"+hex.EncodeToString(sum[:16]))
	if _, err = os.Stat(path); err == nil {
		return path, readTypeFile(path), nil
	}
	dm, ok := nb.conn.(bridgev2.DirectMediableNetwork)
	if !ok {
		return "", "", errCode("unsupported", "bu ağ istek üzerine medya indirmiyor")
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	resp, err := dm.Download(ctx, networkid.MediaID(raw), nil)
	if err != nil {
		return "", "", errCode("media_failed", "%s", err.Error())
	}
	var mime string
	switch r := resp.(type) {
	case *mediaproxy.GetMediaResponseData:
		defer r.Reader.Close()
		mime = r.ContentType
		err = writeAtomic(path, r.Reader)
	case mediaproxy.GetMediaResponseWriter:
		mime = r.GetContentType()
		pr, pw := io.Pipe()
		go func() {
			_, werr := r.WriteTo(pw)
			_ = pw.CloseWithError(werr)
		}()
		err = writeAtomic(path, pr)
	case *mediaproxy.GetMediaResponseFile:
		var f *os.File
		f, err = os.CreateTemp(nb.mediaDir, ".dl-*")
		if err != nil {
			break
		}
		var meta *mediaproxy.FileMeta
		meta, err = r.Callback(f)
		_ = f.Close()
		src := f.Name()
		if err == nil && meta != nil {
			mime = meta.ContentType
			if meta.ReplacementFile != "" {
				_ = os.Remove(src)
				src = meta.ReplacementFile
			}
		}
		if err == nil {
			err = os.Rename(src, path)
		} else {
			_ = os.Remove(src)
		}
	case *mediaproxy.GetMediaResponseURL:
		err = downloadURL(ctx, r.URL, path, &mime)
	default:
		err = fmt.Errorf("beklenmeyen medya yanıtı %T", resp)
	}
	if err != nil {
		return "", "", errCode("media_failed", "%s", err.Error())
	}
	_ = os.Chmod(path, 0o600)
	writeTypeFile(path, mime)
	return path, mime, nil
}

func downloadURL(ctx context.Context, url, path string, mime *string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	*mime = resp.Header.Get("Content-Type")
	return writeAtomic(path, resp.Body)
}
