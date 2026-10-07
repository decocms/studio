package routes

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
	"github.com/decocms/studio/sandbox-daemon/internal/worktree"
)

func rpcPost(t *testing.T, c *Content, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/_sandbox/rpc", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	c.RPC(w, r)
	return w
}

// A protocol write under the package path reports repo-relative paths through
// the fs routes' hook (file-changed, the decofile version, branch status), and
// keeps its lock and transaction files out of git.
func TestContentFollowsThePackagePathAndReportsWrites(t *testing.T) {
	repo := t.TempDir()
	if out, err := exec.Command("git", "init", "-q", repo).CombinedOutput(); err != nil {
		t.Skipf("git init: %v %s", err, out)
	}
	app := filepath.Join(repo, "apps", "web")
	os.MkdirAll(filepath.Join(app, ".deco", "blocks"), 0o755)
	store := config.NewStore()
	store.Hydrate(&config.TenantConfig{
		Application: &config.Application{
			PackageManager: &config.PackageManagerConfig{Path: config.Str("apps/web")},
		},
	})
	var written []string
	c := NewContent(ContentDeps{
		RepoDir:  repo,
		Store:    store,
		TreeLock: &worktree.Lock{},
		OnWrite:  func(p string) { written = append(written, p) },
	})

	w := rpcPost(t, c, `{"jsonrpc":"2.0","id":1,"method":"describe"}`)
	if !strings.Contains(w.Body.String(), `"root":"apps/web"`) || !strings.Contains(w.Body.String(), `"dir":"apps/web/public/assets"`) {
		t.Fatalf("describe: %s", w.Body)
	}
	w = rpcPost(t, c, `{"jsonrpc":"2.0","id":1,"method":"blocks.apply","params":{"set":{"pages-Home Page":{"path":"/"},"Header":{}}}}`)
	if strings.Contains(w.Body.String(), `"error"`) {
		t.Fatalf("apply: %s", w.Body)
	}
	sort.Strings(written)
	want := []string{"apps/web/.deco/blocks/Header.json", "apps/web/.deco/blocks/pages-Home%20Page.json"}
	if !reflect.DeepEqual(written, want) {
		t.Errorf("OnWrite: %v, want %v", written, want)
	}

	r := httptest.NewRequest(http.MethodPut, "/_sandbox/assets/logo.png", bytes.NewReader([]byte{1, 2}))
	r.Header.Set("Content-Type", "image/png")
	aw := httptest.NewRecorder()
	c.Assets(aw, r)
	if aw.Code != 201 || written[len(written)-1] != "apps/web/public/assets/logo.png" {
		t.Errorf("upload: %d %s %v", aw.Code, aw.Body, written)
	}

	exclude, _ := os.ReadFile(filepath.Join(repo, ".git", "info", "exclude"))
	for _, line := range []string{"/apps/web/.deco/.blocks.lock", "/apps/web/.deco/.tx-*/"} {
		if !strings.Contains(string(exclude), line+"\n") {
			t.Errorf("exclude lacks %s:\n%s", line, exclude)
		}
	}
}

// Commits wait for the working-tree lock, so a publish or an fs write never
// interleaves with one.
func TestContentCommitsTakeTheTreeLock(t *testing.T) {
	repo := t.TempDir()
	os.MkdirAll(filepath.Join(repo, ".deco", "blocks"), 0o755)
	lock := &worktree.Lock{}
	c := NewContent(ContentDeps{RepoDir: repo, Store: config.NewStore(), TreeLock: lock})

	release := lock.Acquire()
	done := make(chan string, 1)
	go func() {
		done <- rpcPost(t, c, `{"jsonrpc":"2.0","id":1,"method":"blocks.apply","params":{"set":{"x":{}}}}`).Body.String()
	}()
	select {
	case body := <-done:
		t.Fatalf("committed while the tree was locked: %s", body)
	case <-time.After(200 * time.Millisecond):
	}
	// Reads never wait.
	if w := rpcPost(t, c, `{"jsonrpc":"2.0","id":2,"method":"blocks.list"}`); w.Code != 200 {
		t.Errorf("list under the lock: %d", w.Code)
	}
	release()
	if body := <-done; strings.Contains(body, `"error"`) {
		t.Errorf("apply: %s", body)
	}
}
