package main

// Sahte ağ: köprü katmanını gerçek bir hesap olmadan uçtan uca sınamak için (Go testleri ve çekirdeğin Node testi).
// Üretimde kapalı: yalnız MIVELO_FAKE_NET=1 ortam değişkeniyle "fake" ağı olarak kaydedilir (main.go).

import (
	"context"
	"sync"
	"time"

	"go.mau.fi/util/configupgrade"
	"go.mau.fi/util/ptr"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/simplevent"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
)

type fakeNet struct {
	br      *bridgev2.Bridge
	mu      sync.Mutex
	sent    []string
	edits   []string
	removed []networkid.MessageID
	reacts  []string
	unreact int
	reads   int
}

func (f *fakeNet) Init(br *bridgev2.Bridge)        { f.br = br }
func (f *fakeNet) Start(ctx context.Context) error { return nil }
func (f *fakeNet) GetName() bridgev2.BridgeName {
	return bridgev2.BridgeName{DisplayName: "Fake", NetworkURL: "https://example.com", NetworkID: "fake", BeeperBridgeType: "fake"}
}
func (f *fakeNet) GetDBMetaTypes() database.MetaTypes { return database.MetaTypes{} }
func (f *fakeNet) GetCapabilities() *bridgev2.NetworkGeneralCapabilities {
	return &bridgev2.NetworkGeneralCapabilities{}
}
func (f *fakeNet) GetConfig() (string, any, configupgrade.Upgrader) { return "", nil, nil }
func (f *fakeNet) GetBridgeInfoVersion() (int, int)                 { return 1, 1 }
func (f *fakeNet) LoadUserLogin(ctx context.Context, login *bridgev2.UserLogin) error {
	login.Client = &fakeClient{net: f, ul: login}
	return nil
}
func (f *fakeNet) GetLoginFlows() []bridgev2.LoginFlow {
	return []bridgev2.LoginFlow{{ID: "input", Name: "input"}}
}
func (f *fakeNet) CreateLogin(ctx context.Context, user *bridgev2.User, flowID string) (bridgev2.LoginProcess, error) {
	return &fakeLogin{net: f, user: user}, nil
}

type fakeLogin struct {
	net  *fakeNet
	user *bridgev2.User
}

func (l *fakeLogin) Start(ctx context.Context) (*bridgev2.LoginStep, error) {
	return &bridgev2.LoginStep{Type: bridgev2.LoginStepTypeUserInput, StepID: "fake.name", UserInputParams: &bridgev2.LoginUserInputParams{
		Fields: []bridgev2.LoginInputDataField{{Type: bridgev2.LoginInputFieldTypeUsername, ID: "name", Name: "Ad"}},
	}}, nil
}
func (l *fakeLogin) Cancel() {}
func (l *fakeLogin) SubmitUserInput(ctx context.Context, input map[string]string) (*bridgev2.LoginStep, error) {
	ul, err := l.user.NewLogin(ctx, &database.UserLogin{ID: "L1", RemoteName: input["name"]}, &bridgev2.NewLoginParams{
		LoadUserLogin: func(ctx context.Context, login *bridgev2.UserLogin) error {
			login.Client = &fakeClient{net: l.net, ul: login}
			return nil
		},
	})
	if err != nil {
		return nil, err
	}
	go ul.Client.Connect(ul.Log.WithContext(context.Background()))
	return &bridgev2.LoginStep{Type: bridgev2.LoginStepTypeComplete, StepID: "fake.done",
		CompleteParams: &bridgev2.LoginCompleteParams{UserLoginID: ul.ID, UserLogin: ul}}, nil
}

type fakeClient struct {
	net       *fakeNet
	ul        *bridgev2.UserLogin
	connected bool
}

var dmKey = networkid.PortalKey{ID: "dm-ayse", Receiver: "L1"}

func (c *fakeClient) Connect(ctx context.Context) {
	c.connected = true
	c.ul.BridgeState.Send(status.BridgeState{StateEvent: status.StateConnected})
	if fakeAutoMessage {
		go func() {
			time.Sleep(300 * time.Millisecond)
			fakeIncoming(c.ul, "m1", "merhaba")
		}()
	}
}
func (c *fakeClient) Disconnect()                      { c.connected = false }
func (c *fakeClient) IsLoggedIn() bool                 { return true }
func (c *fakeClient) LogoutRemote(ctx context.Context) {}
func (c *fakeClient) IsThisUser(ctx context.Context, uid networkid.UserID) bool {
	return uid == "me"
}
func (c *fakeClient) GetChatInfo(ctx context.Context, portal *bridgev2.Portal) (*bridgev2.ChatInfo, error) {
	return &bridgev2.ChatInfo{
		Name: ptr.Ptr("Ayşe Yılmaz"),
		Type: ptr.Ptr(database.RoomTypeDM),
		Members: &bridgev2.ChatMemberList{IsFull: true, OtherUserID: "ayse", MemberMap: bridgev2.ChatMemberMap{
			"me":   {EventSender: bridgev2.EventSender{IsFromMe: true, Sender: "me"}},
			"ayse": {EventSender: bridgev2.EventSender{Sender: "ayse"}},
		}},
		CanBackfill: true,
	}, nil
}
func (c *fakeClient) GetUserInfo(ctx context.Context, ghost *bridgev2.Ghost) (*bridgev2.UserInfo, error) {
	name := "Ayşe Yılmaz"
	if ghost.ID == "me" {
		name = "Ben"
	}
	return &bridgev2.UserInfo{Name: &name, Identifiers: []string{"tel:+905000000099"}}, nil
}
func (c *fakeClient) GetCapabilities(ctx context.Context, portal *bridgev2.Portal) *event.RoomFeatures {
	return &event.RoomFeatures{
		ID: "fake", Reply: event.CapLevelFullySupported, Edit: event.CapLevelFullySupported,
		Delete: event.CapLevelFullySupported, Reaction: event.CapLevelFullySupported, ReadReceipts: true,
		File: event.FileFeatureMap{event.MsgImage: {MimeTypes: map[string]event.CapabilitySupportLevel{"*/*": event.CapLevelFullySupported}}},
	}
}
func (c *fakeClient) HandleMatrixMessage(ctx context.Context, msg *bridgev2.MatrixMessage) (*bridgev2.MatrixMessageResponse, error) {
	c.net.mu.Lock()
	c.net.sent = append(c.net.sent, msg.Content.Body)
	n := len(c.net.sent)
	c.net.mu.Unlock()
	return &bridgev2.MatrixMessageResponse{DB: &database.Message{
		ID: networkid.MessageID("sent" + string(rune('0'+n))), SenderID: "me", Timestamp: time.Now(),
	}}, nil
}
func (c *fakeClient) HandleMatrixEdit(ctx context.Context, msg *bridgev2.MatrixEdit) error {
	c.net.mu.Lock()
	c.net.edits = append(c.net.edits, msg.Content.Body)
	c.net.mu.Unlock()
	return nil
}
func (c *fakeClient) HandleMatrixMessageRemove(ctx context.Context, msg *bridgev2.MatrixMessageRemove) error {
	c.net.mu.Lock()
	c.net.removed = append(c.net.removed, msg.TargetMessage.ID)
	c.net.mu.Unlock()
	return nil
}
func (c *fakeClient) PreHandleMatrixReaction(ctx context.Context, msg *bridgev2.MatrixReaction) (bridgev2.MatrixReactionPreResponse, error) {
	return bridgev2.MatrixReactionPreResponse{SenderID: "me", EmojiID: networkid.EmojiID(msg.Content.RelatesTo.Key), Emoji: msg.Content.RelatesTo.Key}, nil
}
func (c *fakeClient) HandleMatrixReaction(ctx context.Context, msg *bridgev2.MatrixReaction) (*database.Reaction, error) {
	c.net.mu.Lock()
	c.net.reacts = append(c.net.reacts, msg.Content.RelatesTo.Key)
	c.net.mu.Unlock()
	return nil, nil
}
func (c *fakeClient) HandleMatrixReactionRemove(ctx context.Context, msg *bridgev2.MatrixReactionRemove) error {
	c.net.mu.Lock()
	c.net.unreact++
	c.net.mu.Unlock()
	return nil
}
func (c *fakeClient) HandleMatrixReadReceipt(ctx context.Context, msg *bridgev2.MatrixReadReceipt) error {
	c.net.mu.Lock()
	c.net.reads++
	c.net.mu.Unlock()
	return nil
}
func (c *fakeClient) FetchMessages(ctx context.Context, p bridgev2.FetchMessagesParams) (*bridgev2.FetchMessagesResponse, error) {
	if p.Forward {
		return &bridgev2.FetchMessagesResponse{Forward: true}, nil
	}
	base := time.Now().Add(-48 * time.Hour)
	mk := func(id, text string, fromMe bool, ts time.Time) *bridgev2.BackfillMessage {
		sender := bridgev2.EventSender{Sender: "ayse"}
		if fromMe {
			sender = bridgev2.EventSender{Sender: "me", IsFromMe: true}
		}
		return &bridgev2.BackfillMessage{
			ConvertedMessage: &bridgev2.ConvertedMessage{Parts: []*bridgev2.ConvertedMessagePart{{
				Type: event.EventMessage, Content: &event.MessageEventContent{MsgType: event.MsgText, Body: text},
			}}},
			Sender: sender, ID: networkid.MessageID(id), Timestamp: ts,
		}
	}
	return &bridgev2.FetchMessagesResponse{
		Messages: []*bridgev2.BackfillMessage{mk("old1", "eski selam", false, base), mk("old2", "eski yanıt", true, base.Add(time.Minute))},
		HasMore:  false,
	}, nil
}

var (
	_ bridgev2.EditHandlingNetworkAPI        = (*fakeClient)(nil)
	_ bridgev2.RedactionHandlingNetworkAPI   = (*fakeClient)(nil)
	_ bridgev2.ReactionHandlingNetworkAPI    = (*fakeClient)(nil)
	_ bridgev2.ReadReceiptHandlingNetworkAPI = (*fakeClient)(nil)
	_ bridgev2.BackfillingNetworkAPI         = (*fakeClient)(nil)
)

// autoMessage: sahte hesap bağlanınca (Node testi için) karşıdan bir mesaj gelir
var fakeAutoMessage = false

func fakeIncoming(ul *bridgev2.UserLogin, id, text string) {
	ul.QueueRemoteEvent(&simplevent.Message[string]{
		EventMeta: simplevent.EventMeta{Type: bridgev2.RemoteEventMessage, PortalKey: networkid.PortalKey{ID: "dm-ayse", Receiver: ul.ID},
			Sender: bridgev2.EventSender{Sender: "ayse"}, CreatePortal: true, Timestamp: time.Now()},
		ID: networkid.MessageID(id), Data: text,
		ConvertMessageFunc: func(ctx context.Context, portal *bridgev2.Portal, intent bridgev2.MatrixAPI, data string) (*bridgev2.ConvertedMessage, error) {
			return &bridgev2.ConvertedMessage{Parts: []*bridgev2.ConvertedMessagePart{{
				Type: event.EventMessage, Content: &event.MessageEventContent{MsgType: event.MsgText, Body: data},
			}}}, nil
		},
	})
}

func registerFakeNet() {
	fakeAutoMessage = true
	netDefs["fake"] = &netDef{name: "fake", flow: "input", make: func() bridgev2.NetworkConnector { return &fakeNet{} }}
}
