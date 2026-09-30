package main

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/rs/zerolog"
)

// Gerçek bağlayıcılar ağsız açılabilmeli ve çerezli giriş adımını vermeli (alanlar çekirdeğin topladığı çerezler)
func TestRealNetsStart(t *testing.T) {
	dataRoot = filepath.Join(t.TempDir(), "bridge")
	baseLog = zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr, NoColor: true}).Level(zerolog.ErrorLevel)
	out = &outWriter{w: bufio.NewWriter(io.Discard)}
	defer stopAll()
	for _, name := range []string{"whatsapp", "instagram", "messenger", "x", "linkedin", "slack"} {
		if _, err := getNet(t.Context(), name); err != nil {
			t.Fatalf("%s açılamadı: %v", name, err)
		}
	}
	for _, name := range []string{"instagram", "messenger", "x", "linkedin", "slack"} {
		res := call(t, "login.start", map[string]any{"net": name})
		step := res["step"].(map[string]any)
		if step["type"] != "cookies" {
			t.Fatalf("%s: çerez adımı beklendi, gelen %v", name, step["type"])
		}
		c := step["cookies"].(map[string]any)
		ids := []string{}
		for _, f := range c["fields"].([]any) {
			ids = append(ids, f.(map[string]any)["id"].(string))
		}
		t.Logf("%s: url=%v alanlar=%v extract_js=%v", name, c["url"], ids, c["extract_js"] != nil)
		call(t, "login.cancel", map[string]any{"proc": res["proc"]})
	}
}
