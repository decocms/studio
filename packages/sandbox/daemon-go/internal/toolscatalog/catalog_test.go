package toolscatalog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCatalogFilesSanitizesAndDisambiguates(t *testing.T) {
	files, err := CatalogFiles([]Tool{
		{Name: "a/b"},
		{Name: "a_b"}, // sanitizes to the same filename as a/b
		{Name: ""},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := []string{files[0].Filename, files[1].Filename, files[2].Filename}
	want := []string{"a_b.json", "a_b-2.json", "tool.json"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("filename %d: got %q want %q", i, got[i], want[i])
		}
	}

	// The original name survives inside the file even though it was sanitized
	// out of the filename — otherwise a tool becomes uncallable.
	var body map[string]any
	if err := json.Unmarshal(files[0].Content, &body); err != nil {
		t.Fatal(err)
	}
	if body["name"] != "a/b" {
		t.Fatalf("name: got %v want a/b", body["name"])
	}
	if schema, _ := body["inputSchema"].(map[string]any); schema["type"] != "object" {
		t.Fatalf("missing inputSchema default, got %v", body["inputSchema"])
	}
}

func TestWriteCatalogPrunesStaleEntriesButNotDotfiles(t *testing.T) {
	repo := t.TempDir()
	opts := Opts{AppRoot: repo, RepoDir: repo}

	if _, err := WriteEndpointFile(Endpoint{URL: "http://x/mcp", Headers: nil}, opts); err != nil {
		t.Fatal(err)
	}
	if _, _, err := WriteCatalog([]Tool{{Name: "OLD_TOOL"}}, opts); err != nil {
		t.Fatal(err)
	}
	count, names, err := WriteCatalog([]Tool{{Name: "NEW_TOOL"}}, opts)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 || len(names) != 1 || names[0] != "NEW_TOOL" {
		t.Fatalf("got count=%d names=%v", count, names)
	}

	dir := filepath.Join(repo, CatalogDir)
	if _, err := os.Stat(filepath.Join(dir, "OLD_TOOL.json")); !os.IsNotExist(err) {
		t.Fatal("stale catalog entry survived the prune")
	}
	if _, err := os.Stat(filepath.Join(dir, "NEW_TOOL.json")); err != nil {
		t.Fatal("fresh catalog entry missing")
	}
	// The endpoint file is a dotfile precisely so the prune never eats it.
	if _, err := os.Stat(filepath.Join(dir, EndpointFilename)); err != nil {
		t.Fatal("prune deleted the endpoint file")
	}
}

func TestWriteEndpointFileIsPrivateAndOmitsUnsetExpiry(t *testing.T) {
	repo := t.TempDir()
	ok, err := WriteEndpointFile(
		Endpoint{URL: "http://x/mcp", Headers: map[string]string{"Authorization": "Bearer k"}},
		Opts{AppRoot: repo, RepoDir: repo},
	)
	if err != nil || !ok {
		t.Fatalf("write failed: ok=%v err=%v", ok, err)
	}
	path := filepath.Join(repo, CatalogDir, EndpointFilename)
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// It holds a bearer credential.
	if perm := st.Mode().Perm(); perm != 0o600 {
		t.Fatalf("mode: got %o want 600", perm)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	if _, present := body["expiresAt"]; present {
		t.Fatal("unset expiresAt must be omitted, not written as 0")
	}
}

func TestSafePathClampBlocksEscape(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(root, "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	// repoDir sits outside appRoot, so every catalog path escapes the clamp.
	count, names, err := WriteCatalog(
		[]Tool{{Name: "NOPE"}},
		Opts{AppRoot: filepath.Join(root, "app"), RepoDir: outside},
	)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 || len(names) != 0 {
		t.Fatalf("escaping write was not refused: count=%d names=%v", count, names)
	}
	if _, err := os.Stat(filepath.Join(outside, CatalogDir)); !os.IsNotExist(err) {
		t.Fatal("wrote outside the workspace root")
	}
}
