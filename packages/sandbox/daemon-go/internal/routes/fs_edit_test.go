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

func newEditRequest(t *testing.T, path, oldString, newString string) *http.Request {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"path":       path,
		"old_string": oldString,
		"new_string": newString,
	})
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	return httptest.NewRequest(http.MethodPost, "/_sandbox/edit", bytes.NewReader(body))
}

// TestEditRejectsOversizedFile guards the same untrusted-size boundary as the
// read route: without a cap, editing a large file reads it entirely into
// memory to compute the replacement, which can OOM the daemon.
func TestEditRejectsOversizedFile(t *testing.T) {
	repoDir := t.TempDir()
	big := strings.Repeat("a", maxEditFileBytes+1)
	filePath := filepath.Join(repoDir, "big.txt")
	if err := os.WriteFile(filePath, []byte(big), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	handler := Edit(FsDeps{AppRoot: repoDir, RepoDir: repoDir})
	rec := httptest.NewRecorder()
	handler(rec, newEditRequest(t, "big.txt", "a", "b"))

	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "too large") {
		t.Fatalf("body = %s, want a too-large error", rec.Body.String())
	}
}

func TestEditAllowsFileUnderCap(t *testing.T) {
	repoDir := t.TempDir()
	filePath := filepath.Join(repoDir, "small.txt")
	if err := os.WriteFile(filePath, []byte("hello world"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	handler := Edit(FsDeps{AppRoot: repoDir, RepoDir: repoDir})
	rec := httptest.NewRecorder()
	handler(rec, newEditRequest(t, "small.txt", "hello", "goodbye"))

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
}
