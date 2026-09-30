package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"go.mau.fi/util/variationselector"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

func asRespError(err error, out *bridgev2.RespError) bool {
	if errors.As(err, out) {
		return true
	}
	var p *bridgev2.RespError
	if errors.As(err, &p) && p != nil {
		*out = *p
		return true
	}
	return false
}

type roomParams struct {
	Net  string `json:"net"`
	Room string `json:"room"`
}

func (p *roomParams) resolve(ctx context.Context) (*netBridge, *bridgev2.Portal, error) {
	nb, err := getNet(ctx, p.Net)
	if err != nil {
		return nil, nil, err
	}
	key, ok := portalKeyFromRoom(id.RoomID(p.Room))
	if !ok {
		return nil, nil, errCode("bad_room", "geçersiz sohbet kimliği")
	}
	portal, err := nb.br.GetExistingPortalByKey(ctx, key)
	if err != nil {
		return nil, nil, err
	}
	if portal == nil || portal.MXID == "" {
		return nil, nil, errCode("no_room", "sohbet bulunamadı")
	}
	return nb, portal, nil
}

// queueAndWait: "ben" adına bir Matrix olayı köprüye verir, ağın sonucunu (başarı/hata) bekler
func queueAndWait(ctx context.Context, nb *netBridge, evt *event.Event, timeout time.Duration) (*bridgev2.MessageStatus, error) {
	evt.Sender = meMXID
	if evt.ID == "" {
		evt.ID = id.EventID("$mv" + randomString())
	}
	if evt.Timestamp == 0 {
		evt.Timestamp = time.Now().UnixMilli()
	}
	ch := nb.shim.waitStatus(evt.ID)
	res := nb.br.QueueMatrixEvent(nb.log.WithContext(context.Background()), evt)
	if !res.Queued && !res.Success {
		nb.shim.dropWait(evt.ID)
		if res.Error != nil {
			return nil, res.Error
		}
		if res.Ignored {
			return nil, errCode("ignored", "işlem yok sayıldı")
		}
		return nil, errCode("failed", "işlem başarısız")
	}
	select {
	case st := <-ch:
		if st.Status != event.MessageStatusSuccess {
			msg := st.Message
			if msg == "" && st.InternalError != nil {
				msg = st.InternalError.Error()
			}
			if msg == "" {
				msg = string(st.ErrorReason)
			}
			return st, errCode("send_failed", "%s", msg)
		}
		return st, nil
	case <-time.After(timeout):
		nb.shim.dropWait(evt.ID)
		if res.Success {
			return nil, nil
		}
		return nil, errCode("timeout", "yanıt gelmedi")
	case <-ctx.Done():
		nb.shim.dropWait(evt.ID)
		return nil, ctx.Err()
	}
}

type sendFile struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Mime     string `json:"mime"`
	Size     int    `json:"size"`
	W        int    `json:"w"`
	H        int    `json:"h"`
	Duration int    `json:"duration"`
	Voice    bool   `json:"voice"`
}

type sendParams struct {
	roomParams
	Text    string    `json:"text"`
	HTML    string    `json:"html"`
	ReplyTo string    `json:"replyTo"`
	Thread  string    `json:"thread"`
	File    *sendFile `json:"file"`
}

func actSend(ctx context.Context, raw json.RawMessage) (any, error) {
	var p sendParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	nb, portal, err := p.resolve(ctx)
	if err != nil {
		return nil, err
	}
	content := &event.MessageEventContent{MsgType: event.MsgText, Body: p.Text}
	if p.HTML != "" {
		content.Format = event.FormatHTML
		content.FormattedBody = p.HTML
	}
	if f := p.File; f != nil {
		content.MsgType = msgTypeFor(f.Mime)
		if f.Voice {
			content.MsgType = event.MsgAudio
			content.MSC3245Voice = &event.MSC3245Voice{}
		}
		content.URL = id.ContentURIString(mxcFile + enc(f.Path))
		content.Info = &event.FileInfo{MimeType: f.Mime, Size: f.Size, Width: f.W, Height: f.H, Duration: f.Duration}
		content.FileName = f.Name
		content.Body = f.Name
		if p.Text != "" {
			content.Body = p.Text // başlık (caption): dosya adı FileName'de
		}
	}
	if p.ReplyTo != "" || p.Thread != "" {
		content.RelatesTo = &event.RelatesTo{}
		var reply, thread id.EventID
		if p.ReplyTo != "" {
			reply, _ = nb.eventByRid(ctx, portal, p.ReplyTo)
		}
		if p.Thread != "" {
			thread, _ = nb.eventByRid(ctx, portal, p.Thread)
		}
		if thread != "" {
			content.RelatesTo.SetThread(thread, reply)
		}
		if reply != "" {
			content.RelatesTo.SetReplyTo(reply)
		}
	}
	evt := &event.Event{Type: event.EventMessage, RoomID: portal.MXID, Content: event.Content{Parsed: content}}
	if _, err = queueAndWait(ctx, nb, evt, 2*time.Minute); err != nil {
		return nil, err
	}
	res := map[string]any{"eid": string(evt.ID), "ts": evt.Timestamp, "rid": string(evt.ID)}
	if msg, _ := nb.br.DB.Message.GetPartByMXID(ctx, evt.ID); msg != nil {
		res["mid"] = string(msg.ID)
		res["rid"] = nb.ridOfMsg(msg)
		if !msg.Timestamp.IsZero() {
			res["ts"] = msg.Timestamp.UnixMilli()
		}
	}
	nb.shim.rememberRid(evt.ID, res["rid"].(string))
	return res, nil
}

func msgTypeFor(mime string) event.MessageType {
	switch {
	case strings.HasPrefix(mime, "image/"):
		return event.MsgImage
	case strings.HasPrefix(mime, "video/"):
		return event.MsgVideo
	case strings.HasPrefix(mime, "audio/"):
		return event.MsgAudio
	default:
		return event.MsgFile
	}
}

type targetParams struct {
	roomParams
	Target string `json:"target"`
	Key    string `json:"key"`
	Text   string `json:"text"`
}

func actReact(ctx context.Context, raw json.RawMessage) (any, error) {
	var p targetParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	nb, portal, err := p.resolve(ctx)
	if err != nil {
		return nil, err
	}
	target, err := nb.eventByRid(ctx, portal, p.Target)
	if err != nil {
		return nil, err
	}
	evt := &event.Event{Type: event.EventReaction, RoomID: portal.MXID, Content: event.Content{Parsed: &event.ReactionEventContent{
		RelatesTo: event.RelatesTo{Type: event.RelAnnotation, EventID: target, Key: variationselector.Add(p.Key)},
	}}}
	if _, err = queueAndWait(ctx, nb, evt, time.Minute); err != nil {
		return nil, err
	}
	return map[string]any{"eid": string(evt.ID)}, nil
}

func actUnreact(ctx context.Context, raw json.RawMessage) (any, error) {
	var p targetParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	nb, portal, err := p.resolve(ctx)
	if err != nil {
		return nil, err
	}
	target, err := nb.messageByRid(ctx, portal, p.Target)
	if err != nil || target == nil {
		return nil, errCode("no_target", "mesaj bulunamadı")
	}
	ul := nb.br.GetCachedUserLoginByID(portal.Receiver)
	if ul == nil {
		return nil, errCode("no_login", "oturum bağlı değil")
	}
	reactions, err := nb.br.DB.Reaction.GetAllToMessage(ctx, portal.Receiver, target.ID)
	if err != nil {
		return nil, err
	}
	// Emoji ya da EmojiID ile eşleşen kendi tepkim; ağ emojiyi kendi koduyla saklıyorsa (Slack ":+1:") ve
	// mesajda tek tepkim varsa o
	want := variationselector.Remove(p.Key)
	var mine []*database.Reaction
	var match *database.Reaction
	for _, r := range reactions {
		if !ul.Client.IsThisUser(ctx, r.SenderID) {
			continue
		}
		mine = append(mine, r)
		if p.Key == "" || variationselector.Remove(r.Emoji) == want || variationselector.Remove(string(r.EmojiID)) == want {
			match = r
		}
	}
	if match == nil && len(mine) == 1 {
		match = mine[0]
	}
	if r := match; r != nil {
		evt := &event.Event{Type: event.EventRedaction, RoomID: portal.MXID, Redacts: r.MXID,
			Content: event.Content{Parsed: &event.RedactionEventContent{Redacts: r.MXID}}}
		if _, err = queueAndWait(ctx, nb, evt, time.Minute); err != nil {
			return nil, err
		}
		return map[string]any{"removed": string(r.MXID)}, nil
	}
	return map[string]any{"removed": ""}, nil
}

func actEdit(ctx context.Context, raw json.RawMessage) (any, error) {
	var p targetParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	nb, portal, err := p.resolve(ctx)
	if err != nil {
		return nil, err
	}
	target, err := nb.eventByRid(ctx, portal, p.Target)
	if err != nil {
		return nil, err
	}
	nc := &event.MessageEventContent{MsgType: event.MsgText, Body: p.Text}
	content := &event.MessageEventContent{
		MsgType: event.MsgText, Body: "* " + p.Text, NewContent: nc,
		RelatesTo: &event.RelatesTo{Type: event.RelReplace, EventID: target},
	}
	evt := &event.Event{Type: event.EventMessage, RoomID: portal.MXID, Content: event.Content{Parsed: content}}
	if _, err = queueAndWait(ctx, nb, evt, time.Minute); err != nil {
		return nil, err
	}
	return nil, nil
}

func actRedact(ctx context.Context, raw json.RawMessage) (any, error) {
	var p targetParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	nb, portal, err := p.resolve(ctx)
	if err != nil {
		return nil, err
	}
	target, err := nb.eventByRid(ctx, portal, p.Target)
	if err != nil {
		return nil, err
	}
	evt := &event.Event{Type: event.EventRedaction, RoomID: portal.MXID, Redacts: target,
		Content: event.Content{Parsed: &event.RedactionEventContent{Redacts: target}}}
	if _, err = queueAndWait(ctx, nb, evt, time.Minute); err != nil {
		return nil, err
	}
	return nil, nil
}

// actRead: okundu bilgisi. silent → yalnız köprüde işaretlenmez, hiç gönderilmez (çekirdek zaten çağırmaz)
func actRead(ctx context.Context, raw json.RawMessage) (any, error) {
	var p targetParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	nb, portal, err := p.resolve(ctx)
	if err != nil {
		return nil, err
	}
	var target id.EventID
	if p.Target != "" {
		target, _ = nb.eventByRid(ctx, portal, p.Target)
	}
	if target == "" {
		last, err := nb.br.DB.Message.GetLastNInPortal(ctx, portal.PortalKey, 1)
		if err != nil || len(last) == 0 {
			return nil, nil
		}
		target = last[0].MXID
	}
	evt := &event.Event{
		Type: event.EphemeralEventReceipt, RoomID: portal.MXID,
		Mautrix: event.MautrixInfo{EventSource: event.SourceEphemeral},
		Content: event.Content{Parsed: &event.ReceiptEventContent{
			target: {event.ReceiptTypeRead: {meMXID: {Timestamp: time.Now()}}},
		}},
	}
	nb.br.QueueMatrixEvent(nb.log.WithContext(context.Background()), evt)
	return nil, nil
}

func actTyping(ctx context.Context, raw json.RawMessage) (any, error) {
	var p struct {
		roomParams
		On bool `json:"on"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	nb, portal, err := p.resolve(ctx)
	if err != nil {
		return nil, err
	}
	users := []id.UserID{}
	if p.On {
		users = append(users, meMXID)
	}
	evt := &event.Event{Type: event.EphemeralEventTyping, RoomID: portal.MXID,
		Mautrix: event.MautrixInfo{EventSource: event.SourceEphemeral},
		Content: event.Content{Parsed: &event.TypingEventContent{UserIDs: users}}}
	nb.br.QueueMatrixEvent(nb.log.WithContext(context.Background()), evt)
	return nil, nil
}

// actBackfill: eski mesajlar (yukarı kaydırınca). Mesajlar batch olaylarıyla gelir; yanıt bitince döner.
func actBackfill(ctx context.Context, raw json.RawMessage) (any, error) {
	var p roomParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	nb, portal, err := p.resolve(ctx)
	if err != nil {
		return nil, err
	}
	source := nb.br.GetCachedUserLoginByID(portal.Receiver)
	if source == nil || !source.Client.IsLoggedIn() {
		return nil, errCode("no_login", "oturum bağlı değil")
	}
	if err = nb.br.DB.BackfillTask.EnsureExists(ctx, portal.PortalKey, source.ID); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	nb.br.WakeupBackfillQueue(&bridgev2.ManualBackfill{Source: source, Portal: portal, DoneCallback: func(err error) {
		done <- err
	}})
	select {
	case err = <-done:
	case <-time.After(90 * time.Second):
		return map[string]any{"timedOut": true}, nil
	}
	task, _ := nb.br.DB.BackfillTask.GetNextForPortal(ctx, portal.PortalKey, true)
	res := map[string]any{"done": task == nil || task.IsDone}
	if err != nil {
		res["error"] = err.Error()
	}
	return res, nil
}

func actMedia(ctx context.Context, raw json.RawMessage) (any, error) {
	var p struct {
		Net string `json:"net"`
		URI string `json:"uri"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	nb, err := getNet(ctx, p.Net)
	if err != nil {
		return nil, err
	}
	path, mime, err := nb.mediaFile(ctx, p.URI)
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": path, "mime": mime}, nil
}

type loginParams struct {
	Net   string `json:"net"`
	Login string `json:"login"`
}

func actConnect(ctx context.Context, raw json.RawMessage) (any, error) {
	var p loginParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	nb, err := getNet(ctx, p.Net)
	if err != nil {
		return nil, err
	}
	ul, err := nb.login(ctx, p.Login)
	if err != nil {
		return nil, err
	}
	if ul.Client.IsLoggedIn() {
		// zaten bağlıysa önce kopar (yeniden bağlan)
		ul.DisconnectWithTimeout(5 * time.Second)
	}
	// çekirdek yeni bağlayıcıyla bağlanıyor: "bağlandı" durumu, öncekiyle aynı olsa da yeniden gönderilsin
	ul.BridgeState.SetPrev(status.BridgeState{})
	go ul.Client.Connect(ul.Log.WithContext(nb.br.BackgroundCtx))
	return map[string]any{"name": ul.RemoteName, "profile": ul.RemoteProfile}, nil
}

func actDisconnect(ctx context.Context, raw json.RawMessage) (any, error) {
	var p loginParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	nb, err := getNet(ctx, p.Net)
	if err != nil {
		return nil, err
	}
	if ul := nb.br.GetCachedUserLoginByID(networkid.UserLoginID(p.Login)); ul != nil {
		ul.DisconnectWithTimeout(5 * time.Second)
	}
	return nil, nil
}

// actLogout: platformdan da çıkış (WhatsApp'ta bağlı cihaz silinir) + köprüdeki tüm sohbet kayıtları
func actLogout(ctx context.Context, raw json.RawMessage) (any, error) {
	var p loginParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	nb, err := getNet(ctx, p.Net)
	if err != nil {
		return nil, err
	}
	ul, err := nb.br.GetExistingUserLoginByID(ctx, networkid.UserLoginID(p.Login))
	if err != nil || ul == nil {
		return nil, nil
	}
	lctx, cancel := context.WithTimeout(nb.log.WithContext(context.Background()), 30*time.Second)
	defer cancel()
	ul.Logout(lctx)
	return nil, nil
}

func actLogins(ctx context.Context, raw json.RawMessage) (any, error) {
	var p loginParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	nb, err := getNet(ctx, p.Net)
	if err != nil {
		return nil, err
	}
	user, err := nb.user(ctx)
	if err != nil {
		return nil, err
	}
	list := []map[string]any{}
	for _, ul := range user.GetUserLogins() {
		list = append(list, map[string]any{"login": string(ul.ID), "name": ul.RemoteName, "profile": ul.RemoteProfile})
	}
	return map[string]any{"logins": list}, nil
}

// actChats: bir oturumun tüm sohbetleri (çekirdek yeniden başlayınca tam eşitleme)
func actChats(ctx context.Context, raw json.RawMessage) (any, error) {
	var p loginParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	nb, err := getNet(ctx, p.Net)
	if err != nil {
		return nil, err
	}
	portals, err := nb.br.GetAllPortalsWithMXID(ctx)
	if err != nil {
		return nil, err
	}
	list := []map[string]any{}
	for _, portal := range portals {
		if p.Login != "" && string(portal.Receiver) != p.Login {
			continue
		}
		list = append(list, nb.shim.chatFields(ctx, portal))
	}
	return map[string]any{"chats": list}, nil
}

// actOpen: kullanıcı adı / telefon ile yeni birebir sohbet (varsa mevcut)
func actOpen(ctx context.Context, raw json.RawMessage) (any, error) {
	var p struct {
		loginParams
		Identifier string `json:"identifier"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	nb, err := getNet(ctx, p.Net)
	if err != nil {
		return nil, err
	}
	ul, err := nb.login(ctx, p.Login)
	if err != nil {
		return nil, err
	}
	api, ok := ul.Client.(bridgev2.IdentifierResolvingNetworkAPI)
	if !ok {
		return nil, errCode("unsupported", "bu ağda yeni sohbet açılamıyor")
	}
	resp, err := api.ResolveIdentifier(ctx, p.Identifier, true)
	if err != nil {
		return nil, err
	}
	if resp == nil || resp.Chat == nil {
		return nil, errCode("not_found", "kişi bulunamadı")
	}
	portal := resp.Chat.Portal
	if portal == nil {
		portal, err = nb.br.GetPortalByKey(ctx, resp.Chat.PortalKey)
		if err != nil {
			return nil, err
		}
	}
	if portal.MXID == "" {
		if err = portal.CreateMatrixRoom(ctx, ul, resp.Chat.PortalInfo); err != nil {
			return nil, err
		}
	}
	return map[string]any{"room": string(portal.MXID), "chat": nb.shim.chatFields(ctx, portal)}, nil
}
