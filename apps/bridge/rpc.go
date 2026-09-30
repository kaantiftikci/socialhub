// Mivelo köprüsü — çekirdekle (Node) konuşma: stdin'den satır satır JSON istek, stdout'a satır satır JSON yanıt/olay.
//
//	istek : {"id":1,"m":"send","p":{...}}
//	yanıt : {"id":1,"r":{...}}  ya da  {"id":1,"e":{"code":"...","msg":"..."}}
//	olay  : {"ev":"message", ...}
//
// stdout YALNIZ bu protokol içindir; günlükler stderr'e gider (çekirdek core.log'a yazar).
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
)

type request struct {
	ID     int64           `json:"id"`
	Method string          `json:"m"`
	Params json.RawMessage `json:"p"`
}

type rpcError struct {
	Code string `json:"code"`
	Msg  string `json:"msg"`
}

func (e *rpcError) Error() string { return e.Code + ": " + e.Msg }

func errCode(code, format string, args ...any) error {
	return &rpcError{Code: code, Msg: fmt.Sprintf(format, args...)}
}

type response struct {
	ID     int64     `json:"id"`
	Result any       `json:"r,omitempty"`
	Error  *rpcError `json:"e,omitempty"`
}

// out: stdout'a tek yazıcı (satırlar karışmasın)
type outWriter struct {
	mu sync.Mutex
	w  *bufio.Writer
}

var out = &outWriter{w: bufio.NewWriterSize(os.Stdout, 1<<16)}

func (o *outWriter) write(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		data, _ = json.Marshal(map[string]any{"ev": "log", "level": "error", "msg": "json: " + err.Error()})
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	_, _ = o.w.Write(data)
	_ = o.w.WriteByte('\n')
	_ = o.w.Flush()
}

// emit bir olay yazar: ev alanı + verilen alanlar
func emit(ev string, fields map[string]any) {
	fields["ev"] = ev
	out.write(fields)
}

func reply(id int64, result any, err error) {
	resp := response{ID: id}
	if err != nil {
		var re *rpcError
		if errors.As(err, &re) {
			resp.Error = re
		} else {
			resp.Error = &rpcError{Code: "error", Msg: err.Error()}
		}
	} else {
		if result == nil {
			result = map[string]any{}
		}
		resp.Result = result
	}
	out.write(resp)
}

// readRequests stdin kapanana dek istekleri handler'a verir (her istek kendi goroutine'inde; uzun süren login.wait
// gibi çağrılar ötekileri bekletmesin)
func readRequests(r io.Reader, handle func(req *request)) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 1<<16), 64<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			emit("log", map[string]any{"level": "error", "msg": "geçersiz istek: " + err.Error()})
			continue
		}
		go handle(&req)
	}
	return sc.Err()
}
