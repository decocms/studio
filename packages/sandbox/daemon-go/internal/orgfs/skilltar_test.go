package orgfs

import (
	"archive/tar"
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func tarOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{
			Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestExtractSkillTar(t *testing.T) {
	dir := t.TempDir()
	raw := tarOf(t, map[string]string{
		"slides/SKILL.md":  "---\nname: slides\n---\n",
		"slides/bin/go.sh": "#!/bin/sh\n",
		"pdf/SKILL.md":     "---\nname: pdf\n---\n",
	})

	n, err := extractSkillTar(bytes.NewReader(raw), dir, "orgfs-core-", budgetOf(1<<20))
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if n != 2 {
		t.Errorf("landed %d skills, want 2", n)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "orgfs-core-slides", "SKILL.md")); err != nil ||
		!strings.Contains(string(b), "slides") {
		t.Errorf("SKILL.md not extracted: %v", err)
	}
	st, err := os.Stat(filepath.Join(dir, "orgfs-core-slides", "bin", "go.sh"))
	if err != nil {
		t.Fatalf("nested file not extracted: %v", err)
	}
	// Skill helper scripts are executed; the archive's 0644 must not disarm them.
	if st.Mode().Perm()&0o111 == 0 {
		t.Errorf("exec bit missing: %v", st.Mode().Perm())
	}
}

// Entry names come off the network. A traversal must be refused outright, not
// cleaned — a cleaned path is a different file silently substituted.
func TestExtractSkillTarRefusesTraversal(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "skills")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		"../escaped.md",
		"ok/../../escaped.md",
		"/abs/escaped.md",
		`..\escaped.md`,
		"lonely.md",
	} {
		n, _ := extractSkillTar(
			bytes.NewReader(tarOf(t, map[string]string{bad: "x"})),
			dir, "orgfs-core-", budgetOf(1<<20),
		)
		if n != 0 {
			t.Errorf("%q was extracted", bad)
		}
	}
	// Nothing anywhere outside the skills dir, and nothing inside it either.
	for _, p := range []string{
		filepath.Join(root, "escaped.md"),
		filepath.Join(dir, "escaped.md"),
	} {
		if _, err := os.Stat(p); err == nil {
			t.Errorf("traversal wrote %s", p)
		}
	}
	if entries, err := os.ReadDir(dir); err != nil || len(entries) != 0 {
		t.Errorf("skills dir not empty: %v %v", entries, err)
	}
}

func TestExtractSkillTarStopsAtBudget(t *testing.T) {
	dir := t.TempDir()
	raw := tarOf(t, map[string]string{"big/SKILL.md": strings.Repeat("x", 4096)})
	if _, err := extractSkillTar(bytes.NewReader(raw), dir, "p-", budgetOf(1024)); err == nil {
		t.Fatal("extracted past the budget")
	}
}

func TestFetchSkillTarUsesTheAPI(t *testing.T) {
	raw := tarOf(t, map[string]string{"slides/SKILL.md": "---\nname: slides\n---\n"})
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.URL.Path, r.Header.Get("authorization")
		w.Write(raw)
	}))
	defer srv.Close()

	dir := t.TempDir()
	l := &Links{}
	l.SetAPIConfig(APIConfig{BaseUrl: srv.URL, OrgSlug: "deco-studio", Token: "tok"})
	if n := l.fetchSkillTar("public-core", "core", dir, budgetOf(1<<20)); n != 1 {
		t.Fatalf("landed %d skills, want 1", n)
	}
	if gotPath != "/api/deco-studio/fs/public-core/skills.tar" {
		t.Errorf("path %q", gotPath)
	}
	if gotAuth != "Bearer tok" {
		t.Errorf("auth %q", gotAuth)
	}
	assertSkillPresent(t, dir, "orgfs-core-slides")
}

// An older studio has no such route. The daemon must report zero so the caller
// falls back to the mount, not fail the run.
func TestFetchSkillTarFallsBackOn404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", 404)
	}))
	defer srv.Close()
	l := &Links{}
	l.SetAPIConfig(APIConfig{BaseUrl: srv.URL, OrgSlug: "o", Token: "t"})
	if n := l.fetchSkillTar("public-core", "core", t.TempDir(), budgetOf(1<<20)); n != 0 {
		t.Errorf("got %d, want 0 so the caller falls back", n)
	}
}

// No config relayed yet: must not attempt a request at all.
func TestFetchSkillTarWithoutConfig(t *testing.T) {
	l := &Links{}
	if n := l.fetchSkillTar("public-core", "core", t.TempDir(), budgetOf(1<<20)); n != 0 {
		t.Errorf("got %d, want 0", n)
	}
	l.SetAPIConfig(APIConfig{BaseUrl: "", OrgSlug: "o", Token: "t"})
	if l.apiConfig() != nil {
		t.Error("accepted an incomplete config")
	}
}
