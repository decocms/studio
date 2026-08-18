package decofile

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
)

func writeBlock(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

func TestGenerateFromBlocks(t *testing.T) {
	t.Run("missing dir → ok=false", func(t *testing.T) {
		if _, ok := generateFromBlocks(filepath.Join(t.TempDir(), "nope")); ok {
			t.Fatal("expected ok=false for a missing blocks dir")
		}
	})

	t.Run("empty dir → ok=false", func(t *testing.T) {
		if _, ok := generateFromBlocks(t.TempDir()); ok {
			t.Fatal("expected ok=false for a dir with no .json files")
		}
	})

	t.Run("merges sorted, keyed by decoded stem", func(t *testing.T) {
		dir := t.TempDir()
		// Deliberately out of alphabetical write order to prove the sort.
		writeBlock(t, dir, "b.json", `{"n":2}`)
		writeBlock(t, dir, "a.json", `{"n":1}`)
		merged, ok := generateFromBlocks(dir)
		if !ok {
			t.Fatal("expected ok=true")
		}
		want := `{"a":{"n":1},"b":{"n":2}}`
		if merged != want {
			t.Fatalf("merged = %q, want %q", merged, want)
		}
	})

	t.Run("skips non-json and empty files", func(t *testing.T) {
		dir := t.TempDir()
		writeBlock(t, dir, "keep.json", `{"ok":true}`)
		writeBlock(t, dir, "notes.txt", "ignored")
		writeBlock(t, dir, "blank.json", "   \n  ")
		merged, ok := generateFromBlocks(dir)
		if !ok {
			t.Fatal("expected ok=true")
		}
		if merged != `{"keep":{"ok":true}}` {
			t.Fatalf("merged = %q", merged)
		}
	})

	t.Run("drops a block that is not valid JSON", func(t *testing.T) {
		dir := t.TempDir()
		writeBlock(t, dir, "good.json", `{"ok":true}`)
		// A raw `.tsx` source spliced in would make the whole snapshot unparseable.
		writeBlock(t, dir, "broken.json", `import { H } from './x'`)
		merged, ok := generateFromBlocks(dir)
		if !ok {
			t.Fatal("expected ok=true")
		}
		if merged != `{"good":{"ok":true}}` {
			t.Fatalf("merged = %q, want the broken block dropped", merged)
		}
		var v any
		if err := json.Unmarshal([]byte(merged), &v); err != nil {
			t.Fatalf("merged blob is not valid JSON: %v", err)
		}
	})

	t.Run("single-decodes a single-encoded stem (space in the key)", func(t *testing.T) {
		dir := t.TempDir()
		writeBlock(t, dir, "Compre%20Junto.json", `{"x":1}`)
		merged, ok := generateFromBlocks(dir)
		if !ok {
			t.Fatal("expected ok=true")
		}
		if merged != `{"Compre Junto":{"x":1}}` {
			t.Fatalf("merged = %q, want the space key", merged)
		}
	})

	t.Run("single-decodes a double-encoded stem to its %20 key, not a space", func(t *testing.T) {
		dir := t.TempDir()
		writeBlock(t, dir, "Compre%2520Junto.json", `{"x":1}`)
		merged, ok := generateFromBlocks(dir)
		if !ok {
			t.Fatal("expected ok=true")
		}
		if merged != `{"Compre%20Junto":{"x":1}}` {
			t.Fatalf("merged = %q, want the single-decoded %%20 key", merged)
		}
	})

	t.Run("keys a %20-bearing page the way the runtime resolves it", func(t *testing.T) {
		dir := t.TempDir()
		// "Home Page" is keyed `pages-Home%20Page-<id>`, stored `…%2520….json`.
		writeBlock(t, dir, "pages-Home%2520Page-40404.json", `{"t":1}`)
		merged, ok := generateFromBlocks(dir)
		if !ok {
			t.Fatal("expected ok=true")
		}
		if merged != `{"pages-Home%20Page-40404":{"t":1}}` {
			t.Fatalf("merged = %q, want the runtime's %%20 key", merged)
		}
	})

	// Blocks are written to disk pretty-printed (`JSON.stringify(data, null, 2)`),
	// so the merged blob is multi-line. The fallback returns it un-numbered, and
	// the consumer runs it through stripLineNumbers (strip `^\d+\t` per line)
	// before JSON.parse — a no-op ONLY if no line begins with a digit+tab. Valid
	// pretty JSON never does (lines open with `{`, `}`, `"`, or space indent), so
	// the round-trip must survive. Lock that invariant in.
	t.Run("multi-line pretty-printed blocks survive the line-number strip", func(t *testing.T) {
		dir := t.TempDir()
		pretty := func(v any) string {
			b, err := json.MarshalIndent(v, "", "  ")
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			return string(b)
		}
		writeBlock(t, dir, "hero.json", pretty(map[string]any{"title": "Hi", "count": 3}))
		writeBlock(t, dir, "shelf.json", pretty(map[string]any{"items": []int{1, 2}}))

		merged, ok := generateFromBlocks(dir)
		if !ok {
			t.Fatal("expected ok=true")
		}
		if !strings.Contains(merged, "\n") {
			t.Fatal("expected a multi-line merged blob to exercise the strip round-trip")
		}
		// No line may start with `^\d+\t` — that's what stripLineNumbers eats.
		lineNum := regexp.MustCompile(`(?m)^\d+\t`)
		if lineNum.MatchString(merged) {
			t.Fatalf("a merged line starts with a line-number prefix; strip would corrupt it:\n%s", merged)
		}
		// The un-numbered blob must still be valid JSON with both blocks.
		var got map[string]any
		if err := json.Unmarshal([]byte(merged), &got); err != nil {
			t.Fatalf("merged blob is not valid JSON: %v\n%s", err, merged)
		}
		if _, ok := got["hero"]; !ok {
			t.Fatalf("missing hero block: %s", merged)
		}
		if _, ok := got["shelf"]; !ok {
			t.Fatalf("missing shelf block: %s", merged)
		}
	})
}

func TestGenerateFromBlocksDeduped(t *testing.T) {
	dir := t.TempDir()
	writeBlock(t, dir, "a.json", `{"n":1}`)
	merged, ok := GenerateFromBlocksDeduped(dir)
	if !ok || merged != `{"a":{"n":1}}` {
		t.Fatalf("deduped merge = %q ok=%v", merged, ok)
	}
}

// The coalescer's whole point is concurrent cold reads; exercise it under
// `go test -race` so a data race on decofileInFlight or a coalescing regression
// surfaces. All callers on one blocksDir must agree.
func TestGenerateFromBlocksDeduped_Concurrent(t *testing.T) {
	dir := t.TempDir()
	writeBlock(t, dir, "a.json", `{"n":1}`)
	writeBlock(t, dir, "b.json", `{"n":2}`)
	const want = `{"a":{"n":1},"b":{"n":2}}`

	const goroutines = 32
	var wg sync.WaitGroup
	results := make([]string, goroutines)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			merged, ok := GenerateFromBlocksDeduped(dir)
			if !ok {
				t.Errorf("goroutine %d: ok=false", i)
				return
			}
			results[i] = merged
		}(i)
	}
	wg.Wait()
	for i, got := range results {
		if got != want {
			t.Fatalf("goroutine %d: merged = %q, want %q", i, got, want)
		}
	}
}
