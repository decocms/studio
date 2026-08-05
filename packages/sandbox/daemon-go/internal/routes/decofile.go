package routes

import (
	"encoding/json"
	"hash/fnv"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
	"github.com/decocms/studio/sandbox-daemon/internal/httpx"
	"github.com/decocms/studio/sandbox-daemon/internal/paths"
)

// On-disk name of the merged decofile artifact, and the directory it merges —
// shared with `Read`'s `.deco/blocks.gen.json` fallback in fs.go.
const (
	decofileGenBasename   = "blocks.gen.json"
	decofileBlocksDirname = "blocks"
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
	return filepath.Join(paths.ResolvePmRoot(d.RepoDir, pmPath), ".deco", decofileBlocksDirname)
}

// decodeUntilStable repeatedly percent-decodes a filename stem until it stops
// changing. Real repos carry both single- and double-encoded stems
// (`Compre%20Junto.json`, `Compre%2520Junto.json`); a single decode leaves the
// double-encoded one keyed `Compre%20Junto`, a key no `__resolveType`
// reference resolves. Mirrors the frontend's documented
// decoBlockKeyFromFileStem fallback: an invalid-encoding stem keeps its last
// successfully decoded form. url.PathUnescape (not QueryUnescape) so a
// literal `+` in a block name is left alone, matching JS decodeURIComponent.
func decodeUntilStable(stem string) string {
	key := stem
	for {
		decoded, err := url.PathUnescape(key)
		if err != nil || decoded == key {
			return key
		}
		key = decoded
	}
}

// generateDecofileFromBlocks rebuilds the merged decofile from the sibling
// `.deco/blocks/*.json` files so the CMS is readable before the dev server is
// up. Maps each file to `{ [decodeUntilStable(stem)]: <file contents> }`,
// sorted by filename for a deterministic, byte-for-byte result.
//
// The merged text is built by splicing raw file bytes rather than
// unmarshal/marshal round-tripping through Go values — this payload is
// routinely multi-MB, and a malformed block isn't caught here; the client's
// parse fails and falls back to "no snapshot", same as the read/write/edit
// handlers already gate.
//
// Returns ok=false when there's no blocks dir (nothing to merge).
func generateDecofileFromBlocks(blocksDir string) (string, bool) {
	entries, err := os.ReadDir(blocksDir)
	if err != nil {
		return "", false
	}
	var names []string
	for _, e := range entries {
		if e.Type().IsRegular() && strings.HasSuffix(strings.ToLower(e.Name()), ".json") {
			names = append(names, e.Name())
		}
	}
	if len(names) == 0 {
		return "", false
	}
	sort.Strings(names)

	var b strings.Builder
	b.WriteByte('{')
	first := true
	for _, name := range names {
		stem := name[:len(name)-len(".json")]
		raw, err := os.ReadFile(filepath.Join(blocksDir, name))
		if err != nil {
			continue
		}
		content := strings.TrimSpace(string(raw))
		// Skip empty files — `"key":` with no value would break the merged JSON.
		if content == "" {
			continue
		}
		key := decodeUntilStable(stem)
		keyJSON, err := json.Marshal(key)
		if err != nil {
			continue
		}
		if !first {
			b.WriteByte(',')
		}
		first = false
		b.Write(keyJSON)
		b.WriteByte(':')
		b.WriteString(content)
	}
	b.WriteByte('}')
	return b.String(), true
}

type decofileBuild struct {
	done chan struct{}
	text string
	ok   bool
}

var (
	decofileBuildMu  sync.Mutex
	decofileInFlight = map[string]*decofileBuild{}
)

// generateDecofileFromBlocksDeduped coalesces concurrent merges for the same
// blocksDir onto one build: concurrent cold reads (multiple tabs/users on a
// shared sandbox during boot) would otherwise each redo the same multi-MB
// merge. The in-flight entry is removed once the build settles, so this is a
// coalescer, not a cache — the next read after settle rebuilds.
func generateDecofileFromBlocksDeduped(blocksDir string) (string, bool) {
	decofileBuildMu.Lock()
	if b, inFlight := decofileInFlight[blocksDir]; inFlight {
		decofileBuildMu.Unlock()
		<-b.done
		return b.text, b.ok
	}
	b := &decofileBuild{done: make(chan struct{})}
	decofileInFlight[blocksDir] = b
	decofileBuildMu.Unlock()

	b.text, b.ok = generateDecofileFromBlocks(blocksDir)

	decofileBuildMu.Lock()
	delete(decofileInFlight, blocksDir)
	decofileBuildMu.Unlock()
	close(b.done)

	return b.text, b.ok
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
	text, ok := generateDecofileFromBlocksDeduped(deps.blocksDir())
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
