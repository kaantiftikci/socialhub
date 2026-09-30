package main

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
)

// Giriş: bridgev2'nin adım adım giriş süreci çekirdeğe olduğu gibi aktarılır.
//
//	display_and_wait (QR)  → çekirdek QR'ı gösterir, login.wait ile bir sonraki adımı bekler
//	cookies                → çekirdek Mivelo'nun tarayıcı profilinden istenen çerez/yerel depo/istek alanlarını
//	                         toplar, login.submit {cookies} ile verir (kullanıcı şifresi Mivelo'dan geçmez)
//	user_input             → çekirdek alanları sorar (ör. Telegram'daki gibi 2FA kodu), login.submit {input}
//	complete               → giriş kimliği (login) döner; çekirdek hesabı bu kimlikle eşler
type loginProc struct {
	id   string
	nb   *netBridge
	proc bridgev2.LoginProcess
	step *bridgev2.LoginStep
	mu   sync.Mutex
}

var (
	loginsMu sync.Mutex
	logins   = map[string]*loginProc{}
)

type loginStartParams struct {
	Net     string `json:"net"`
	Flow    string `json:"flow"`
	Relogin string `json:"relogin"`
}

func loginStart(ctx context.Context, raw json.RawMessage) (any, error) {
	var p loginStartParams
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
	flow := p.Flow
	if flow == "" {
		flow = nb.def.flow
	}
	proc, err := nb.conn.CreateLogin(ctx, user, flow)
	if err != nil {
		return nil, err
	}
	bgCtx := nb.log.WithContext(context.Background())
	var step *bridgev2.LoginStep
	var override *bridgev2.UserLogin
	if p.Relogin != "" {
		override = nb.br.GetCachedUserLoginByID(networkid.UserLoginID(p.Relogin))
		if override == nil {
			override, _ = nb.br.GetExistingUserLoginByID(ctx, networkid.UserLoginID(p.Relogin))
		}
	}
	if pw, ok := proc.(bridgev2.LoginProcessWithOverride); ok && override != nil {
		step, err = pw.StartWithOverride(bgCtx, override)
	} else {
		step, err = proc.Start(bgCtx)
	}
	if err != nil {
		return nil, err
	}
	lp := &loginProc{id: randomString(), nb: nb, proc: proc, step: step}
	loginsMu.Lock()
	logins[lp.id] = lp
	loginsMu.Unlock()
	return lp.result(step), nil
}

func getLoginProc(raw json.RawMessage) (*loginProc, json.RawMessage, error) {
	var p struct {
		Proc string `json:"proc"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, nil, err
	}
	loginsMu.Lock()
	lp, ok := logins[p.Proc]
	loginsMu.Unlock()
	if !ok {
		return nil, nil, errCode("no_proc", "giriş süreci bulunamadı ya da bitti")
	}
	return lp, raw, nil
}

func (lp *loginProc) result(step *bridgev2.LoginStep) map[string]any {
	res := map[string]any{"proc": lp.id, "step": step}
	if step.Type == bridgev2.LoginStepTypeComplete && step.CompleteParams != nil {
		res["login"] = string(step.CompleteParams.UserLoginID)
		if ul := step.CompleteParams.UserLogin; ul != nil {
			res["name"] = ul.RemoteName
			res["profile"] = ul.RemoteProfile
		}
		loginsMu.Lock()
		delete(logins, lp.id)
		loginsMu.Unlock()
	}
	return res
}

func loginSubmit(ctx context.Context, raw json.RawMessage) (any, error) {
	lp, raw, err := getLoginProc(raw)
	if err != nil {
		return nil, err
	}
	var p struct {
		Cookies map[string]string `json:"cookies"`
		Input   map[string]string `json:"input"`
	}
	if err = json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	lp.mu.Lock()
	defer lp.mu.Unlock()
	bgCtx := lp.nb.log.WithContext(context.Background())
	var step *bridgev2.LoginStep
	switch {
	case p.Cookies != nil:
		c, ok := lp.proc.(bridgev2.LoginProcessCookies)
		if !ok {
			return nil, errCode("bad_step", "bu adım çerez beklemiyor")
		}
		step, err = c.SubmitCookies(bgCtx, p.Cookies)
	case p.Input != nil:
		c, ok := lp.proc.(bridgev2.LoginProcessUserInput)
		if !ok {
			return nil, errCode("bad_step", "bu adım bilgi beklemiyor")
		}
		step, err = c.SubmitUserInput(bgCtx, p.Input)
	default:
		return nil, errCode("bad_request", "çerez ya da bilgi gerekli")
	}
	if err != nil {
		return nil, loginError(err)
	}
	lp.step = step
	return lp.result(step), nil
}

func loginWait(ctx context.Context, raw json.RawMessage) (any, error) {
	lp, _, err := getLoginProc(raw)
	if err != nil {
		return nil, err
	}
	w, ok := lp.proc.(bridgev2.LoginProcessDisplayAndWait)
	if !ok {
		return nil, errCode("bad_step", "bu adım beklenemez")
	}
	// QR her ~20 sn yenilenir; Wait yeni QR adımı ya da tamamlanma ile döner
	waitCtx, cancel := context.WithTimeout(lp.nb.log.WithContext(context.Background()), 3*time.Minute)
	defer cancel()
	step, err := w.Wait(waitCtx)
	if err != nil {
		return nil, loginError(err)
	}
	lp.mu.Lock()
	lp.step = step
	lp.mu.Unlock()
	return lp.result(step), nil
}

func loginCancel(ctx context.Context, raw json.RawMessage) (any, error) {
	lp, _, err := getLoginProc(raw)
	if err != nil {
		return nil, nil
	}
	loginsMu.Lock()
	delete(logins, lp.id)
	loginsMu.Unlock()
	lp.proc.Cancel()
	return nil, nil
}

// loginError: bridgev2 RespError'ın kodunu korur (ör. FI.MAU.META.CHECKPOINT)
func loginError(err error) error {
	var re bridgev2.RespError
	if asRespError(err, &re) {
		return &rpcError{Code: re.ErrCode, Msg: re.Err}
	}
	return err
}
