package main

import (
	"crypto/sha256"
	"encoding/base64"
	"strings"

	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/id"
)

// Matrix kimlikleri yalnız bu süreç içinde anlamlı; gerçek bir Matrix sunucusu yok. Oda kimliği portal anahtarını,
// hayalet kullanıcı kimliği ağdaki kullanıcı kimliğini geri çözülebilir biçimde taşır.
const serverName = "mivelo.local"

var b64 = base64.RawURLEncoding

var (
	meMXID  = id.UserID("@me:" + serverName)
	botMXID = id.UserID("@bot:" + serverName)
)

func enc(s string) string { return b64.EncodeToString([]byte(s)) }

func dec(s string) (string, bool) {
	b, err := b64.DecodeString(s)
	return string(b), err == nil
}

func roomIDFor(key networkid.PortalKey) id.RoomID {
	return id.RoomID("!" + enc(string(key.ID)) + "~" + enc(string(key.Receiver)) + ":" + serverName)
}

func portalKeyFromRoom(room id.RoomID) (networkid.PortalKey, bool) {
	s := strings.TrimPrefix(string(room), "!")
	s = strings.TrimSuffix(s, ":"+serverName)
	a, b, ok := strings.Cut(s, "~")
	if !ok {
		return networkid.PortalKey{}, false
	}
	pid, ok1 := dec(a)
	recv, ok2 := dec(b)
	if !ok1 || !ok2 {
		return networkid.PortalKey{}, false
	}
	return networkid.PortalKey{ID: networkid.PortalID(pid), Receiver: networkid.UserLoginID(recv)}, true
}

func ghostMXID(uid networkid.UserID) id.UserID {
	return id.UserID("@g_" + enc(string(uid)) + ":" + serverName)
}

func parseGhostMXID(u id.UserID) (networkid.UserID, bool) {
	s := string(u)
	if !strings.HasPrefix(s, "@g_") || !strings.HasSuffix(s, ":"+serverName) {
		return "", false
	}
	v, ok := dec(strings.TrimSuffix(strings.TrimPrefix(s, "@g_"), ":"+serverName))
	return networkid.UserID(v), ok
}

func hashID(prefix string, parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	return prefix + b64.EncodeToString(h.Sum(nil))[:27]
}

func eventIDFor(room id.RoomID, msg networkid.MessageID, part networkid.PartID) id.EventID {
	return id.EventID(hashID("$m", string(room), string(msg), string(part)))
}

// Medya adresleri:
//
//	mxc://d/<b64 mediaID>  — ağdan istek üzerine indirilecek (doğrudan medya)
//	mxc://u/<sha256>       — köprünün yüklediği, diskte duran dosya
//	mxc://f/<b64 yol>      — çekirdeğin gönderim için verdiği yerel dosya
const (
	mxcDirect = "mxc://d/"
	mxcUpload = "mxc://u/"
	mxcFile   = "mxc://f/"
)
