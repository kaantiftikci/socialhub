package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"time"

	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

// intent: bir "Matrix kullanıcısı" adına yapılan işlemler (hayalet = karşı taraf, me = kullanıcının kendisi, bot)
type intent struct {
	s     *shim
	mxid  id.UserID
	ghost networkid.UserID
	me    bool
	bot   bool
}

var _ bridgev2.MatrixAPI = (*intent)(nil)
var _ bridgev2.MarkAsDMMatrixAPI = (*intent)(nil)

func randomString() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (it *intent) GetMXID() id.UserID   { return it.mxid }
func (it *intent) IsDoublePuppet() bool { return it.me }

func (it *intent) SendMessage(ctx context.Context, roomID id.RoomID, eventType event.Type, content *event.Content, extra *bridgev2.MatrixSendExtra) (*mautrix.RespSendEvent, error) {
	evtID := it.s.eventIDFor(roomID, eventType, extra)
	if extra == nil {
		extra = &bridgev2.MatrixSendExtra{}
	}
	if extra.Timestamp.IsZero() {
		extra.Timestamp = time.Now()
	}
	it.s.emitEvent(ctx, roomID, it.mxid, eventType, content, extra, evtID, true)
	return &mautrix.RespSendEvent{EventID: evtID}, nil
}

func (it *intent) SendState(ctx context.Context, roomID id.RoomID, eventType event.Type, stateKey string, content *event.Content, ts time.Time) (*mautrix.RespSendEvent, error) {
	if content.Parsed == nil && content.VeryRaw != nil {
		_ = content.ParseRaw(eventType)
	}
	switch eventType {
	case event.StateMember:
		if mc, ok := content.Parsed.(*event.MemberEventContent); ok {
			it.s.setMember(roomID, id.UserID(stateKey), mc)
		}
		it.s.scheduleChat(roomID)
	case event.StateRoomName, event.StateRoomAvatar, event.StateTopic:
		it.s.scheduleChat(roomID)
	}
	return &mautrix.RespSendEvent{EventID: id.EventID(hashID("$s", string(roomID), eventType.Type, stateKey, randomString()))}, nil
}

func (it *intent) MarkRead(ctx context.Context, roomID id.RoomID, eventID id.EventID, ts time.Time) error {
	it.s.emitRoom("receipt", roomID, map[string]any{
		"eid": string(eventID), "rid": it.s.ridOfEvent(ctx, eventID), "sender": it.s.senderInfo(ctx, it.mxid, nil), "ts": ts.UnixMilli(),
	})
	return nil
}

func (it *intent) MarkUnread(ctx context.Context, roomID id.RoomID, unread bool) error {
	if it.me {
		it.s.emitRoom("unread", roomID, map[string]any{"unread": unread})
	}
	return nil
}

func (it *intent) MarkTyping(ctx context.Context, roomID id.RoomID, typingType bridgev2.TypingType, timeout time.Duration) error {
	if it.me || it.bot {
		return nil
	}
	it.s.emitRoom("typing", roomID, map[string]any{
		"sender": it.s.senderInfo(ctx, it.mxid, nil), "on": timeout > 0, "ms": timeout.Milliseconds(),
	})
	return nil
}

func (it *intent) DownloadMedia(ctx context.Context, uri id.ContentURIString, file *event.EncryptedFileInfo) ([]byte, error) {
	path, _, err := it.s.net.mediaFile(ctx, string(uri))
	if err != nil {
		return nil, err
	}
	return os.ReadFile(path)
}

func (it *intent) DownloadMediaToFile(ctx context.Context, uri id.ContentURIString, file *event.EncryptedFileInfo, writable bool, callback func(*os.File) error) error {
	path, _, err := it.s.net.mediaFile(ctx, string(uri))
	if err != nil {
		return err
	}
	if writable {
		// çağıran dosyayı değiştirebilir (ör. dönüştürme): önbelleği bozmasın diye geçici kopya
		tmp, err := copyToTemp(path)
		if err != nil {
			return err
		}
		defer os.Remove(tmp)
		path = tmp
	}
	f, err := os.OpenFile(path, map[bool]int{true: os.O_RDWR, false: os.O_RDONLY}[writable], 0)
	if err != nil {
		return err
	}
	defer f.Close()
	return callback(f)
}

func (it *intent) UploadMedia(ctx context.Context, roomID id.RoomID, data []byte, fileName, mimeType string) (id.ContentURIString, *event.EncryptedFileInfo, error) {
	uri, err := it.s.net.storeMedia(data, fileName, mimeType)
	return id.ContentURIString(uri), nil, err
}

func (it *intent) UploadMediaStream(ctx context.Context, roomID id.RoomID, size int64, requireFile bool, cb bridgev2.FileStreamCallback) (id.ContentURIString, *event.EncryptedFileInfo, error) {
	uri, err := it.s.net.storeMediaStream(cb)
	return id.ContentURIString(uri), nil, err
}

func (it *intent) SetDisplayName(ctx context.Context, name string) error {
	if it.ghost != "" {
		emit("ghost", map[string]any{"net": it.s.net.name, "id": string(it.ghost), "name": name})
	}
	return nil
}

func (it *intent) SetAvatarURL(ctx context.Context, avatarURL id.ContentURIString) error {
	if it.ghost != "" {
		emit("ghost", map[string]any{"net": it.s.net.name, "id": string(it.ghost), "avatar": string(avatarURL)})
	}
	return nil
}

func (it *intent) SetExtraProfileMeta(ctx context.Context, data any) error { return nil }
func (it *intent) SetProfile(ctx context.Context, data any) error          { return nil }

func (it *intent) CreateRoom(ctx context.Context, req *mautrix.ReqCreateRoom) (id.RoomID, error) {
	roomID := req.BeeperLocalRoomID
	if roomID == "" {
		return "", errors.New("oda kimliği yok")
	}
	for _, m := range req.BeeperInitialMembers {
		it.s.setMember(roomID, m, &event.MemberEventContent{Membership: event.MembershipJoin})
	}
	for _, st := range req.InitialState {
		if st.Type == event.StateMember && st.StateKey != nil {
			if mc, ok := st.Content.Parsed.(*event.MemberEventContent); ok {
				it.s.setMember(roomID, id.UserID(*st.StateKey), mc)
			}
		}
	}
	it.s.scheduleChat(roomID)
	return roomID, nil
}

func (it *intent) DeleteRoom(ctx context.Context, roomID id.RoomID, puppetsOnly bool) error {
	it.s.emitRoom("chat.delete", roomID, map[string]any{})
	return nil
}

func (it *intent) EnsureJoined(ctx context.Context, roomID id.RoomID, params ...bridgev2.EnsureJoinedParams) error {
	it.s.membersMu.Lock()
	_, ok := it.s.members[roomID][it.mxid]
	it.s.membersMu.Unlock()
	if !ok && !it.bot {
		it.s.setMember(roomID, it.mxid, &event.MemberEventContent{Membership: event.MembershipJoin})
	}
	return nil
}

func (it *intent) EnsureInvited(ctx context.Context, roomID id.RoomID, userID id.UserID) error {
	return nil
}

func (it *intent) TagRoom(ctx context.Context, roomID id.RoomID, tag event.RoomTag, isTagged bool) error {
	if it.me {
		it.s.emitRoom("tag", roomID, map[string]any{"tag": string(tag), "on": isTagged})
	}
	return nil
}

func (it *intent) MuteRoom(ctx context.Context, roomID id.RoomID, until time.Time) error {
	if it.me {
		it.s.emitRoom("mute", roomID, map[string]any{"until": until.UnixMilli()})
	}
	return nil
}

func (it *intent) MarkAsDM(ctx context.Context, roomID id.RoomID, otherUser id.UserID) error {
	return nil
}

func (it *intent) GetEvent(ctx context.Context, roomID id.RoomID, eventID id.EventID) (*event.Event, error) {
	return nil, mautrix.MNotFound
}
