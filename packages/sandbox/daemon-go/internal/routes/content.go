package routes

import (
	"net/http"
	"path/filepath"
	"sync"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
	"github.com/decocms/studio/sandbox-daemon/internal/content"
	"github.com/decocms/studio/sandbox-daemon/internal/gitx"
	"github.com/decocms/studio/sandbox-daemon/internal/paths"
	"github.com/decocms/studio/sandbox-daemon/internal/worktree"
)

// ContentDeps wires the content protocol (`POST /_sandbox/rpc`, `PUT
// /_sandbox/assets/<name>`) to the working tree.
type ContentDeps struct {
	RepoDir string
	Store   *config.Store
	// TreeLock serializes commits and uploads with every other tree mutation
	// (fs writes, publish, discard, rebase, autosave). Reads never take it.
	TreeLock *worktree.Lock
	// OnWrite gets the repo-relative path of every file a commit or upload
	// touched: the same hook the fs routes call, so `file-changed`, the
	// `decofile` version and the branch status follow protocol writes too.
	OnWrite func(relPath string)
	// ServerVersion is reported by describe. OPEN: no build stamps one yet.
	ServerVersion string
}

// Content serves the content protocol for the app root the workload config
// points at (the package path, like /_sandbox/decofile). One handler per app
// root: it holds that root's hash and body caches.
type Content struct {
	deps ContentDeps

	mu      sync.Mutex
	root    string
	handler *content.Handler
}

func NewContent(deps ContentDeps) *Content {
	return &Content{deps: deps}
}

func (c *Content) appRoot() string {
	pmPath := ""
	if cfg := c.deps.Store.Read(); cfg != nil {
		pmPath = cfg.PmPath()
	}
	return paths.ResolvePmRoot(c.deps.RepoDir, pmPath)
}

// repoRel is the slash-separated path of target inside the repo.
func (c *Content) repoRel(target string) string {
	rel, err := filepath.Rel(c.deps.RepoDir, target)
	if err != nil {
		return target
	}
	return filepath.ToSlash(rel)
}

func (c *Content) current() *content.Handler {
	root := c.appRoot()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.handler != nil && c.root == root {
		return c.handler
	}
	// A commit's lock file and transaction folders must never reach a user
	// branch through autosave or the shutdown `git add -A`.
	decoRel := c.repoRel(filepath.Join(root, ".deco"))
	gitx.EnsureExclude(c.deps.RepoDir, "/"+decoRel+"/.blocks.lock")
	gitx.EnsureExclude(c.deps.RepoDir, "/"+decoRel+"/.tx-*/")

	store := content.NewFSStore(content.FSOptions{
		Root:     root,
		RepoRoot: c.deps.RepoDir,
		Exclusive: func() func() {
			if c.deps.TreeLock == nil {
				return func() {}
			}
			return c.deps.TreeLock.Acquire()
		},
	})
	blocksDir := filepath.Join(root, ".deco", "blocks")
	assetsDir := filepath.Join(root, "public", "assets")
	notify := func(path string) {
		if c.deps.OnWrite != nil {
			c.deps.OnWrite(c.repoRel(path))
		}
	}
	c.root = root
	c.handler = content.NewHandler(content.Options{
		Store:         store,
		ServerName:    "studio-sandbox-daemon",
		ServerVersion: c.deps.ServerVersion,
		OnCommit: func(files []string) {
			for _, f := range files {
				notify(filepath.Join(blocksDir, f))
			}
		},
		OnAsset: func(name string) { notify(filepath.Join(assetsDir, name)) },
	})
	return c.handler
}

// RPC serves `/_sandbox/rpc` (any method: non-POST answers 405, as the
// protocol requires).
func (c *Content) RPC(w http.ResponseWriter, r *http.Request) {
	c.current().ServeRPC(w, r)
}

// Assets serves `/_sandbox/assets/<name>`.
func (c *Content) Assets(w http.ResponseWriter, r *http.Request) {
	c.current().ServeAssets(w, r)
}
