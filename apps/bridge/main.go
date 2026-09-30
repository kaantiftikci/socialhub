// mivelo-bridge: Beeper'ın açık kaynak mautrix köprülerini (WhatsApp, Instagram, Messenger, X, LinkedIn, Slack)
// Matrix sunucusu OLMADAN çalıştıran yardımcı süreç. Mivelo çekirdeği (Node) bu süreci başlatır ve stdin/stdout
// üzerinden JSON satırlarıyla konuşur (bkz. rpc.go). Tüm veri kullanıcının cihazında: <veri klasörü>/bridge/<ağ>/.
//
// Lisans: bu klasör mautrix köprülerini içerdiği için GNU AGPL-3.0 altındadır (LICENSE).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"sort"
	"syscall"
	"time"

	"github.com/rs/zerolog"
)

var version = "dev"

type handlerFunc func(ctx context.Context, raw json.RawMessage) (any, error)

var handlers = map[string]handlerFunc{
	"hello":        hello,
	"login.start":  loginStart,
	"login.submit": loginSubmit,
	"login.wait":   loginWait,
	"login.cancel": loginCancel,
	"logins":       actLogins,
	"connect":      actConnect,
	"disconnect":   actDisconnect,
	"logout":       actLogout,
	"chats":        actChats,
	"open":         actOpen,
	"send":         actSend,
	"react":        actReact,
	"unreact":      actUnreact,
	"edit":         actEdit,
	"redact":       actRedact,
	"read":         actRead,
	"typing":       actTyping,
	"backfill":     actBackfill,
	"media":        actMedia,
}

func hello(ctx context.Context, raw json.RawMessage) (any, error) {
	names := make([]string, 0, len(netDefs))
	for n := range netDefs {
		names = append(names, n)
	}
	sort.Strings(names)
	return map[string]any{"version": version, "nets": names, "pid": os.Getpid()}, nil
}

func main() {
	dataDir := flag.String("data", "", "Mivelo veri klasörü (~/.mivelo)")
	logLevel := flag.String("log", "info", "günlük düzeyi (debug, info, warn, error)")
	showVersion := flag.Bool("version", false, "sürümü yaz ve çık")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	if *dataDir == "" {
		home, _ := os.UserHomeDir()
		*dataDir = filepath.Join(home, ".mivelo")
	}
	dataRoot = filepath.Join(*dataDir, "bridge")
	if os.Getenv("MIVELO_FAKE_NET") == "1" {
		registerFakeNet()
	}
	if err := os.MkdirAll(dataRoot, 0o700); err != nil {
		fmt.Fprintln(os.Stderr, "veri klasörü oluşturulamadı:", err)
		os.Exit(2)
	}
	lvl, err := zerolog.ParseLevel(*logLevel)
	if err != nil {
		lvl = zerolog.InfoLevel
	}
	// günlükler stderr'e; mesaj içeriği yazılmaz (bridgev2 içerik günlüğe yazmaz, yalnız kimlik/sayı)
	baseLog = zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr, NoColor: true, TimeFormat: time.TimeOnly}).
		Level(lvl).With().Timestamp().Str("svc", "bridge").Logger()
	zerolog.DefaultContextLogger = &baseLog

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		err := readRequests(os.Stdin, func(req *request) {
			defer func() {
				if r := recover(); r != nil {
					baseLog.Error().Interface("panic", r).Bytes("stack", debug.Stack()).Str("method", req.Method).Msg("istek işlenirken çöktü")
					reply(req.ID, nil, errCode("panic", "%v", r))
				}
			}()
			if req.Method == "shutdown" {
				reply(req.ID, nil, nil)
				close(done)
				return
			}
			h, ok := handlers[req.Method]
			if !ok {
				reply(req.ID, nil, errCode("unknown_method", "bilinmeyen işlem: %s", req.Method))
				return
			}
			res, err := h(ctx, req.Params)
			reply(req.ID, res, err)
		})
		if err != nil {
			baseLog.Warn().Err(err).Msg("stdin okunamadı")
		}
		// çekirdek kapandı (stdin EOF): köprü de kapanır
		select {
		case <-done:
		default:
			close(done)
		}
	}()
	emit("ready", map[string]any{"version": version, "pid": os.Getpid()})
	select {
	case <-done:
	case <-sig:
	}
	stopAll()
}
