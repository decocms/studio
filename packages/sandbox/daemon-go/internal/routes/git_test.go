package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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

// A malformed JSON body used to be silently ignored, falling through to a
// full-repo diff instead of reporting the bad request.
func TestGitDiffMalformedBodyReturns400(t *testing.T) {
	repoDir := initTestGitRepo(t)
	deps := GitDeps{AppRoot: filepath.Dir(repoDir), RepoDir: repoDir}

	req := httptest.NewRequest(http.MethodPost, "/git/diff", bytes.NewReader([]byte("not json")))
	rec := httptest.NewRecorder()

	GitDiff(deps)(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

// The web client's `fetchGitDiff(ref)` (apps/web/.../sandbox-git-api.ts) posts
// NO body at all when it wants the working-tree diff — every field of /git/diff
// is optional. Rejecting that with json.Unmarshal's "unexpected end of JSON
// input" broke the publish dialog for any sandbox with uncommitted work, since
// the dialog takes that exact branch whenever `hasGitLocalWork(status)`.
func TestGitDiffEmptyBodyDiffsWorkingTree(t *testing.T) {
	repoDir := initTestGitRepo(t)
	deps := GitDeps{AppRoot: filepath.Dir(repoDir), RepoDir: repoDir}

	if err := os.WriteFile(filepath.Join(repoDir, "new-file.txt"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/git/diff", bytes.NewReader(nil))
	rec := httptest.NewRecorder()

	GitDiff(deps)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var got struct {
		Diffs map[string]any `json:"diffs"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v; body = %s", err, rec.Body.String())
	}
	if _, ok := got.Diffs["new-file.txt"]; !ok {
		t.Fatalf("diffs = %v, want the uncommitted new-file.txt", got.Diffs)
	}
}

// Tolerating an empty body must not weaken routes with a REQUIRED field: they
// validate after decoding, so their own 400 still stands.
func TestGitRebaseEmptyBodyStillRequiresBase(t *testing.T) {
	repoDir := initTestGitRepo(t)
	deps := GitDeps{AppRoot: filepath.Dir(repoDir), RepoDir: repoDir}

	req := httptest.NewRequest(http.MethodPost, "/git/rebase", bytes.NewReader(nil))
	rec := httptest.NewRecorder()

	GitRebase(deps)(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "base is required") {
		t.Fatalf("body = %s, want the route's own validation error", rec.Body.String())
	}
}
