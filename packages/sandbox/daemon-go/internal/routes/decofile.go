package routes

import (
	"hash/fnv"
	"net/http"
	"path/filepath"
	"strconv"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
	"github.com/decocms/studio/sandbox-daemon/internal/decofile"
	"github.com/decocms/studio/sandbox-daemon/internal/httpx"
	"github.com/decocms/studio/sandbox-daemon/internal/paths"
)

type DecofileDeps struct {
	RepoDir string
	Store   *config.Store
}

// blocksDir resolves `.deco/blocks` under the package path (the dev-script
// cwd) when the project isn't at the repo root.
func (d DecofileDeps) blocksDir() string {
	pmPath := ""
	if cfg := d.Store.Read(); cfg != nil {
		pmPath = cfg.PmPath()
	}
	return filepath.Join(paths.ResolvePmRoot(d.RepoDir, pmPath), ".deco", decofile.BlocksDirname)
}

type MergedDecofile struct {
	Text    string
	Version string
}

// ReadDecofile merges the working-tree blocks and derives their version — the
// single definition of "what version is the draft". The Decofile route
// serves it as an ETag and the `decofile` SSE event announces it, so a
// consumer's cache key and Studio's draft pointer can never disagree.
func ReadDecofile(deps DecofileDeps) (MergedDecofile, bool) {
	text, ok := decofile.GenerateFromBlocksDeduped(deps.blocksDir())
	if !ok {
		return MergedDecofile{}, false
	}
	// A fast, non-cryptographic hash over the merged bytes — a change
	// detector, not a security boundary.
	h := fnv.New64a()
	h.Write([]byte(text))
	return MergedDecofile{Text: text, Version: strconv.FormatUint(h.Sum64(), 16)}, true
}

// Decofile serves `GET /_sandbox/decofile` — the working-tree DRAFT decofile,
// every `.deco/blocks/*.json` merged — for a production site to pull and
// render against (pull-based Fast Preview).
//
// Unauthenticated, like its neighbours `/_sandbox/{events,scripts,idle}`: the
// fetcher is an arbitrary production server, not the cluster, so it cannot
// carry the daemon bearer token. Registered ahead of the token gate in
// main.go.
//
// Content-addressed: the response carries an ETag over the merged bytes, so
// callers cache by version and re-fetch only when the draft actually
// changed.
func Decofile(deps DecofileDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		merged, ok := ReadDecofile(deps)
		if !ok {
			httpx.Error(w, http.StatusNotFound, "No .deco/blocks to serve.")
			return
		}

		etag := `W/"` + merged.Version + `"`
		if r.Header.Get("If-None-Match") == etag {
			w.Header().Set("ETag", etag)
			w.WriteHeader(http.StatusNotModified)
			return
		}

		h := w.Header()
		h.Set("Content-Type", "application/json; charset=utf-8")
		h.Set("ETag", etag)
		// The draft changes on every save; never let a shared cache hold it.
		// Callers key their own cache on the ETag instead.
		h.Set("Cache-Control", "no-store")
		// Server-to-server fetch, but the browser may probe it during dev.
		h.Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(merged.Text))
	}
}
