package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"testing"
)

func initTestGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q"},
		{"config", "user.email", "t@example.com"},
		{"config", "user.name", "t"},
		{"commit", "-q", "--allow-empty", "-m", "init"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	return dir
}

// A path that escapes the repo is a client error (400), not a server error
// (500) — matches how fs.go's routes report the same SafePath rejection.
func TestGitDiscardEscapingPathReturns400(t *testing.T) {
	repoDir := initTestGitRepo(t)
	deps := GitDeps{AppRoot: filepath.Dir(repoDir), RepoDir: repoDir}

	body, _ := json.Marshal(map[string]any{
		"filepaths": []string{"../../etc/passwd"},
	})
	req := httptest.NewRequest(http.MethodPost, "/git/discard", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	GitDiscard(deps)(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}
