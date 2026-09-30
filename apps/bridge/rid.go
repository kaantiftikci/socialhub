package main

import (
	"context"
	"strings"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/id"
)

// rid: çekirdeğin (Mivelo) mesaj kimliği. Ağın mesaj kimliğinden türetilir; çok parçalı mesajlarda "~parça" eki.
// WhatsApp'ta köprü kimliği "sohbet:gönderen:kimlik" biçiminde; Mivelo'nun eski WhatsApp bağlayıcısı yalnız son parçayı
// (WhatsApp mesaj kimliği) kullanıyordu → aynı mesaj yeniden eşitlenince kopya oluşmasın diye yalnız o kısım alınır.
func (nb *netBridge) ridOf(msgID networkid.MessageID, part networkid.PartID) string {
	base := string(msgID)
	if nb.name == "whatsapp" {
		if i := strings.LastIndexByte(base, ':'); i >= 0 {
			base = base[i+1:]
		}
	}
	if part != "" {
		return base + "~" + string(part)
	}
	return base
}

func (nb *netBridge) ridOfMsg(m *database.Message) string {
	if m == nil {
		return ""
	}
	return nb.ridOf(m.ID, m.PartID)
}

// ridOfEvent olay kimliğinden (mesaj parçası) rid; bulunamazsa boş
func (nb *netBridge) ridOfEvent(ctx context.Context, evt id.EventID) string {
	if evt == "" || nb.br == nil {
		return ""
	}
	m, err := nb.br.DB.Message.GetPartByMXID(ctx, evt)
	if err != nil || m == nil {
		return ""
	}
	return nb.ridOf(m.ID, m.PartID)
}

// messageByRid çekirdeğin verdiği rid'i köprüdeki mesaj parçasına çözer
func (nb *netBridge) messageByRid(ctx context.Context, portal *bridgev2.Portal, rid string) (*database.Message, error) {
	base, part, _ := strings.Cut(rid, "~")
	if base == "" {
		return nil, errCode("no_target", "mesaj kimliği boş")
	}
	// önce tam kimlik (WhatsApp dışı ağlarda doğrudan eşleşir)
	if m, err := nb.br.DB.Message.GetFirstOrSpecificPartByID(ctx, portal.Receiver, networkid.MessageOptionalPartID{
		MessageID: networkid.MessageID(base), PartID: optPart(part),
	}); err == nil && m != nil && m.Room == portal.PortalKey {
		return m, nil
	}
	// WhatsApp: "…:kimlik" ile biten
	like := "%:" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(base)
	q := `SELECT id, part_id FROM message WHERE bridge_id=$1 AND room_id=$2 AND room_receiver=$3 AND id LIKE $4 ESCAPE '\'`
	args := []any{string(nb.br.ID), string(portal.ID), string(portal.Receiver), like}
	if part != "" {
		q += ` AND part_id=$5`
		args = append(args, part)
	}
	q += ` ORDER BY rowid LIMIT 1`
	var mid, pid string
	if err := nb.db.QueryRow(ctx, q, args...).Scan(&mid, &pid); err != nil {
		return nil, errCode("no_target", "mesaj bulunamadı")
	}
	return nb.br.DB.Message.GetPartByID(ctx, portal.Receiver, networkid.MessageID(mid), networkid.PartID(pid))
}

func optPart(p string) *networkid.PartID {
	if p == "" {
		return nil
	}
	v := networkid.PartID(p)
	return &v
}

// eventByRid: rid → Matrix olay kimliği (tepki/yanıt/düzenleme/silme hedefi)
func (nb *netBridge) eventByRid(ctx context.Context, portal *bridgev2.Portal, rid string) (id.EventID, error) {
	if strings.HasPrefix(rid, "$") {
		return id.EventID(rid), nil
	}
	m, err := nb.messageByRid(ctx, portal, rid)
	if err != nil {
		return "", err
	}
	if m == nil || m.MXID == "" {
		return "", errCode("no_target", "mesaj bulunamadı")
	}
	return m.MXID, nil
}
