package routes

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// seedBlocks lays a repo with two `.deco/blocks/*.json` sources but NO merged
// `.deco/blocks.gen.json`, and returns FsDeps pointed at it.
func seedBlocks(t *testing.T) FsDeps {
	t.Helper()
	repoDir := t.TempDir()
	blocksDir := filepath.Join(repoDir, ".deco", "blocks")
	if err := os.MkdirAll(blocksDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	for name, content := range map[string]string{
		"a.json": `{"n":1}`,
		"b.json": `{"n":2}`,
	} {
		if err := os.WriteFile(filepath.Join(blocksDir, name), []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return FsDeps{AppRoot: filepath.Dir(repoDir), RepoDir: repoDir}
}

// infiniteReader never hits EOF; it lets a test drive decodeBody's cap
// without pre-allocating the oversized body it's rejecting.
type infiniteReader struct{}

func (infiniteReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'a'
	}
	return len(p), nil
}

// Without a cap, decodeBody's io.ReadAll(r.Body) would buffer an unbounded
// request body into memory and could crash the daemon, tearing down the
// sandbox pod on the next missed health probe.
func TestDecodeBodyRejectsOversizedRequest(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/write", io.NopCloser(infiniteReader{}))
	var out map[string]any
	err := decodeBody(req, &out)
	if err == nil {
		t.Fatal("expected decodeBody to reject an oversized body, got nil error")
	}
	if !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("expected a size-limit error, got: %v", err)
	}
}

// Without an upper bound, a caller-supplied `limit` let /grep buffer an
// unbounded number of match lines into memory — the same crash-the-daemon
// class the request-body cap above closes for the request side.
func TestGrepCapsCallerSuppliedLimit(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("ripgrep not installed")
	}
	repoDir := t.TempDir()
	var content strings.Builder
	for i := 0; i < grepMaxResultLimit+500; i++ {
		content.WriteString("needle\n")
	}
	if err := os.WriteFile(filepath.Join(repoDir, "haystack.txt"), []byte(content.String()), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	deps := FsDeps{AppRoot: repoDir, RepoDir: repoDir}
	body, _ := json.Marshal(map[string]any{
		"pattern":     "needle",
		"output_mode": "content",
		"limit":       grepMaxResultLimit * 10,
	})
	req := httptest.NewRequest(http.MethodPost, "/grep", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	Grep(deps)(rec, req)
	if rec.Code != 200 {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		MatchCount int `json:"matchCount"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.MatchCount > grepMaxResultLimit {
		t.Fatalf("expected matchCount capped at %d, got %d", grepMaxResultLimit, out.MatchCount)
	}
}

func readReq(t *testing.T, deps FsDeps, path string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"path": path, "full": true})
	req := httptest.NewRequest(http.MethodPost, "/read", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	Read(deps)(rec, req)
	return rec
}

// A relative request for the absent gen artifact falls back to the on-the-fly
// merge of the sibling blocks sources.
func TestReadDecofileFallbackRelative(t *testing.T) {
	deps := seedBlocks(t)
	rec := readReq(t, deps, ".deco/blocks.gen.json")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Kind    string `json:"kind"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Kind != "text" || got.Content != `{"a":{"n":1},"b":{"n":2}}` {
		t.Fatalf("kind=%q content=%q", got.Kind, got.Content)
	}
}

// The fallback must refuse an ABSOLUTE path even when it points straight at the
// real repo's gen artifact — an absolute path bypasses SafePath, so allowing it
// would turn the merge into an arbitrary sibling-`blocks/` directory glob. This
// is the precise guard proof: the blocks exist and the relative form (above)
// merges them, yet the absolute form to the very same location still 400s.
func TestReadDecofileFallbackRefusesAbsolute(t *testing.T) {
	deps := seedBlocks(t)
	abs := filepath.Join(deps.RepoDir, ".deco", "blocks.gen.json")
	if !filepath.IsAbs(abs) {
		t.Fatalf("test setup: %q is not absolute", abs)
	}
	rec := readReq(t, deps, abs)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (no merge for absolute path); body = %s", rec.Code, rec.Body.String())
	}
}

// The 400 an out-of-root write returns must name the root it wants. A model
// that guessed `/tmp` (writable from its own bash tool, not from here) has to
// be able to correct itself from the message alone — prod thread 38147122
// burned several steps retrying the same rejected path.
func TestWriteEscapesRootNamesTheRoot(t *testing.T) {
	deps := seedBlocks(t)
	body, _ := json.Marshal(map[string]any{"path": "/tmp/toolrun/x.ts", "content": "x"})
	req := httptest.NewRequest(http.MethodPost, "/write", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	Write(deps)(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
	msg := rec.Body.String()
	if !strings.Contains(msg, deps.AppRoot) || !strings.Contains(msg, deps.RepoDir) {
		t.Fatalf("error must name AppRoot %q and RepoDir %q; got %s", deps.AppRoot, deps.RepoDir, msg)
	}
}
