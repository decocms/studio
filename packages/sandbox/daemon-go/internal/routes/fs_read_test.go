package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newReadRequest(t *testing.T, path string) *http.Request {
	t.Helper()
	body, err := json.Marshal(map[string]any{"path": path})
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	return httptest.NewRequest(http.MethodPost, "/_sandbox/read", bytes.NewReader(body))
}

// TestReadRejectsOversizedTextFile guards the untrusted-size boundary on a
// route the sandbox exposes to any tool call: without a cap, a large text
// file in the repo (a generated log, a user commit) reads the whole thing
// into memory multiple times over, which can OOM the daemon and take the
// sandbox down.
func TestReadRejectsOversizedTextFile(t *testing.T) {
	repoDir := t.TempDir()
	big := strings.Repeat("a", maxTextBytes+1)
	filePath := filepath.Join(repoDir, "big.txt")
	if err := os.WriteFile(filePath, []byte(big), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	handler := Read(FsDeps{AppRoot: repoDir, RepoDir: repoDir})
	rec := httptest.NewRecorder()
	handler(rec, newReadRequest(t, "big.txt"))

	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "too large") {
		t.Fatalf("body = %s, want a too-large error", rec.Body.String())
	}
}

func TestReadAllowsFileUnderCap(t *testing.T) {
	repoDir := t.TempDir()
	filePath := filepath.Join(repoDir, "small.txt")
	if err := os.WriteFile(filePath, []byte("hello\nworld\n"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	handler := Read(FsDeps{AppRoot: repoDir, RepoDir: repoDir})
	rec := httptest.NewRecorder()
	handler(rec, newReadRequest(t, "small.txt"))

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
}
