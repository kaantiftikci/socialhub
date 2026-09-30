package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/util/dbutil"
	_ "go.mau.fi/util/dbutil/litestream"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/bridgeconfig"
	"maunium.net/go/mautrix/bridgev2/commands"
	"maunium.net/go/mautrix/bridgev2/networkid"
)

// netBridge: tek bir ağ (ör. whatsapp) için bridgev2 örneği. Aynı ağdaki tüm Mivelo hesapları ayrı UserLogin'ler.
type netBridge struct {
	name     string
	def      *netDef
	conn     bridgev2.NetworkConnector
	br       *bridgev2.Bridge
	shim     *shim
	db       *dbutil.Database
	dir      string
	mediaDir string
	log      zerolog.Logger
}

var (
	netsMu sync.Mutex
	nets   = map[string]*netBridge{}
	// dataRoot: <MIVELO_DATA_DIR>/bridge
	dataRoot string
	baseLog  zerolog.Logger
)

func bridgeConfig() *bridgeconfig.BridgeConfig {
	return &bridgeconfig.BridgeConfig{
		CommandPrefix:                 "!mivelo",
		SplitPortals:                  true,
		PrivateChatPortalMeta:         true,
		BridgeMatrixLeave:             false,
		TagOnlyOnCreate:               false,
		MuteOnlyOnCreate:              false,
		DeduplicateMatrixMessages:     true,
		PortalEventBuffer:             64,
		CrossRoomReplies:              false,
		UnknownErrorAutoReconnect:     time.Minute,
		UnknownErrorMaxAutoReconnects: 5,
		TransientStateDebounce:        5 * time.Second,
		CleanupOnLogout: bridgeconfig.CleanupOnLogouts{
			Enabled: true,
			Manual: bridgeconfig.CleanupOnLogout{
				Private: bridgeconfig.CleanupActionDelete, Relayed: bridgeconfig.CleanupActionDelete,
				SharedNoUsers: bridgeconfig.CleanupActionDelete, SharedHasUsers: bridgeconfig.CleanupActionDelete,
			},
			BadCredentials: bridgeconfig.CleanupOnLogout{
				Private: bridgeconfig.CleanupActionNull, Relayed: bridgeconfig.CleanupActionNull,
				SharedNoUsers: bridgeconfig.CleanupActionNull, SharedHasUsers: bridgeconfig.CleanupActionNull,
			},
		},
		Permissions: bridgeconfig.PermissionConfig{
			"*": &bridgeconfig.Permissions{SendEvents: true, Commands: true, Login: true, DoublePuppet: true, Admin: true},
		},
		Backfill: bridgeconfig.BackfillConfig{
			Enabled:              true,
			MaxInitialMessages:   100,
			MaxCatchupMessages:   500,
			UnreadHoursThreshold: 24 * 30,
			Threads:              bridgeconfig.BackfillThreadsConfig{MaxInitialMessages: 20},
			// geriye doğru (eski mesajlar) yalnız kullanıcı yukarı kaydırınca: el ile tetiklenen görevler
			Queue: bridgeconfig.BackfillQueueConfig{Enabled: false, Manual: true, BatchSize: 50, BatchDelay: 5, MaxBatches: -1},
		},
	}
}

func getNet(ctx context.Context, name string) (*netBridge, error) {
	netsMu.Lock()
	defer netsMu.Unlock()
	if nb, ok := nets[name]; ok {
		return nb, nil
	}
	def, ok := netDefs[name]
	if !ok {
		return nil, errCode("unknown_net", "bilinmeyen ağ: %s", name)
	}
	nb, err := startNet(ctx, def)
	if err != nil {
		return nil, err
	}
	nets[name] = nb
	return nb, nil
}

func startNet(ctx context.Context, def *netDef) (*netBridge, error) {
	dir := filepath.Join(dataRoot, def.name)
	media := filepath.Join(dir, "media")
	if err := os.MkdirAll(media, 0o700); err != nil {
		return nil, err
	}
	log := baseLog.With().Str("net", def.name).Logger()
	conn := def.make()
	if err := loadNetConfig(def, conn); err != nil {
		return nil, err
	}
	dbPath := filepath.Join(dir, "bridge.db")
	db, err := dbutil.NewFromConfig("mivelo-bridge/"+def.name, dbutil.Config{
		PoolConfig: dbutil.PoolConfig{
			Type:         "sqlite3-fk-wal",
			URI:          "file:" + dbPath + "?_txlock=immediate",
			MaxOpenConns: 5,
			MaxIdleConns: 1,
		},
	}, dbutil.ZeroLogger(log.With().Str("component", "db").Logger()))
	if err != nil {
		return nil, fmt.Errorf("%s veritabanı açılamadı: %w", def.name, err)
	}
	_ = os.Chmod(dbPath, 0o600)
	nb := &netBridge{name: def.name, def: def, conn: conn, db: db, dir: dir, mediaDir: media, log: log}
	nb.shim = newShim(nb)
	nb.br = bridgev2.NewBridge(networkid.BridgeID(def.name), db, log, bridgeConfig(), nb.shim, conn, commands.NewProcessor)
	if dm, ok := conn.(bridgev2.DirectMediableNetwork); ok {
		dm.SetUseDirectMedia()
	}
	if err = nb.br.StartConnectors(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("%s başlatılamadı: %w", def.name, err)
	}
	// geriye doğru eşitleme kuyruğu (el ile görevler) — StartLogins çağrılmadığı için kendimiz başlatırız
	go nb.br.RunBackfillQueue()
	return nb, nil
}

func (nb *netBridge) user(ctx context.Context) (*bridgev2.User, error) {
	return nb.br.GetUserByMXID(ctx, meMXID)
}

func (nb *netBridge) login(ctx context.Context, loginID string) (*bridgev2.UserLogin, error) {
	ul, err := nb.br.GetExistingUserLoginByID(ctx, networkid.UserLoginID(loginID))
	if err != nil {
		return nil, err
	}
	if ul == nil {
		return nil, errCode("no_login", "oturum bulunamadı (%s)", nb.name)
	}
	return ul, nil
}

func stopAll() {
	netsMu.Lock()
	defer netsMu.Unlock()
	var wg sync.WaitGroup
	for _, nb := range nets {
		wg.Add(1)
		go func(nb *netBridge) {
			defer wg.Done()
			nb.br.StopWithTimeout(8 * time.Second)
			_ = nb.db.Close()
		}(nb)
	}
	wg.Wait()
}
