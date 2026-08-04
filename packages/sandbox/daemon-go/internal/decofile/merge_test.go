package decofile

import (
	"os"
	"path/filepath"
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
		if _, ok := GenerateFromBlocks(filepath.Join(t.TempDir(), "nope")); ok {
			t.Fatal("expected ok=false for a missing blocks dir")
		}
	})

	t.Run("empty dir → ok=false", func(t *testing.T) {
		if _, ok := GenerateFromBlocks(t.TempDir()); ok {
			t.Fatal("expected ok=false for a dir with no .json files")
		}
	})

	t.Run("merges sorted, keyed by decoded stem", func(t *testing.T) {
		dir := t.TempDir()
		// Deliberately out of alphabetical write order to prove the sort.
		writeBlock(t, dir, "b.json", `{"n":2}`)
		writeBlock(t, dir, "a.json", `{"n":1}`)
		merged, ok := GenerateFromBlocks(dir)
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
		merged, ok := GenerateFromBlocks(dir)
		if !ok {
			t.Fatal("expected ok=true")
		}
		if merged != `{"keep":{"ok":true}}` {
			t.Fatalf("merged = %q", merged)
		}
	})

	t.Run("decodes percent-encoded stems until stable", func(t *testing.T) {
		dir := t.TempDir()
		// Double-encoded stem: a single decode would key it `Compre%20Junto`,
		// which no __resolveType reference resolves.
		writeBlock(t, dir, "Compre%2520Junto.json", `{"x":1}`)
		merged, ok := GenerateFromBlocks(dir)
		if !ok {
			t.Fatal("expected ok=true")
		}
		if merged != `{"Compre Junto":{"x":1}}` {
			t.Fatalf("merged = %q, want key decoded to `Compre Junto`", merged)
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
