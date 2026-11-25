package main

import (
	"fmt"
	"reflect"

	"gopkg.in/yaml.v3"
	"maunium.net/go/mautrix/bridgev2"

	linkedin "go.mau.fi/mautrix-linkedin/pkg/connector"
	messenger "go.mau.fi/mautrix-meta/pkg/connector"
	instagram "go.mau.fi/mautrix-meta/pkg/igconnector"
	slack "go.mau.fi/mautrix-slack/pkg/connector"
	twitter "go.mau.fi/mautrix-twitter/pkg/connector"
	whatsapp "go.mau.fi/mautrix-whatsapp/pkg/connector"
)

// netDef: Mivelo platform adı → Beeper (mautrix) ağ bağlayıcısı, varsayılan giriş akışı ve ayar farkları.
// Ayarlar bağlayıcının kendi örnek yapılandırmasından okunur, üstüne yalnız buradaki farklar yazılır.
type netDef struct {
	name      string
	flow      string // varsayılan giriş akışı (cookies / qr)
	make      func() bridgev2.NetworkConnector
	overrides map[string]any
}

var netDefs = map[string]*netDef{
	"whatsapp": {
		name: "whatsapp",
		flow: "qr",
		make: func() bridgev2.NetworkConnector { return &whatsapp.WhatsAppConnector{} },
		overrides: map[string]any{
			// telefonda "Bağlı cihazlar" listesinde görünen ad
			"os_name":                 "Mivelo",
			"browser_name":            "chrome",
			"displayname_template":    `{{or .FullName .BusinessName .PushName .Phone "WhatsApp kişisi"}}`,
			"identity_change_notices": false,
			"enable_status_broadcast": false,
			"url_previews":            false,
			"pinned_tag":              "m.favourite",
			"archive_tag":             tagArchive,
			"status_broadcast_tag":    "m.lowpriority",
			"history_sync": map[string]any{
				"max_initial_conversations": -1,
				"request_full_sync":         true,
				"dispatch_wait":             "30s",
			},
		},
	},
	"instagram": {
		name: "instagram",
		flow: "instagram",
		make: func() bridgev2.NetworkConnector { return &instagram.IGConnector{} },
		overrides: map[string]any{
			"displayname_template": `{{or .DisplayName .Username "Instagram kullanıcısı"}}`,
		},
	},
	"messenger": {
		name: "messenger",
		flow: "facebook",
		make: func() bridgev2.NetworkConnector { return &messenger.MetaConnector{} },
		overrides: map[string]any{
			"displayname_template": `{{or .DisplayName .Username "Messenger kullanıcısı"}}`,
		},
	},
	"x": {
		name: "x",
		flow: "cookies",
		make: func() bridgev2.NetworkConnector { return &twitter.TwitterConnector{} },
		overrides: map[string]any{
			"displayname_template":    "{{ .DisplayName }}",
			"conversation_sync_limit": 100,
			"x":                       true,
		},
	},
	"linkedin": {
		name: "linkedin",
		flow: "cookies",
		make: func() bridgev2.NetworkConnector { return &linkedin.LinkedInConnector{} },
		overrides: map[string]any{
			"displayname_template": "{{ with .Organization }}{{ . }}{{ else }}{{ .FirstName }} {{ .LastName }}{{ end }}",
			"sync":                 map[string]any{"update_limit": 0, "create_limit": 50},
		},
	},
	"slack": {
		name: "slack",
		flow: "token",
		make: func() bridgev2.NetworkConnector { return &slack.SlackConnector{} },
		overrides: map[string]any{
			"displayname_template":            "{{or .Profile.DisplayName .Profile.RealName .Name}}{{if .IsBot}} (bot){{end}}",
			"participant_sync_count":          20,
			"workspace_avatar_in_rooms":       false,
			"mute_channels_by_default":        false,
			"custom_emoji_reactions":          true,
			"participant_sync_only_on_create": true,
		},
	},
}

// Arşiv etiketi: WhatsApp arşivi bu etiketle gelir, çekirdek meta.archived yapar
const tagArchive = "mivelo.archive"

// loadNetConfig bağlayıcının örnek yapılandırmasını okur, farkları üstüne yazar ve bağlayıcının ayar yapısına açar.
func loadNetConfig(def *netDef, conn bridgev2.NetworkConnector) error {
	example, data, _ := conn.GetConfig()
	if data == nil {
		return nil
	}
	var base map[string]any
	if err := yaml.Unmarshal([]byte(example), &base); err != nil {
		return fmt.Errorf("%s örnek ayarı okunamadı: %w", def.name, err)
	}
	if base == nil {
		base = map[string]any{}
	}
	mergeMaps(base, def.overrides)
	merged, err := yaml.Marshal(base)
	if err != nil {
		return err
	}
	if reflect.ValueOf(data).Kind() != reflect.Pointer {
		return fmt.Errorf("%s ayar yapısı işaretçi değil", def.name)
	}
	if err = yaml.Unmarshal(merged, data); err != nil {
		return fmt.Errorf("%s ayarı uygulanamadı: %w", def.name, err)
	}
	if v, ok := conn.(bridgev2.ConfigValidatingNetwork); ok {
		if err = v.ValidateConfig(); err != nil {
			return fmt.Errorf("%s ayarı geçersiz: %w", def.name, err)
		}
	}
	return nil
}

func mergeMaps(dst, src map[string]any) {
	for k, v := range src {
		if sm, ok := v.(map[string]any); ok {
			if dm, ok := dst[k].(map[string]any); ok {
				mergeMaps(dm, sm)
				continue
			}
		}
		dst[k] = v
	}
}
