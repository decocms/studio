package decofile

import (
	"bytes"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// GenBasename is the on-disk name of the merged decofile artifact, and
// BlocksDirname its sibling source directory. `.deco/blocks.gen.json` is the
// runtime's merge of every `.deco/blocks/*.json`; many repos gitignore it (a
// multi-MB single line that conflicts on every content PR and is regenerated
// on dev cold-start), so a fresh sandbox has the block sources but not the
// merged file.
const (
	GenBasename   = "blocks.gen.json"
	BlocksDirname = "blocks"
)

// decodeOnce percent-decodes a stem exactly once — the true inverse of
// blockKeyToFileStem's single encodeURIComponent (mirrors the frontend's
// decoBlockKeyFromFileStem), and the form the deco runtime derives block keys
// by. url.PathUnescape (not QueryUnescape) leaves a literal `+` alone, matching
// JS decodeURIComponent. An invalid encoding keeps the raw stem.
func decodeOnce(stem string) string {
	decoded, err := url.PathUnescape(stem)
	if err != nil {
		return stem
	}
	return decoded
}

// generateFromBlocks rebuilds the merged decofile from the sibling
// `.deco/blocks/*.json` files so the CMS is readable before the dev server is
// up. Maps each file to `{ [decodeOnce(stem)]: <file contents> }`, sorted by
// filename — byte-for-byte identical to the TS mergeBlocks
// (packages/shared/src/decofile/merge.ts) for well-formed input.
//
// Valid blocks are spliced in raw (no unmarshal/marshal round-trip — the
// payload is routinely multi-MB). A block that is not valid JSON is DROPPED
// rather than spliced raw, which would make the whole snapshot unparseable and
// wedge the CMS; this mirrors the TS side, which dropped it to unwedge Fast
// Preview. The write/edit/publish handlers still reject invalid blocks up front
// (see InvalidBlockJSON) — this is the last-resort net for a bad block that
// arrived some other way (e.g. a direct push).
//
// The key is a SINGLE decode: a key that legitimately contains `%20` (a page
// "Home Page" → `pages-Home%20Page-<id>`) is stored `…%2520….json`, and single-
// decode gives back `%20` — the form the runtime uses. Decoding until stable
// would over-decode to a space and the `%20` reference would dangle.
//
// Returns ok=false when there's no blocks dir (nothing to merge) so the caller
// falls through to its normal "file not found" path.
func generateFromBlocks(blocksDir string) (string, bool) {
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
	// A blocks dir with no blocks in it is an EMPTY decofile, not a missing one:
	// the dir exists, so this repo does use the deco framework — it just has no
	// pages yet. Answering ok=false here made the read fall through to "file not
	// found", which Studio reads as "not a deco repo" and hides the CMS
	// affordances with, including the "Create page" that would fix it.
	if len(names) == 0 {
		return "{}", true
	}
	sort.Strings(names)

	var b strings.Builder
	b.WriteByte('{')
	first := true
	seenKeys := make(map[string]bool, len(names))
	for _, name := range names {
		stem := name[:len(name)-len(".json")]
		raw, err := os.ReadFile(filepath.Join(blocksDir, name))
		if err != nil {
			continue
		}
		// bytes.TrimSpace avoids a full-payload string copy per block.
		content := bytes.TrimSpace(raw)
		// Skip empty files — `"key":` with no value would break the merged JSON.
		if len(content) == 0 {
			continue
		}
		// Drop a block that isn't valid JSON — spliced raw it would corrupt the
		// whole snapshot. json.Valid avoids allocating a discarded value.
		if !json.Valid(content) {
			continue
		}
		key := decodeOnce(stem)
		// Two distinct filenames can decode to the same key (mirrors the TS
		// mergeBlocks fix): splicing both would silently drop one via the
		// consumer's last-key-wins JSON parse. Keep the first (sorted) file.
		if seenKeys[key] {
			continue
		}
		seenKeys[key] = true
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
		b.Write(content)
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

// GenerateFromBlocksDeduped coalesces concurrent merges for the same blocksDir
// onto one build: concurrent cold reads (multiple tabs/users on a shared
// sandbox during boot) would otherwise each redo the same multi-MB merge. The
// in-flight entry is removed once the build settles, so this is a coalescer,
// not a cache — the next read after settle rebuilds.
func GenerateFromBlocksDeduped(blocksDir string) (string, bool) {
	decofileBuildMu.Lock()
	if b, inFlight := decofileInFlight[blocksDir]; inFlight {
		decofileBuildMu.Unlock()
		<-b.done
		return b.text, b.ok
	}
	b := &decofileBuild{done: make(chan struct{})}
	decofileInFlight[blocksDir] = b
	decofileBuildMu.Unlock()

	// Clear the in-flight entry and wake followers even if the merge panics —
	// otherwise a single bad build leaves a stale entry and every present and
	// future waiter on this blocksDir blocks on b.done forever.
	defer func() {
		decofileBuildMu.Lock()
		delete(decofileInFlight, blocksDir)
		decofileBuildMu.Unlock()
		close(b.done)
	}()

	b.text, b.ok = generateFromBlocks(blocksDir)
	return b.text, b.ok
}
