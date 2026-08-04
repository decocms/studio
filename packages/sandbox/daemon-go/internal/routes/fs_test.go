package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
