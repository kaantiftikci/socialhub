package main

import (
	"context"
	"errors"
	"sync"
	"time"

	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

// shim: bridgev2'nin beklediği "Matrix sunucusu" — gerçek sunucu yerine olayları çekirdeğe iletir.
// Oda = sohbet, olay = mesaj/tepki/düzenleme; odalar ve üyeler yalnız bellekte tutulur (kalıcı kayıt köprünün
// kendi veritabanında: portal/message/reaction tabloları).
type shim struct {
	net *netBridge
	br  *bridgev2.Bridge

	intentsMu sync.Mutex
	ghosts    map[networkid.UserID]*intent
	me        *intent
	bot       *intent

	membersMu sync.Mutex
	members   map[id.RoomID]map[id.UserID]*event.MemberEventContent

	pendingMu sync.Mutex
	pending   map[id.EventID]chan *bridgev2.MessageStatus

	chatMu    sync.Mutex
	chatTimer map[id.RoomID]*time.Timer

	ridMu    sync.Mutex
	ridCache map[id.EventID]string
}

var _ bridgev2.MatrixConnector = (*shim)(nil)

func newShim(nb *netBridge) *shim {
	s := &shim{
		net:       nb,
		ghosts:    make(map[networkid.UserID]*intent),
		members:   make(map[id.RoomID]map[id.UserID]*event.MemberEventContent),
		pending:   make(map[id.EventID]chan *bridgev2.MessageStatus),
		chatTimer: make(map[id.RoomID]*time.Timer),
	}
	s.me = &intent{s: s, mxid: meMXID, me: true}
	s.bot = &intent{s: s, mxid: botMXID, bot: true}
	return s
}

func (s *shim) Init(br *bridgev2.Bridge)        { s.br = br }
func (s *shim) Start(ctx context.Context) error { return nil }
func (s *shim) PreStop()                        {}
func (s *shim) Stop()                           {}
func (s *shim) ServerName() string              { return serverName }

func (s *shim) GetCapabilities() *bridgev2.MatrixCapabilities {
	return &bridgev2.MatrixCapabilities{AutoJoinInvites: true, BatchSending: true}
}

func (s *shim) ParseGhostMXID(u id.UserID) (networkid.UserID, bool) { return parseGhostMXID(u) }
func (s *shim) FormatGhostMXID(u networkid.UserID) id.UserID        { return ghostMXID(u) }

func (s *shim) GhostIntent(uid networkid.UserID) bridgev2.MatrixAPI {
	s.intentsMu.Lock()
	defer s.intentsMu.Unlock()
	it, ok := s.ghosts[uid]
	if !ok {
		it = &intent{s: s, mxid: ghostMXID(uid), ghost: uid}
		s.ghosts[uid] = it
	}
	return it
}

// Çift kukla (double puppet): kullanıcının kendi hesabından giden/okunan her şey "ben" olarak gelir
func (s *shim) NewUserIntent(ctx context.Context, userID id.UserID, accessToken string) (bridgev2.MatrixAPI, string, error) {
	if userID != meMXID {
		return nil, "", errors.New("bilinmeyen kullanıcı")
	}
	return s.me, "mivelo", nil
}

func (s *shim) BotIntent() bridgev2.MatrixAPI { return s.bot }

func (s *shim) SendBridgeStatus(ctx context.Context, state *status.BridgeState) error {
	if state.RemoteID == "" {
		return nil
	}
	f := map[string]any{
		"net":     s.net.name,
		"login":   string(state.RemoteID),
		"state":   string(state.StateEvent),
		"error":   string(state.Error),
		"message": state.Message,
		"name":    state.RemoteName,
	}
	if state.UserAction != "" {
		f["action"] = string(state.UserAction)
	}
	p := state.RemoteProfile
	prof := map[string]any{}
	if p.Name != "" {
		prof["name"] = p.Name
	}
	if p.Username != "" {
		prof["username"] = p.Username
	}
	if p.Phone != "" {
		prof["phone"] = p.Phone
	}
	if p.Email != "" {
		prof["email"] = p.Email
	}
	if p.Avatar != "" {
		prof["avatar"] = string(p.Avatar)
	}
	if len(prof) > 0 {
		f["profile"] = prof
	}
	emit("status", f)
	return nil
}

func (s *shim) SendMessageStatus(ctx context.Context, ms *bridgev2.MessageStatus, evt *bridgev2.MessageStatusEventInfo) {
	if evt == nil || ms == nil {
		return
	}
	// yalnız kesin sonuçlar bekleyen gönderimi çözer (başarı ya da kalıcı hata)
	if ms.Status != event.MessageStatusSuccess && ms.Status != event.MessageStatusFail && ms.Status != event.MessageStatusRetriable {
		return
	}
	s.pendingMu.Lock()
	ch, ok := s.pending[evt.SourceEventID]
	if ok {
		delete(s.pending, evt.SourceEventID)
	}
	s.pendingMu.Unlock()
	if ok {
		ch <- ms
	}
}

func (s *shim) waitStatus(evtID id.EventID) chan *bridgev2.MessageStatus {
	ch := make(chan *bridgev2.MessageStatus, 1)
	s.pendingMu.Lock()
	s.pending[evtID] = ch
	s.pendingMu.Unlock()
	return ch
}

func (s *shim) dropWait(evtID id.EventID) {
	s.pendingMu.Lock()
	delete(s.pending, evtID)
	s.pendingMu.Unlock()
}

func (s *shim) GenerateContentURI(ctx context.Context, mediaID networkid.MediaID) (id.ContentURIString, error) {
	return id.ContentURIString(mxcDirect + b64.EncodeToString(mediaID)), nil
}

func (s *shim) ParseContentURI(ctx context.Context, uri id.ContentURIString) (networkid.MediaID, error) {
	str := string(uri)
	if len(str) > len(mxcDirect) && str[:len(mxcDirect)] == mxcDirect {
		b, err := b64.DecodeString(str[len(mxcDirect):])
		if err == nil {
			return networkid.MediaID(b), nil
		}
	}
	return nil, errCode("not_direct", "doğrudan medya adresi değil")
}

func (s *shim) GetPowerLevels(ctx context.Context, roomID id.RoomID) (*event.PowerLevelsEventContent, error) {
	return &event.PowerLevelsEventContent{
		Users: map[id.UserID]int{botMXID: 9001, meMXID: 100},
	}, nil
}

func (s *shim) GetMembers(ctx context.Context, roomID id.RoomID) (map[id.UserID]*event.MemberEventContent, error) {
	s.membersMu.Lock()
	defer s.membersMu.Unlock()
	res := make(map[id.UserID]*event.MemberEventContent, len(s.members[roomID]))
	for k, v := range s.members[roomID] {
		res[k] = v
	}
	return res, nil
}

func (s *shim) GetMemberInfo(ctx context.Context, roomID id.RoomID, userID id.UserID) (*event.MemberEventContent, error) {
	s.membersMu.Lock()
	defer s.membersMu.Unlock()
	return s.members[roomID][userID], nil
}

func (s *shim) setMember(roomID id.RoomID, userID id.UserID, content *event.MemberEventContent) {
	s.membersMu.Lock()
	defer s.membersMu.Unlock()
	m := s.members[roomID]
	if m == nil {
		m = make(map[id.UserID]*event.MemberEventContent)
		s.members[roomID] = m
	}
	if content == nil || content.Membership == event.MembershipLeave || content.Membership == event.MembershipBan {
		delete(m, userID)
	} else {
		m[userID] = content
	}
}

func (s *shim) BatchSend(ctx context.Context, roomID id.RoomID, req *mautrix.ReqBeeperBatchSend, extras []*bridgev2.MatrixSendExtra) (*mautrix.RespBeeperBatchSend, error) {
	ids := make([]id.EventID, len(req.Events))
	for i, evt := range req.Events {
		var extra *bridgev2.MatrixSendExtra
		if i < len(extras) {
			extra = extras[i]
		}
		evtID := evt.ID
		if evtID == "" {
			evtID = s.eventIDFor(roomID, evt.Type, extra)
		}
		ids[i] = evtID
		if extra == nil {
			extra = &bridgev2.MatrixSendExtra{}
		}
		if extra.Timestamp.IsZero() {
			extra.Timestamp = time.UnixMilli(evt.Timestamp)
		}
		s.emitEvent(ctx, roomID, evt.Sender, evt.Type, &evt.Content, extra, evtID, false)
	}
	s.emitRoom("batch", roomID, map[string]any{
		"forward":  req.Forward || req.ForwardIfNoMessages,
		"markRead": req.MarkReadBy != "",
		"count":    len(req.Events),
		"last":     lastOr(ids),
	})
	return &mautrix.RespBeeperBatchSend{EventIDs: ids}, nil
}

func lastOr(ids []id.EventID) string {
	if len(ids) == 0 {
		return ""
	}
	return string(ids[len(ids)-1])
}

func (s *shim) GenerateDeterministicRoomID(key networkid.PortalKey) id.RoomID { return roomIDFor(key) }

func (s *shim) GenerateDeterministicEventID(roomID id.RoomID, _ networkid.PortalKey, messageID networkid.MessageID, partID networkid.PartID) id.EventID {
	return eventIDFor(roomID, messageID, partID)
}

func (s *shim) GenerateReactionEventID(roomID id.RoomID, target *database.Message, sender networkid.UserID, emoji networkid.EmojiID) id.EventID {
	var mid, part string
	if target != nil {
		mid, part = string(target.ID), string(target.PartID)
	}
	return id.EventID(hashID("$r", string(roomID), mid, part, string(sender), string(emoji)))
}

func (s *shim) eventIDFor(roomID id.RoomID, typ event.Type, extra *bridgev2.MatrixSendExtra) id.EventID {
	if extra != nil && extra.MessageMeta != nil && extra.MessageMeta.ID != "" {
		return eventIDFor(roomID, extra.MessageMeta.ID, extra.MessageMeta.PartID)
	}
	if extra != nil && extra.ReactionMeta != nil {
		r := extra.ReactionMeta
		return id.EventID(hashID("$r", string(roomID), string(r.MessageID), string(r.MessagePartID), string(r.SenderID), string(r.EmojiID)))
	}
	return id.EventID(hashID("$x", string(roomID), typ.Type, time.Now().String(), randomString()))
}

// ---- sohbet anlık görüntüsü: oda durumu değişince kısa gecikmeyle bir kez yayınlanır ----

func (s *shim) scheduleChat(roomID id.RoomID) {
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	if t, ok := s.chatTimer[roomID]; ok {
		t.Reset(300 * time.Millisecond)
		return
	}
	s.chatTimer[roomID] = time.AfterFunc(300*time.Millisecond, func() {
		s.chatMu.Lock()
		delete(s.chatTimer, roomID)
		s.chatMu.Unlock()
		s.emitChat(context.Background(), roomID)
	})
}

func (s *shim) emitChat(ctx context.Context, roomID id.RoomID) {
	key, ok := portalKeyFromRoom(roomID)
	if !ok || s.br == nil {
		return
	}
	portal, err := s.br.GetExistingPortalByKey(ctx, key)
	if err != nil || portal == nil {
		return
	}
	emit("chat", s.chatFields(ctx, portal))
}

func (s *shim) chatFields(ctx context.Context, portal *bridgev2.Portal) map[string]any {
	room := roomIDFor(portal.PortalKey)
	f := map[string]any{
		"net":    s.net.name,
		"login":  string(portal.Receiver),
		"room":   string(room),
		"portal": string(portal.ID),
		"name":   portal.Name,
		"type":   string(portal.RoomType),
	}
	if portal.Topic != "" {
		f["topic"] = portal.Topic
	}
	if portal.AvatarMXC != "" {
		f["avatar"] = string(portal.AvatarMXC)
	}
	if portal.MessageRequest {
		f["request"] = true
	}
	if portal.OtherUserID != "" {
		f["other"] = string(portal.OtherUserID)
		if g, err := s.br.GetExistingGhostByID(ctx, portal.OtherUserID); err == nil && g != nil {
			f["otherName"] = g.Name
			if g.AvatarMXC != "" {
				f["otherAvatar"] = string(g.AvatarMXC)
			}
			if len(g.Identifiers) > 0 {
				f["otherIds"] = g.Identifiers
			}
		}
	}
	s.membersMu.Lock()
	mem := s.members[room]
	list := make([]map[string]any, 0, min(len(mem), 300))
	for uid, m := range mem {
		if len(list) >= 300 {
			break
		}
		if uid == botMXID {
			continue
		}
		item := map[string]any{"name": m.Displayname}
		if uid == meMXID {
			item["me"] = true
		} else if gid, ok := parseGhostMXID(uid); ok {
			item["id"] = string(gid)
		}
		if m.AvatarURL != "" {
			item["avatar"] = string(m.AvatarURL)
		}
		list = append(list, item)
	}
	s.membersMu.Unlock()
	if len(list) > 0 {
		f["members"] = list
	}
	return f
}

func (s *shim) emitRoom(ev string, roomID id.RoomID, f map[string]any) {
	key, _ := portalKeyFromRoom(roomID)
	f["net"] = s.net.name
	f["login"] = string(key.Receiver)
	f["room"] = string(roomID)
	f["portal"] = string(key.ID)
	emit(ev, f)
}

// emitEvent: köprünün "Matrix'e gönderdiği" her olayı çekirdeğin anlayacağı biçime çevirir
func (s *shim) emitEvent(ctx context.Context, roomID id.RoomID, sender id.UserID, typ event.Type, content *event.Content, extra *bridgev2.MatrixSendExtra, evtID id.EventID, live bool) {
	if content.Parsed == nil && content.VeryRaw != nil {
		_ = content.ParseRaw(typ)
	}
	ts := time.Now()
	if extra != nil && !extra.Timestamp.IsZero() {
		ts = extra.Timestamp
	}
	who := s.senderInfo(ctx, sender, extra)
	switch typ {
	case event.EventReaction:
		rc, _ := content.Parsed.(*event.ReactionEventContent)
		if rc == nil {
			return
		}
		target := ""
		if extra != nil && extra.ReactionMeta != nil {
			target = s.net.ridOf(extra.ReactionMeta.MessageID, extra.ReactionMeta.MessagePartID)
		}
		if target == "" {
			target = s.ridOfEvent(ctx, rc.RelatesTo.EventID)
		}
		s.emitRoom("reaction", roomID, map[string]any{
			"eid": string(evtID), "target": target, "key": rc.RelatesTo.Key,
			"sender": who, "ts": ts.UnixMilli(), "live": live,
		})
	case event.EventRedaction:
		rc, _ := content.Parsed.(*event.RedactionEventContent)
		if rc == nil {
			return
		}
		f := map[string]any{"sender": who, "ts": ts.UnixMilli()}
		if r, err := s.br.DB.Reaction.GetByMXID(ctx, rc.Redacts); err == nil && r != nil {
			f["kind"] = "reaction"
			f["target"] = s.net.ridOf(r.MessageID, r.MessagePartID)
			key := r.Emoji
			if key == "" {
				key = string(r.EmojiID)
			}
			f["key"] = key
			f["sender"] = s.senderInfo(ctx, ghostMXID(r.SenderID), nil)
			if s.isOwnID(ctx, r.Room.Receiver, r.SenderID) {
				f["sender"] = map[string]any{"me": true}
			}
		} else {
			f["kind"] = "message"
			f["target"] = s.ridOfEvent(ctx, rc.Redacts)
		}
		if f["target"] == "" {
			return
		}
		s.emitRoom("redact", roomID, f)
	case event.EventMessage, event.EventSticker:
		msg, _ := content.Parsed.(*event.MessageEventContent)
		if msg == nil {
			return
		}
		if msg.RelatesTo != nil && msg.RelatesTo.Type == event.RelReplace && msg.NewContent != nil {
			target := s.ridOfEvent(ctx, msg.RelatesTo.EventID)
			if target == "" {
				return
			}
			s.emitRoom("edit", roomID, map[string]any{
				"target": target, "content": msg.NewContent, "sender": who, "ts": ts.UnixMilli(),
			})
			return
		}
		f := map[string]any{
			"eid": string(evtID), "sender": who, "ts": ts.UnixMilli(), "live": live,
			"type": typ.Type, "content": content,
		}
		rid := ""
		if extra != nil && extra.MessageMeta != nil && extra.MessageMeta.ID != "" {
			rid = s.net.ridOf(extra.MessageMeta.ID, extra.MessageMeta.PartID)
		}
		if rid == "" {
			rid = string(evtID) // ağ kimliği olmayan köprü bildirimi
		}
		f["rid"] = rid
		s.rememberRid(evtID, rid)
		if msg.RelatesTo != nil {
			if r := msg.RelatesTo.GetReplyTo(); r != "" {
				if t := s.ridOfEvent(ctx, r); t != "" {
					f["reply"] = t
				}
			}
			if th := msg.RelatesTo.GetThreadParent(); th != "" {
				if t := s.ridOfEvent(ctx, th); t != "" {
					f["thread"] = t
				}
			}
		}
		s.emitRoom("message", roomID, f)
	default:
		// durum olayları (ad, avatar, üyelik) SendState'ten; bilinmeyen zaman çizelgesi olayı atlanır
	}
}

// Son yayınlanan olay kimlikleri → rid (aynı toplu gönderimdeki yanıt/tepki hedefi henüz veritabanında değil)
func (s *shim) rememberRid(evt id.EventID, rid string) {
	s.ridMu.Lock()
	defer s.ridMu.Unlock()
	if s.ridCache == nil || len(s.ridCache) > 50_000 {
		s.ridCache = make(map[id.EventID]string, 1024)
	}
	s.ridCache[evt] = rid
}

func (s *shim) ridOfEvent(ctx context.Context, evt id.EventID) string {
	if evt == "" {
		return ""
	}
	s.ridMu.Lock()
	rid, ok := s.ridCache[evt]
	s.ridMu.Unlock()
	if ok {
		return rid
	}
	return s.net.ridOfEvent(ctx, evt)
}

func (s *shim) senderInfo(ctx context.Context, sender id.UserID, extra *bridgev2.MatrixSendExtra) map[string]any {
	if sender == meMXID {
		return map[string]any{"me": true}
	}
	if sender == botMXID {
		return map[string]any{"bot": true}
	}
	gid, ok := parseGhostMXID(sender)
	if !ok {
		return map[string]any{"id": string(sender)}
	}
	f := map[string]any{"id": string(gid)}
	if s.br != nil {
		if g, err := s.br.GetExistingGhostByID(ctx, gid); err == nil && g != nil {
			if g.Name != "" {
				f["name"] = g.Name
			}
			if g.AvatarMXC != "" {
				f["avatar"] = string(g.AvatarMXC)
			}
		}
	}
	// kendi başka cihazımdan gönderdiğim mesaj: ağ kimliği giriş kimliğiyle aynıysa "ben"
	if extra != nil && extra.MessageMeta != nil && extra.MessageMeta.Room.Receiver != "" {
		if s.isOwnID(ctx, extra.MessageMeta.Room.Receiver, gid) {
			f["me"] = true
		}
	}
	return f
}

func (s *shim) isOwnID(ctx context.Context, login networkid.UserLoginID, uid networkid.UserID) bool {
	if s.br == nil {
		return false
	}
	ul := s.br.GetCachedUserLoginByID(login)
	if ul == nil {
		return false
	}
	return ul.Client != nil && ul.Client.IsThisUser(ctx, uid)
}
