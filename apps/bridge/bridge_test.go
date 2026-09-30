package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/util/variationselector"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/simplevent"
	"maunium.net/go/mautrix/event"
)

// ---- olay yakalayıcı ----

type lineCatcher struct {
	mu     sync.Mutex
	buf    bytes.Buffer
	events []map[string]any
	notify chan struct{}
}

func (lc *lineCatcher) Write(p []byte) (int, error) {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	lc.buf.Write(p)
	for {
		line, err := lc.buf.ReadBytes('\n')
		if err != nil {
			lc.buf.Write(line)
			break
		}
		var m map[string]any
		if json.Unmarshal(line, &m) == nil {
			lc.events = append(lc.events, m)
		}
	}
	select {
	case lc.notify <- struct{}{}:
	default:
	}
	return len(p), nil
}

func (lc *lineCatcher) waitFor(t *testing.T, what string, match func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		lc.mu.Lock()
		for _, e := range lc.events {
			if match(e) {
				lc.mu.Unlock()
				return e
			}
		}
		lc.mu.Unlock()
		select {
		case <-lc.notify:
		case <-time.After(50 * time.Millisecond):
		case <-deadline:
			t.Fatalf("%s gelmedi", what)
		}
	}
}

func (lc *lineCatcher) count(match func(map[string]any) bool) int {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	n := 0
	for _, e := range lc.events {
		if match(e) {
			n++
		}
	}
	return n
}

func ev(name string) func(map[string]any) bool {
	return func(e map[string]any) bool { return e["ev"] == name }
}

func call(t *testing.T, method string, params any) map[string]any {
	t.Helper()
	raw, _ := json.Marshal(params)
	res, err := handlers[method](context.Background(), raw)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	b, _ := json.Marshal(res)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}

func body(e map[string]any) string {
	c, _ := e["content"].(map[string]any)
	s, _ := c["body"].(string)
	return s
}

func TestBridgeEndToEnd(t *testing.T) {
	dir := t.TempDir()
	dataRoot = filepath.Join(dir, "bridge")
	baseLog = zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr, NoColor: true}).Level(zerolog.WarnLevel)
	lc := &lineCatcher{notify: make(chan struct{}, 1)}
	out = &outWriter{w: bufio.NewWriter(lc)}
	fake := &fakeNet{}
	netDefs["fake"] = &netDef{name: "fake", flow: "input", make: func() bridgev2.NetworkConnector { return fake }}
	defer stopAll()

	// 1) giriş: kullanıcı bilgisi adımı → tamamlandı, hesap bağlandı
	st := call(t, "login.start", map[string]any{"net": "fake"})
	step := st["step"].(map[string]any)
	if step["type"] != "user_input" {
		t.Fatalf("ilk adım user_input olmalı: %v", step["type"])
	}
	done := call(t, "login.submit", map[string]any{"proc": st["proc"], "input": map[string]string{"name": "Kaan"}})
	if done["login"] != "L1" {
		t.Fatalf("giriş kimliği L1 olmalı: %v", done)
	}
	lc.waitFor(t, "CONNECTED durumu", func(e map[string]any) bool {
		return e["ev"] == "status" && e["login"] == "L1" && e["state"] == "CONNECTED"
	})

	// 2) karşıdan canlı mesaj: sohbet oluşur, mesaj "live" gelir, gönderen adı hayaletten
	ul := fake.br.GetCachedUserLoginByID("L1")
	ul.QueueRemoteEvent(&simplevent.Message[string]{
		EventMeta: simplevent.EventMeta{Type: bridgev2.RemoteEventMessage, PortalKey: dmKey,
			Sender: bridgev2.EventSender{Sender: "ayse"}, CreatePortal: true, Timestamp: time.Now()},
		ID: "m1", Data: "merhaba",
		ConvertMessageFunc: func(ctx context.Context, portal *bridgev2.Portal, intent bridgev2.MatrixAPI, data string) (*bridgev2.ConvertedMessage, error) {
			return &bridgev2.ConvertedMessage{Parts: []*bridgev2.ConvertedMessagePart{{
				Type: event.EventMessage, Content: &event.MessageEventContent{MsgType: event.MsgText, Body: data},
			}}}, nil
		},
	})
	chat := lc.waitFor(t, "sohbet", func(e map[string]any) bool { return e["ev"] == "chat" && e["name"] == "Ayşe Yılmaz" })
	if chat["type"] != "dm" || chat["login"] != "L1" || chat["portal"] != "dm-ayse" || chat["other"] != "ayse" {
		t.Fatalf("sohbet alanları yanlış: %v", chat)
	}
	room := chat["room"].(string)
	msg := lc.waitFor(t, "canlı mesaj", func(e map[string]any) bool { return e["ev"] == "message" && body(e) == "merhaba" })
	if msg["live"] != true || msg["rid"] != "m1" || msg["room"] != room {
		t.Fatalf("mesaj alanları yanlış: %v", msg)
	}
	sender := msg["sender"].(map[string]any)
	if sender["id"] != "ayse" || sender["me"] == true {
		t.Fatalf("gönderen yanlış: %v", sender)
	}
	eid := msg["rid"].(string)

	// 3) gönderim: ağa gider, yanıt olay kimliği + ağdaki kimlik
	sent := call(t, "send", map[string]any{"net": "fake", "room": room, "text": "selam", "replyTo": eid})
	if sent["rid"] != "sent1" || sent["mid"] != "sent1" {
		t.Fatalf("gönderim yanıtı yanlış: %v", sent)
	}
	if len(fake.sent) != 1 || fake.sent[0] != "selam" {
		t.Fatalf("ağa giden metin yanlış: %v", fake.sent)
	}

	// 4) tepki / tepkiyi geri al / düzenle / sil / okundu
	call(t, "react", map[string]any{"net": "fake", "room": room, "target": eid, "key": "👍"})
	if len(fake.reacts) != 1 || variationselector.Remove(fake.reacts[0]) != "👍" {
		t.Fatalf("tepki ağa gitmedi: %v", fake.reacts)
	}
	un := call(t, "unreact", map[string]any{"net": "fake", "room": room, "target": eid, "key": "👍"})
	if un["removed"] == "" || fake.unreact != 1 {
		t.Fatalf("tepki geri alınmadı: %v / %d", un, fake.unreact)
	}
	call(t, "edit", map[string]any{"net": "fake", "room": room, "target": sent["rid"], "text": "selamlar"})
	if len(fake.edits) != 1 || fake.edits[0] != "selamlar" {
		t.Fatalf("düzenleme ağa gitmedi: %v", fake.edits)
	}
	call(t, "redact", map[string]any{"net": "fake", "room": room, "target": sent["rid"]})
	if len(fake.removed) != 1 || fake.removed[0] != "sent1" {
		t.Fatalf("silme ağa gitmedi: %v", fake.removed)
	}
	call(t, "read", map[string]any{"net": "fake", "room": room})
	deadline := time.Now().Add(3 * time.Second)
	for fake.reads == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if fake.reads == 0 {
		t.Fatal("okundu bilgisi ağa gitmedi")
	}

	// 5) karşıdan tepki: hedef olay kimliğiyle gelir
	ul.QueueRemoteEvent(&simplevent.Reaction{
		EventMeta:     simplevent.EventMeta{Type: bridgev2.RemoteEventReaction, PortalKey: dmKey, Sender: bridgev2.EventSender{Sender: "ayse"}, Timestamp: time.Now()},
		TargetMessage: "m1", EmojiID: "❤️", Emoji: "❤️",
	})
	rc := lc.waitFor(t, "karşı tepki", func(e map[string]any) bool { return e["ev"] == "reaction" && e["key"] == "❤️" })
	if rc["target"] != eid {
		t.Fatalf("tepki hedefi yanlış: %v", rc)
	}

	// 6) eski mesajlar (yukarı kaydırma): batch, canlı değil, "ben" doğru
	bf := call(t, "backfill", map[string]any{"net": "fake", "room": room})
	if bf["done"] != true {
		t.Fatalf("geçmiş bitmeli: %v", bf)
	}
	old := lc.waitFor(t, "eski mesaj", func(e map[string]any) bool { return e["ev"] == "message" && body(e) == "eski yanıt" })
	if old["live"] != false || old["sender"].(map[string]any)["me"] != true {
		t.Fatalf("eski mesaj alanları yanlış: %v", old)
	}
	lc.waitFor(t, "batch sonu", ev("batch"))

	// 7) tam sohbet listesi + medya
	cl := call(t, "chats", map[string]any{"net": "fake", "login": "L1"})
	if n := len(cl["chats"].([]any)); n != 1 {
		t.Fatalf("1 sohbet olmalı: %d", n)
	}
	uri, err := nets["fake"].storeMedia([]byte("resim-verisi"), "a.jpg", "image/jpeg")
	if err != nil || !strings.HasPrefix(uri, mxcUpload) {
		t.Fatalf("medya saklanamadı: %v %v", uri, err)
	}
	md := call(t, "media", map[string]any{"net": "fake", "uri": uri})
	if md["mime"] != "image/jpeg" {
		t.Fatalf("medya türü yanlış: %v", md)
	}
	if b, _ := os.ReadFile(md["path"].(string)); string(b) != "resim-verisi" {
		t.Fatal("medya içeriği yanlış")
	}
	if n := lc.count(func(e map[string]any) bool { return e["ev"] == "message" && body(e) == "merhaba" }); n != 1 {
		t.Fatalf("canlı mesaj bir kez gelmeli: %d", n)
	}
}

func TestIDsRoundTrip(t *testing.T) {
	key := networkid.PortalKey{ID: "123@s.whatsapp.net", Receiver: "905000000099"}
	got, ok := portalKeyFromRoom(roomIDFor(key))
	if !ok || got != key {
		t.Fatalf("oda kimliği geri çözülemedi: %v", got)
	}
	g, ok := parseGhostMXID(ghostMXID("user:42"))
	if !ok || g != "user:42" {
		t.Fatalf("hayalet kimliği geri çözülemedi: %v", g)
	}
	if eventIDFor("!a", "m", "") == eventIDFor("!a", "m", "1") {
		t.Fatal("parça kimlikleri ayrışmalı")
	}
}

func TestWhatsAppRid(t *testing.T) {
	wa := &netBridge{name: "whatsapp"}
	if r := wa.ridOf("905000000099@s.whatsapp.net:905000000099@s.whatsapp.net:3EB0ABC", ""); r != "3EB0ABC" {
		t.Fatalf("WhatsApp rid eski kimlikle aynı olmalı: %s", r)
	}
	if r := wa.ridOf("a@g.us:b@lid:XYZ", "1"); r != "XYZ~1" {
		t.Fatalf("parça eki: %s", r)
	}
	ig := &netBridge{name: "instagram"}
	if r := ig.ridOf("mid.$abc:def", ""); r != "mid.$abc:def" {
		t.Fatalf("diğer ağlarda kimlik aynen: %s", r)
	}
}
