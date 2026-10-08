package content

import (
	"bytes"
	"compress/gzip"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Ported from server/handler.test.ts, server/methods.test.ts,
// server/apply.test.ts, server/assets.test.ts and storage/fs/*.test.ts.

type site struct {
	t       *testing.T
	root    string
	h       *Handler
	mu      sync.Mutex
	commits [][]string
}

func newSite(t *testing.T, withSchema bool) *site {
	t.Helper()
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, ".deco", "blocks"), 0o755)
	os.WriteFile(filepath.Join(root, ".deco", "index.ts"), []byte("export default {};\n"), 0o644)
	if withSchema {
		os.WriteFile(filepath.Join(root, ".deco", "schema.gen.json"), []byte(schemaFixtureJSON), 0o644)
	}
	s := &site{t: t, root: root}
	s.h = NewHandler(Options{
		Store: NewFSStore(FSOptions{Root: root, RepoRoot: root}),
		OnCommit: func(files []string) {
			s.mu.Lock()
			s.commits = append(s.commits, files)
			s.mu.Unlock()
		},
		Logf: func(string, ...any) {},
	})
	return s
}

func (s *site) blockPath(file string) string { return filepath.Join(s.root, ".deco", "blocks", file) }

func (s *site) writeFile(file, content string) {
	s.t.Helper()
	if err := os.WriteFile(s.blockPath(file), []byte(content), 0o644); err != nil {
		s.t.Fatal(err)
	}
}

type rpcResponse struct {
	ID     any             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	} `json:"error"`
}

func (s *site) post(body string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "/rpc", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	s.h.ServeRPC(w, r)
	return w
}

func (s *site) call(method string, params any) rpcResponse {
	s.t.Helper()
	envelope := map[string]any{"jsonrpc": "2.0", "id": 1, "method": method}
	if params != nil {
		envelope["params"] = params
	}
	body, _ := json.Marshal(envelope)
	w := s.post(string(body), nil)
	var res rpcResponse
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		s.t.Fatalf("%s: %v (%s)", method, err, w.Body.String())
	}
	return res
}

func (s *site) result(method string, params any, out any) {
	s.t.Helper()
	res := s.call(method, params)
	if res.Error != nil {
		s.t.Fatalf("%s failed: %d %s %s", method, res.Error.Code, res.Error.Message, res.Error.Data)
	}
	if err := json.Unmarshal(res.Result, out); err != nil {
		s.t.Fatal(err)
	}
}

func (s *site) errorCode(method string, params any) int {
	s.t.Helper()
	res := s.call(method, params)
	if res.Error == nil {
		s.t.Fatalf("%s succeeded: %s", method, res.Result)
	}
	return res.Error.Code
}

type listResult struct {
	NotModified bool                       `json:"notModified"`
	Revision    string                     `json:"revision"`
	Blocks      map[string]json.RawMessage `json:"blocks"`
	Versions    map[string]string          `json:"versions"`
	Diagnostics []map[string]string        `json:"diagnostics"`
}

type applyResult struct {
	Revision string             `json:"revision"`
	Versions map[string]*string `json:"versions"`
}

func (s *site) list() listResult {
	var r listResult
	s.result("blocks.list", nil, &r)
	return r
}

func (s *site) apply(params any) applyResult {
	var r applyResult
	s.result("blocks.apply", params, &r)
	return r
}

func gitHash(b []byte) string {
	h := sha1.New()
	h.Write([]byte("blob " + strconv.Itoa(len(b)) + "\x00"))
	h.Write(b)
	return hex.EncodeToString(h.Sum(nil))
}

// ---------------------------------------------------------------- HTTP

func TestHandlerHTTP(t *testing.T) {
	s := newSite(t, true)
	get := httptest.NewRecorder()
	s.h.ServeRPC(get, httptest.NewRequest("GET", "/rpc", nil))
	if get.Code != 405 || get.Header().Get("Allow") != "POST" || !strings.Contains(get.Body.String(), `"code":-32600`) {
		t.Errorf("GET: %d %s", get.Code, get.Body)
	}
	form := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/rpc", strings.NewReader("a=1"))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	s.h.ServeRPC(form, r)
	if form.Code != 415 {
		t.Errorf("form post: %d", form.Code)
	}
	if w := s.post(`{"jsonrpc":"2.0","id":1,"method":"describe"}`, map[string]string{"Content-Type": "Application/JSON; charset=utf-8"}); w.Code != 200 {
		t.Errorf("JSON with parameters: %d", w.Code)
	}
	for _, body := range []string{"{not json", "", "\xff"} {
		w := s.post(body, nil)
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"code":-32700`) || !strings.Contains(w.Body.String(), `"id":null`) {
			t.Errorf("%q: %d %s", body, w.Code, w.Body)
		}
	}
	w := s.post(`{"jsonrpc":"2.0","id":1,"method":"describe"}`, nil)
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Content-Type") != "application/json; charset=utf-8" || w.Header().Get("Vary") != "Accept-Encoding" {
		t.Errorf("headers: %v", w.Header())
	}

	// The request limit applies whatever Content-Length says, and after gzip.
	big := `{"jsonrpc":"2.0","id":1,"method":"describe","params":{"x":"` + strings.Repeat("x", maxRequestBytes) + `"}}`
	if w := s.post(big, nil); w.Code != 413 || !strings.Contains(w.Body.String(), `"limit":"maxRequestBytes"`) {
		t.Errorf("oversized: %d %.200s", w.Code, w.Body)
	}
	var zipped bytes.Buffer
	zw := gzip.NewWriter(&zipped)
	zw.Write([]byte(big))
	zw.Close()
	r = httptest.NewRequest("POST", "/rpc", &zipped)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Content-Encoding", "gzip")
	w = httptest.NewRecorder()
	s.h.ServeRPC(w, r)
	if w.Code != 413 {
		t.Errorf("oversized gzip: %d", w.Code)
	}
	zipped.Reset()
	zw = gzip.NewWriter(&zipped)
	zw.Write([]byte(`{"jsonrpc":"2.0","id":7,"method":"describe"}`))
	zw.Close()
	r = httptest.NewRequest("POST", "/rpc", &zipped)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Content-Encoding", "gzip")
	w = httptest.NewRecorder()
	s.h.ServeRPC(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"id":7`) {
		t.Errorf("gzip body: %d %s", w.Code, w.Body)
	}
	for _, enc := range []string{"br", "gzip"} {
		r = httptest.NewRequest("POST", "/rpc", strings.NewReader("not gzip"))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Content-Encoding", enc)
		w = httptest.NewRecorder()
		s.h.ServeRPC(w, r)
		if w.Code != 415 {
			t.Errorf("%s: %d", enc, w.Code)
		}
	}

	// Responses of 1 KiB or more are gzipped when accepted.
	s.apply(map[string]any{"set": map[string]any{"big": map[string]any{"text": strings.Repeat("x", 4096)}}})
	for header, want := range map[string]string{"gzip": "gzip", "gzip;q=0": "", "*": "gzip", "br": "", "identity, gzip;q=0.5": "gzip"} {
		w := s.post(`{"jsonrpc":"2.0","id":1,"method":"blocks.list"}`, map[string]string{"Accept-Encoding": header})
		if got := w.Header().Get("Content-Encoding"); got != want {
			t.Errorf("Accept-Encoding %q: Content-Encoding %q", header, got)
		}
		if want == "gzip" {
			zr, _ := gzip.NewReader(w.Body)
			plain, _ := io.ReadAll(zr)
			if !strings.Contains(string(plain), `"blocks"`) {
				t.Errorf("gzip body: %.100s", plain)
			}
		}
	}
}

func TestEnvelopesAndBatches(t *testing.T) {
	s := newSite(t, true)
	cases := map[string]string{
		`{"jsonrpc":"2.0","method":"describe"}`:                    `{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"every request needs a string or number id"}}`,
		`{"jsonrpc":"1.0","id":"a","method":"describe"}`:           `{"jsonrpc":"2.0","id":"a","error":{"code":-32600,"message":"jsonrpc must be \"2.0\""}}`,
		`{"jsonrpc":"2.0","id":1,"method":"blocks.rename"}`:        `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"unknown method \"blocks.rename\""}}`,
		`{"jsonrpc":"2.0","id":1,"method":"describe","x":1}`:       `{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"unknown request member \"x\""}}`,
		`{"jsonrpc":"2.0","id":1,"method":4}`:                      `{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"method must be a string"}}`,
		`[]`:                                                       `{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"an empty batch"}}`,
		`[1]`:                                                      `[{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"a request must be an object"}}]`,
		`{"jsonrpc":"2.0","id":1,"method":"describe","params":[]}`: `{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"params must be an object"}}`,
	}
	for in, want := range cases {
		if got := s.post(in, nil).Body.String(); got != want {
			t.Errorf("%s:\n got %s\nwant %s", in, got, want)
		}
	}
	calls := make([]string, 11)
	for i := range calls {
		calls[i] = `{"jsonrpc":"2.0","id":` + strconv.Itoa(i) + `,"method":"describe"}`
	}
	if got := s.post("["+strings.Join(calls, ",")+"]", nil).Body.String(); !strings.Contains(got, `"limit":"maxBatchCalls"`) {
		t.Errorf("11 calls: %s", got)
	}
	var items []rpcResponse
	json.Unmarshal(s.post(`[{"jsonrpc":"2.0","id":1,"method":"describe"},{"jsonrpc":"2.0","id":2,"method":"nope"},{"jsonrpc":"2.0","id":"three","method":"blocks.list"}]`, nil).Body.Bytes(), &items)
	if len(items) != 3 || items[0].Error != nil || items[1].Error.Code != CodeMethodNotFound || items[2].Error != nil || items[2].ID != "three" {
		t.Errorf("batch: %+v", items)
	}
	// Not atomic: the first write lands though the second fails.
	json.Unmarshal(s.post(`[{"jsonrpc":"2.0","id":1,"method":"blocks.apply","params":{"set":{"kept":{}}}},{"jsonrpc":"2.0","id":2,"method":"blocks.apply","params":{"set":{"bad":[]}}}]`, nil).Body.Bytes(), &items)
	if items[0].Error != nil || items[1].Error.Code != CodeInvalidBlock {
		t.Errorf("batch writes: %+v", items)
	}
	if _, ok := s.list().Blocks["kept"]; !ok {
		t.Error("the first write must land")
	}
	// A lone surrogate in a name is an Internal error for that call only.
	if got := s.post(`{"jsonrpc":"2.0","id":1,"method":"blocks.apply","params":{"set":{"x\ud800":{}}}}`, nil).Body.String(); got != `{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"internal error"}}` {
		t.Errorf("lone surrogate: %s", got)
	}
}

// ---------------------------------------------------------------- reads

func TestDescribe(t *testing.T) {
	s := newSite(t, false)
	pub := publicKeyPEM(t)
	os.WriteFile(filepath.Join(s.root, ".deco", "secrets.pub"), []byte(pub), 0o644)
	var d map[string]any
	s.result("describe", map[string]any{}, &d)
	want := map[string]any{
		"protocol": "deco-content", "version": map[string]any{"major": 1.0, "minor": 0.0},
		"server": map[string]any{"name": "deco-blocks", "version": "unknown"}, "kind": "working-tree",
		"readOnly": false, "root": ".", "schemaFormat": "deco-meta@1", "pollIntervalMs": 2000.0, "preview": nil,
		"assets":  map[string]any{"dir": "public/assets", "urlPrefix": "/assets/", "maxBytes": float64(25 * 1024 * 1024)},
		"secrets": map[string]any{"publicKey": pub},
	}
	if !reflect.DeepEqual(d, want) {
		t.Errorf("describe:\n got %v\nwant %v", d, want)
	}
	os.WriteFile(filepath.Join(s.root, ".deco", "secrets.pub"), []byte(pub+"-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n"), 0o644)
	s.result("describe", nil, &d)
	if d["secrets"] != nil {
		t.Error("a file holding a private key is never served")
	}
	nested := NewHandler(Options{Store: NewFSStore(FSOptions{Root: filepath.Join(s.root, "apps", "site"), RepoRoot: s.root})})
	if desc := nested.store.describe(); desc.Root != "apps/site" || desc.AssetsDir != "apps/site/public/assets" {
		t.Errorf("nested root: %+v", desc)
	}
}

func TestSchemaGet(t *testing.T) {
	s := newSite(t, false)
	var r map[string]any
	s.result("schema.get", nil, &r)
	if !reflect.DeepEqual(r, map[string]any{"notModified": false, "version": nil, "resolvedRef": nil, "schema": nil}) {
		t.Errorf("no schema: %v", r)
	}
	os.WriteFile(filepath.Join(s.root, ".deco", "meta.gen.json"), []byte(`{"from":"meta"}`), 0o644)
	s.result("schema.get", nil, &r)
	if r["version"] != gitHash([]byte(`{"from":"meta"}`)) || !reflect.DeepEqual(r["schema"], map[string]any{"from": "meta"}) {
		t.Errorf("meta.gen.json fallback: %v", r)
	}
	os.WriteFile(filepath.Join(s.root, ".deco", "schema.gen.json"), []byte(`{"from":"schema"}`), 0o644)
	s.result("schema.get", nil, &r)
	version := r["version"].(string)
	if !reflect.DeepEqual(r["schema"], map[string]any{"from": "schema"}) {
		t.Errorf("schema.gen.json first: %v", r)
	}
	r = nil
	s.result("schema.get", map[string]any{"ifNoneMatch": version}, &r)
	if !reflect.DeepEqual(r, map[string]any{"notModified": true, "version": version}) {
		t.Errorf("not modified: %v", r)
	}
	os.WriteFile(filepath.Join(s.root, ".deco", "schema.gen.json"), []byte(`{"torn`), 0o644)
	res := s.call("schema.get", nil)
	if res.Error == nil || res.Error.Code != CodeUnavailable || string(res.Error.Data) != `{"retryAfterMs":500}` {
		t.Errorf("torn schema: %+v", res.Error)
	}
	os.RemoveAll(filepath.Join(s.root, ".deco"))
	if code := s.errorCode("schema.get", nil); code != CodeNotFound {
		t.Errorf("no .deco: %d", code)
	}
	if code := s.errorCode("blocks.list", nil); code != CodeNotFound {
		t.Errorf("no .deco list: %d", code)
	}
}

func TestBlocksList(t *testing.T) {
	s := newSite(t, false)
	s.writeFile("Header.json", `{"a":1}`)
	s.writeFile("pages-Home%20Page.json", `{"path":"/"}`)
	s.writeFile("pages-Home%2520Page.json", `{"v":"bot"}`) // shadowed: the other has a path
	s.writeFile("broken.json", `{"a":`)
	s.writeFile("list.json", `[1]`)
	s.writeFile("huge.json", `{"t":"`+strings.Repeat("x", maxBlockBytes)+`"}`)
	s.writeFile("constructor.json", `{"proto":true}`)
	s.writeFile(".hidden.json", `{}`)
	s.writeFile("notes.txt", `{}`)
	os.Mkdir(s.blockPath("dir.json"), 0o755)

	l := s.list()
	var names []string
	for n := range l.Blocks {
		names = append(names, n)
	}
	sort.Strings(names)
	if !reflect.DeepEqual(names, []string{"Header", "constructor", "pages-Home Page"}) {
		t.Errorf("names: %v", names)
	}
	if l.Versions["Header"] != gitHash([]byte(`{"a":1}`)) {
		t.Error("versions are git blob hashes")
	}
	kinds := map[string]string{}
	for _, d := range l.Diagnostics {
		kinds[d["file"]] = d["kind"]
	}
	want := map[string]string{"broken.json": "invalid-json", "list.json": "not-an-object", "huge.json": "too-large", "pages-Home%2520Page.json": "shadowed"}
	if !reflect.DeepEqual(kinds, want) {
		t.Errorf("diagnostics: %v", l.Diagnostics)
	}
	var again map[string]any
	s.result("blocks.list", map[string]any{"ifNoneMatch": l.Revision}, &again)
	if !reflect.DeepEqual(again, map[string]any{"notModified": true, "revision": l.Revision, "resolvedRef": nil}) {
		t.Errorf("not modified: %v", again)
	}
	// A changed file is served fresh, not from the cache.
	s.writeFile("Header.json", `{"a":2}`)
	if l2 := s.list(); string(l2.Blocks["Header"]) != `{"a":2}` || l2.Revision == l.Revision {
		t.Errorf("changed file: %s", l2.Blocks["Header"])
	}
}

// ---------------------------------------------------------------- writes

func TestApplyWritesTheReferenceBytes(t *testing.T) {
	s := newSite(t, false)
	r := s.apply(map[string]any{"set": map[string]any{"pages-Home Page": map[string]any{"path": "/", "b": []any{true}}}})
	file := "pages-Home%20Page.json"
	b, err := os.ReadFile(s.blockPath(file))
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "{\n  \"b\": [\n    true\n  ],\n  \"path\": \"/\"\n}\n" {
		t.Errorf("bytes: %q", b)
	}
	if *r.Versions["pages-Home Page"] != gitHash(b) {
		t.Error("version")
	}
	if l := s.list(); l.Revision != r.Revision {
		t.Error("the listed revision is the one apply returned")
	}
	if !reflect.DeepEqual(s.commits, [][]string{{file}}) {
		t.Errorf("OnCommit: %v", s.commits)
	}
}

func TestApplySemantics(t *testing.T) {
	s := newSite(t, true)
	s.apply(map[string]any{"set": map[string]any{"a": map[string]any{"v": 1}, "b": map[string]any{"v": 2}}})
	r := s.apply(map[string]any{"set": map[string]any{"c": map[string]any{}}, "delete": []any{"a", "missing"}})
	if r.Versions["a"] != nil || r.Versions["missing"] != nil || r.Versions["c"] == nil {
		t.Errorf("set + delete: %+v", r.Versions)
	}
	both := s.apply(map[string]any{"set": map[string]any{"both": map[string]any{}}, "delete": []any{"both"}})
	if both.Versions["both"] == nil {
		t.Error("set wins over delete")
	}
	// Every violation at once, nothing written.
	res := s.call("blocks.apply", map[string]any{"set": map[string]any{
		"good": map[string]any{}, "arr": []any{}, "nothing": nil, ".hidden": map[string]any{},
		"n": map[string]any{"__resolveType": "newsletter", "apiKey": "plain"},
	}})
	var data struct{ Violations []map[string]string }
	json.Unmarshal(res.Error.Data, &data)
	if res.Error.Code != CodeInvalidBlock || len(data.Violations) != 4 || res.Error.Message != "4 invalid blocks" {
		t.Errorf("violations: %s %s", res.Error.Message, res.Error.Data)
	}
	if _, ok := s.list().Blocks["good"]; ok {
		t.Error("nothing is written when anything is invalid")
	}
	if code := s.errorCode("blocks.apply", map[string]any{"set": map[string]any{"big": map[string]any{"t": strings.Repeat("x", maxBlockBytes)}}}); code != CodeInvalidBlock {
		t.Errorf("too large: %d", code)
	}
	names := make([]any, 501)
	for i := range names {
		names[i] = "n" + strconv.Itoa(i)
	}
	res = s.call("blocks.apply", map[string]any{"delete": names})
	if res.Error == nil || res.Error.Code != CodeLimitExceeded || string(res.Error.Data) != `{"limit":"maxOpsPerApply"}` {
		t.Errorf("501 names: %+v", res.Error)
	}
	// A case variant of an existing (or another new) name is refused.
	if code := s.errorCode("blocks.apply", map[string]any{"set": map[string]any{"B": map[string]any{}}}); code != CodeInvalidBlock {
		t.Errorf("case collision: %d", code)
	}
	if code := s.errorCode("blocks.apply", map[string]any{"set": map[string]any{"New": map[string]any{}, "new": map[string]any{}}}); code != CodeInvalidBlock {
		t.Errorf("case collision among new names: %d", code)
	}
	if r := s.apply(map[string]any{"delete": []any{"widget.ts"}}); r.Versions["widget.ts"] != nil {
		t.Error("a source-extension name can be deleted")
	}
	// An empty apply commits nothing.
	before := len(s.commits)
	s.apply(map[string]any{})
	if len(s.commits) != before {
		t.Error("an empty apply must not commit")
	}
}

func TestApplySpellingsAndGuards(t *testing.T) {
	s := newSite(t, false)
	s.writeFile("Home%2520Page.json", `{"v":0}`)
	created := s.list().Versions["Home%20Page"]
	// Create-only under another spelling fails, reporting the existing version.
	res := s.call("blocks.apply", map[string]any{"set": map[string]any{"Home Page": map[string]any{}}, "ifMatch": map[string]any{"Home Page": nil}})
	if res.Error == nil || res.Error.Code != CodeConflict || string(res.Error.Data) != `{"entries":{"Home Page":{"expected":null,"actual":"`+created+`"}}}` {
		t.Errorf("create-only: %+v", res.Error)
	}
	if code := s.errorCode("blocks.apply", map[string]any{"set": map[string]any{"Home%20Page": map[string]any{}, "Home Page": map[string]any{}}}); code != CodeInvalidBlock {
		t.Errorf("two spellings in one write: %d", code)
	}
	// A guard on one spelling holds for the other; the other spelling goes.
	r := s.apply(map[string]any{"set": map[string]any{"Home Page": map[string]any{"v": 1}}, "ifMatch": map[string]any{"Home Page": created}})
	if r.Versions["Home%20Page"] != nil || r.Versions["Home Page"] == nil {
		t.Errorf("versions: %+v", r.Versions)
	}
	if _, err := os.Stat(s.blockPath("Home%2520Page.json")); !os.IsNotExist(err) {
		t.Error("the other spelling must be deleted in the same commit")
	}
	// Deleting any spelling deletes every spelling.
	s.writeFile("Home%2520Page.json", `{"v":0}`)
	r = s.apply(map[string]any{"delete": []any{"Home Page"}})
	if len(s.list().Blocks) != 0 || len(r.Versions) != 2 {
		t.Errorf("delete every spelling: %+v %v", r.Versions, s.list().Blocks)
	}
	// Last writer wins without guards.
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s.apply(map[string]any{"set": map[string]any{"lww": map[string]any{"i": i}, "own" + strconv.Itoa(i): map[string]any{}}})
		}(i)
	}
	wg.Wait()
	if l := s.list(); len(l.Blocks) != 9 {
		t.Errorf("concurrent writers: %d entries", len(l.Blocks))
	}
}

func TestApplyRetriesThenGivesUp(t *testing.T) {
	s := newSite(t, false)
	s.h.retryMinMs, s.h.retryMaxMs = 0, 0
	s.apply(map[string]any{"set": map[string]any{"g": map[string]any{"v": 1}}})
	version := *s.apply(map[string]any{"set": map[string]any{"g": map[string]any{"v": 2}}}).Versions["g"]
	// Change the guarded file behind every commit attempt's back.
	n := 0
	s.h.store.exclusive = func() (func(), bool) {
		n++
		s.writeFile("g.json", `{"v":"other `+strconv.Itoa(n)+`"}`)
		return func() {}, true
	}
	// The guard is rechecked against a fresh snapshot: a Conflict, not a stale write.
	res := s.call("blocks.apply", map[string]any{"set": map[string]any{"g": map[string]any{"v": 3}}, "ifMatch": map[string]any{"g": version}})
	if res.Error == nil || res.Error.Code != CodeConflict {
		t.Errorf("guard after a move: %+v", res.Error)
	}
	// A schema that keeps changing exhausts the attempts.
	s.h.store.exclusive = func() (func(), bool) {
		n++
		os.WriteFile(filepath.Join(s.root, ".deco", "schema.gen.json"), []byte(`{"n":`+strconv.Itoa(n)+`}`), 0o644)
		return func() {}, true
	}
	res = s.call("blocks.apply", map[string]any{"set": map[string]any{"x": map[string]any{}}})
	if res.Error == nil || res.Error.Code != CodeUnavailable || res.Error.Message != "storage kept changing; gave up after 3 commit attempts" {
		t.Errorf("gave up: %+v", res.Error)
	}
}

// ---------------------------------------------------------------- storage

func TestCommitLockAndTransactions(t *testing.T) {
	s := newSite(t, false)
	deco := filepath.Join(s.root, ".deco")
	// A crashed commit's transaction folder is swept by the next commit.
	os.MkdirAll(filepath.Join(deco, ".tx-crashed", "new"), 0o755)
	// Another process's live lock is waited for, a stale one taken over.
	lock := filepath.Join(deco, lockFileName)
	os.WriteFile(lock, []byte("1\n"), 0o644)
	s.h.store.lockTimeout = 100 * time.Millisecond
	res := s.call("blocks.apply", map[string]any{"set": map[string]any{"x": map[string]any{}}})
	if res.Error == nil || res.Error.Code != CodeUnavailable || string(res.Error.Data) != `{"retryAfterMs":500}` {
		t.Errorf("held lock: %+v", res.Error)
	}
	old := time.Now().Add(-time.Minute)
	os.Chtimes(lock, old, old)
	s.apply(map[string]any{"set": map[string]any{"x": map[string]any{}}})
	entries, _ := os.ReadDir(deco)
	for _, e := range entries {
		if e.Name() == lockFileName || strings.HasPrefix(e.Name(), ".tx-") {
			t.Errorf("left behind: %s", e.Name())
		}
	}
}

func TestApplyFileChangeRollsBack(t *testing.T) {
	dir := t.TempDir()
	scratch := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.json"), []byte("old a"), 0o644)
	os.WriteFile(filepath.Join(dir, "gone.json"), []byte("old gone"), 0o644)
	// The second rename fails: its target is a non-empty folder.
	os.MkdirAll(filepath.Join(dir, "b.json", "x"), 0o755)
	err := applyFileChange(dir, scratch, []filePut{{"a.json", "new a"}, {"b.json", "new b"}}, []string{"gone.json"})
	if err == nil {
		t.Fatal("expected the change to fail")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "a.json")); string(b) != "old a" {
		t.Errorf("a.json not restored: %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "gone.json")); string(b) != "old gone" {
		t.Errorf("gone.json not restored: %q", b)
	}
	if left, _ := os.ReadDir(scratch); len(left) != 0 {
		t.Errorf("transaction folder left: %v", left)
	}
	if err := applyFileChange(dir, scratch, []filePut{{"a.json", "new a"}}, []string{"gone.json", "never.json"}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "a.json")); string(b) != "new a" {
		t.Error("write")
	}
	if _, err := os.Stat(filepath.Join(dir, "gone.json")); !os.IsNotExist(err) {
		t.Error("delete")
	}
}

func TestStorageRefusesNonBlockFiles(t *testing.T) {
	s := newSite(t, false)
	for _, file := range []string{"../x.json", ".env.json", "a/b.json", "x.ts"} {
		_, err := s.h.store.commit(commitAttempt{Put: []filePut{{file, "{}"}}})
		if pe := toProtocolError(err); pe == nil || pe.Code != CodeInvalidBlock {
			t.Errorf("%s: %v", file, err)
		}
	}
}

// ---------------------------------------------------------------- assets

func (s *site) upload(name, contentType string, body []byte, method string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "/assets/"+name, bytes.NewReader(body))
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	w := httptest.NewRecorder()
	s.h.ServeAssets(w, r)
	return w
}

func TestAssets(t *testing.T) {
	s := newSite(t, false)
	png := []byte{0x89, 'P', 'N', 'G'}
	w := s.upload("banner.png", "image/png", png, "PUT")
	if w.Code != 201 || w.Body.String() != `{"path":"/assets/banner.png"}` {
		t.Fatalf("upload: %d %s", w.Code, w.Body)
	}
	if b, _ := os.ReadFile(filepath.Join(s.root, "public", "assets", "banner.png")); !bytes.Equal(b, png) {
		t.Error("stored bytes")
	}
	w = s.upload("banner.png", "image/png", []byte{1}, "PUT")
	var out struct{ Path string }
	json.Unmarshal(w.Body.Bytes(), &out)
	if w.Code != 201 || out.Path == "/assets/banner.png" || !strings.HasPrefix(out.Path, "/assets/banner-") || !strings.HasSuffix(out.Path, ".png") {
		t.Errorf("a taken name gets a suffix: %s", out.Path)
	}
	if b, _ := os.ReadFile(filepath.Join(s.root, "public", "assets", "banner.png")); !bytes.Equal(b, png) {
		t.Error("never overwrites")
	}
	for _, c := range []struct{ name, typ string }{
		{"page.html", "text/html"}, {"evil.html", "image/png"}, {"evil.js", "image/jpeg"},
		{"logo.svg", "image/svg+xml"}, {"data.json", "application/json"}, {"x.png", ""},
	} {
		if w := s.upload(c.name, c.typ, png, "PUT"); w.Code != 415 || !strings.Contains(w.Body.String(), `"code":-32600`) {
			t.Errorf("%s as %s: %d", c.name, c.typ, w.Code)
		}
	}
	if w := s.upload("Logo", "image/webp", png, "PUT"); w.Body.String() != `{"path":"/assets/Logo.webp"}` {
		t.Errorf("extension added: %s", w.Body)
	}
	if w := s.upload("Photo.JPEG", "image/jpeg", png, "PUT"); w.Body.String() != `{"path":"/assets/Photo.jpeg"}` {
		t.Errorf("extension lowercased: %s", w.Body)
	}
	if w := s.upload("x.png", "image/png", png, "POST"); w.Code != 405 || w.Header().Get("Allow") != "PUT" {
		t.Errorf("POST: %d", w.Code)
	}
	if w := s.upload("empty.png", "image/png", nil, "PUT"); w.Code != 400 {
		t.Errorf("empty: %d", w.Code)
	}
	if w := s.upload("", "image/png", png, "PUT"); w.Code != 400 {
		t.Errorf("no name: %d", w.Code)
	}
	if w := s.upload("..%2F..%2Fescape.png", "image/png", png, "PUT"); w.Body.String() != `{"path":"/assets/escape.png"}` {
		t.Errorf("stays inside the asset folder: %s", w.Body)
	}
	s.h.store.assetsMaxBytes = 3
	if w := s.upload("big.png", "image/png", png, "PUT"); w.Code != 413 || !strings.Contains(w.Body.String(), "uploads are limited to 3 bytes") {
		t.Errorf("too big: %d %s", w.Code, w.Body)
	}
}

func TestSanitizeAssetName(t *testing.T) {
	cases := map[string]string{
		"Bänner (1).PNG":                        "Banner-1.PNG",
		"a%20b.png":                             "a-b.png",
		"dir/sub\\file.png":                     "file.png",
		"...hidden.png":                         "hidden.png",
		"--x--.png":                             "x.png",
		"x-.png":                                "x.png",
		"ｆｕｌｌｗｉｄｔｈ.png":                         "fullwidth.png",
		"%E0%A4%A.png":                          "E0-A4-A.png",
		"..":                                    "",
		"日本語":                                   "",
		"a" + strings.Repeat("b", 300) + ".png": "a" + strings.Repeat("b", 195) + ".png",
	}
	for in, want := range cases {
		if got := sanitizeAssetName(in); got != want {
			t.Errorf("sanitizeAssetName(%q) = %q, want %q", in, got, want)
		}
	}
	if got := suffixedAssetName("banner.jpg"); len(got) != len("banner-abcdef.jpg") || !strings.HasPrefix(got, "banner-") || !strings.HasSuffix(got, ".jpg") {
		t.Errorf("suffix: %s", got)
	}
	if got := suffixedAssetName("noext"); !strings.HasPrefix(got, "noext-") || len(got) != len("noext-abcdef") {
		t.Errorf("suffix without extension: %s", got)
	}
}
