package setup

// Real files, real tar/zstd. The uploader's whole job is to turn a node-local
// tree into an archive another node can read, so a mocked pipe proves nothing.

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// nodeLocalGolden builds the L1 layout the daemon produces:
//
//	<cacheRoot>/golden/<repoHash>/<pm>-<lockHash>/node_modules
//	                             /.golden-meta.json
//
// meta is written only when orgId is non-empty, mirroring WriteGoldenMeta.
func nodeLocalGolden(t *testing.T, cacheRoot, cloneUrl, pm, lockHash, orgId string, env ...string) string {
	t.Helper()
	dir := filepath.Join(cacheRoot, "golden", repoCacheKey(cloneUrl), pm+"-"+lockHash)
	nm := filepath.Join(dir, "node_modules", "pkg-a", "dist")
	if err := os.MkdirAll(nm, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nm, "index.js"), []byte("module.exports = 1;"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A pod-local cache that must not travel.
	vite := filepath.Join(dir, "node_modules", ".vite")
	if err := os.MkdirAll(vite, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(vite, "junk"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	goldenNodeModules := filepath.Join(dir, "node_modules")
	e := "stg"
	if len(env) > 0 {
		e = env[0]
	}
	WriteGoldenMeta(goldenNodeModules, GoldenMeta{OrgId: orgId, CloneUrl: cloneUrl, Pm: pm, Env: e})
	return goldenNodeModules
}

func TestGoldenMetaRoundTrip(t *testing.T) {
	t.Run("writes and reads back", func(t *testing.T) {
		nm := filepath.Join(t.TempDir(), "node_modules")
		if err := os.MkdirAll(nm, 0o755); err != nil {
			t.Fatal(err)
		}
		WriteGoldenMeta(nm, GoldenMeta{OrgId: "org_a", CloneUrl: "https://x/y.git", Pm: "bun"})
		got, ok := ReadGoldenMeta(nm)
		if !ok {
			t.Fatal("meta not readable")
		}
		if got.OrgId != "org_a" || got.CloneUrl != "https://x/y.git" || got.Pm != "bun" {
			t.Fatalf("round trip lost fields: %+v", got)
		}
	})

	// Absence is the signal that a golden is not eligible for a shared store.
	// Writing an org-less meta would make it look eligible with an unknown owner.
	t.Run("writes nothing without an org", func(t *testing.T) {
		dir := t.TempDir()
		nm := filepath.Join(dir, "node_modules")
		if err := os.MkdirAll(nm, 0o755); err != nil {
			t.Fatal(err)
		}
		WriteGoldenMeta(nm, GoldenMeta{CloneUrl: "https://x/y.git"})
		if _, ok := ReadGoldenMeta(nm); ok {
			t.Fatal("reported provenance for a golden with no org")
		}
		if _, err := os.Stat(goldenMetaPath(nm)); err == nil {
			t.Fatal("created a meta file with no org")
		}
	})

	t.Run("unreadable meta is absent meta", func(t *testing.T) {
		dir := t.TempDir()
		nm := filepath.Join(dir, "node_modules")
		if err := os.MkdirAll(nm, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(goldenMetaPath(nm), []byte("{not json"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, ok := ReadGoldenMeta(nm); ok {
			t.Fatal("accepted corrupt meta")
		}
	})

	// The meta lives inside the golden's own directory so the existing prune
	// removes it with the tree it describes, and it can never outlive it.
	t.Run("lives inside the golden directory", func(t *testing.T) {
		nm := "/cache/golden/abc/bun-def/node_modules"
		if want := "/cache/golden/abc/bun-def/" + goldenMetaName; goldenMetaPath(nm) != want {
			t.Fatalf("got %q want %q", goldenMetaPath(nm), want)
		}
	})
}

func TestSplitGoldenLockDir(t *testing.T) {
	for _, c := range []struct {
		in, pm, hash string
		ok           bool
	}{
		{"bun-abc123", "bun", "abc123", true},
		{"pnpm-deadbeef", "pnpm", "deadbeef", true},
		{"bun", "", "", false},
		{"-abc", "", "", false},
		{"bun-", "", "", false},
		{"", "", "", false},
	} {
		pm, hash, ok := splitGoldenLockDir(c.in)
		if ok != c.ok || pm != c.pm || hash != c.hash {
			t.Fatalf("%q → (%q, %q, %v), want (%q, %q, %v)", c.in, pm, hash, ok, c.pm, c.hash, c.ok)
		}
	}
}

func TestUploadNodeGoldens(t *testing.T) {
	t.Run("uploads a golden with provenance, keyed by org", func(t *testing.T) {
		requireTools(t)
		cache, remote := t.TempDir(), t.TempDir()
		nodeLocalGolden(t, cache, "https://github.com/acme/site.git", "bun", "lock1", testOrg)

		s := UploadNodeGoldens(UploaderOpts{CacheRoot: cache, RemoteRoot: remote, Env: "stg"})
		if s.Uploaded != 1 || s.Scanned != 1 {
			t.Fatalf("unexpected stats: %+v", s)
		}
		want := RemoteGoldenArchivePath(remote, testOrg, "https://github.com/acme/site.git", "bun", "lock1")
		if !fileExists(want) {
			t.Fatalf("archive not at the org-keyed path %q", want)
		}
	})

	// The safe default: an archive whose owner is unknown must not exist, because
	// a repo hash alone does not isolate two orgs cloning the same template.
	t.Run("skips a golden with no provenance", func(t *testing.T) {
		requireTools(t)
		cache, remote := t.TempDir(), t.TempDir()
		nodeLocalGolden(t, cache, "https://github.com/acme/site.git", "bun", "lock1", "")

		s := UploadNodeGoldens(UploaderOpts{CacheRoot: cache, RemoteRoot: remote, Env: "stg"})
		if s.Uploaded != 0 || s.NoMeta != 1 {
			t.Fatalf("unexpected stats: %+v", s)
		}
		if entries, _ := os.ReadDir(remote); len(entries) != 0 {
			t.Fatal("wrote to the shared store without knowing the owner")
		}
	})

	t.Run("second sweep skips what is already there", func(t *testing.T) {
		requireTools(t)
		cache, remote := t.TempDir(), t.TempDir()
		nodeLocalGolden(t, cache, "https://github.com/acme/site.git", "bun", "lock1", testOrg)
		opts := UploaderOpts{CacheRoot: cache, RemoteRoot: remote, Env: "stg"}

		UploadNodeGoldens(opts)
		archive := RemoteGoldenArchivePath(remote, testOrg, "https://github.com/acme/site.git", "bun", "lock1")
		before, err := os.Stat(archive)
		if err != nil {
			t.Fatal(err)
		}

		s := UploadNodeGoldens(opts)
		if s.Uploaded != 0 || s.Skipped != 1 {
			t.Fatalf("unexpected stats on the steady-state sweep: %+v", s)
		}
		after, err := os.Stat(archive)
		if err != nil {
			t.Fatal(err)
		}
		if !before.ModTime().Equal(after.ModTime()) {
			t.Fatal("recompressed an archive that was already published")
		}
	})

	t.Run("the archive is restorable on a cold root", func(t *testing.T) {
		requireTools(t)
		cache, remote := t.TempDir(), t.TempDir()
		nodeLocalGolden(t, cache, "https://github.com/acme/site.git", "bun", "lock1", testOrg)
		UploadNodeGoldens(UploaderOpts{CacheRoot: cache, RemoteRoot: remote, Env: "stg"})

		// A different node: same lockfile content, nothing installed.
		cold := t.TempDir()
		if err := os.WriteFile(filepath.Join(cold, "bun.lock"), []byte("whatever"), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Setenv(remoteEnabledEnvVar, remote)
		p := RemoteGoldenParams{
			RemoteRoot: remote, OrgId: testOrg,
			CloneUrl: "https://github.com/acme/site.git", InstallRoot: cold, Pm: "bun",
		}
		// The lock hash is derived from the file, so point the archive at it.
		archive := RemoteGoldenArchivePath(remote, testOrg, "https://github.com/acme/site.git", "bun",
			LockfileHash(cold, "bun"))
		if err := os.MkdirAll(filepath.Dir(archive), 0o755); err != nil {
			t.Fatal(err)
		}
		published := RemoteGoldenArchivePath(remote, testOrg, "https://github.com/acme/site.git", "bun", "lock1")
		if err := os.Rename(published, archive); err != nil {
			t.Fatal(err)
		}

		if !TryRestoreRemoteGolden(p) {
			t.Fatal("the uploaded archive did not restore")
		}
		if _, err := os.Stat(filepath.Join(cold, "node_modules", "pkg-a", "dist", "index.js")); err != nil {
			t.Fatalf("restored tree incomplete: %v", err)
		}
		if _, err := os.Stat(filepath.Join(cold, "node_modules", ".vite")); err == nil {
			t.Fatal(".vite travelled — pod-local churn must not be in a shared archive")
		}
	})

	t.Run("two orgs on the same repo get separate archives", func(t *testing.T) {
		requireTools(t)
		cache, remote := t.TempDir(), t.TempDir()
		// Same clone URL, same lockfile — the collision the org key exists to stop.
		// Distinct cache roots because the node-local path has no org in it.
		cacheA := filepath.Join(cache, "a")
		cacheB := filepath.Join(cache, "b")
		nodeLocalGolden(t, cacheA, "https://github.com/deco-cx/template.git", "bun", "lock1", "org_a")
		nodeLocalGolden(t, cacheB, "https://github.com/deco-cx/template.git", "bun", "lock1", "org_b")

		UploadNodeGoldens(UploaderOpts{CacheRoot: cacheA, RemoteRoot: remote, Env: "stg"})
		UploadNodeGoldens(UploaderOpts{CacheRoot: cacheB, RemoteRoot: remote, Env: "stg"})

		a := RemoteGoldenArchivePath(remote, "org_a", "https://github.com/deco-cx/template.git", "bun", "lock1")
		b := RemoteGoldenArchivePath(remote, "org_b", "https://github.com/deco-cx/template.git", "bun", "lock1")
		if a == b {
			t.Fatal("keys collided")
		}
		if !fileExists(a) || !fileExists(b) {
			t.Fatal("one org's archive is missing — the other overwrote it")
		}
	})

	t.Run("no-ops without both roots", func(t *testing.T) {
		if s := UploadNodeGoldens(UploaderOpts{}); s.Scanned != 0 {
			t.Fatal("scanned with no roots configured")
		}
		if s := UploadNodeGoldens(UploaderOpts{CacheRoot: t.TempDir()}); s.Scanned != 0 {
			t.Fatal("scanned with no remote root")
		}
		if s := UploadNodeGoldens(UploaderOpts{RemoteRoot: t.TempDir()}); s.Scanned != 0 {
			t.Fatal("scanned with no cache root")
		}
	})

	t.Run("an empty node-local store is not an error", func(t *testing.T) {
		cache, remote := t.TempDir(), t.TempDir()
		if s := UploadNodeGoldens(UploaderOpts{CacheRoot: cache, RemoteRoot: remote, Env: "stg"}); s.Scanned != 0 {
			t.Fatalf("unexpected stats on an empty store: %+v", s)
		}
	})

	// A golden directory mid-publish has no node_modules yet. Uploading one would
	// mean shipping a partial tree fleet-wide.
	t.Run("skips a directory with no node_modules", func(t *testing.T) {
		cache, remote := t.TempDir(), t.TempDir()
		half := filepath.Join(cache, "golden", "abc123", "bun-lock1")
		if err := os.MkdirAll(half, 0o755); err != nil {
			t.Fatal(err)
		}
		if s := UploadNodeGoldens(UploaderOpts{CacheRoot: cache, RemoteRoot: remote, Env: "stg"}); s.Scanned != 0 {
			t.Fatalf("scanned an in-flight publish: %+v", s)
		}
	})

	t.Run("sweeps every repo and lockfile on the node", func(t *testing.T) {
		requireTools(t)
		cache, remote := t.TempDir(), t.TempDir()
		for i := 0; i < 3; i++ {
			url := fmt.Sprintf("https://github.com/acme/site-%d.git", i)
			nodeLocalGolden(t, cache, url, "bun", "lock1", testOrg)
			nodeLocalGolden(t, cache, url, "bun", "lock2", testOrg)
		}
		s := UploadNodeGoldens(UploaderOpts{CacheRoot: cache, RemoteRoot: remote, Env: "stg"})
		if s.Scanned != 6 || s.Uploaded != 6 {
			t.Fatalf("unexpected stats: %+v", s)
		}
	})
}

// Nodes are shared across environments: prod and stg sandboxes run on one
// NodePool, so a node's hostPath store holds a mix. Each uploader must forward
// only its own — a neighbour's archive would land under this environment's key
// prefix, where that environment's sandboxes never look, so compressing and
// shipping it is pure waste.
func TestUploadNodeGoldensScopesByEnv(t *testing.T) {
	requireTools(t)
	cache, remote := t.TempDir(), t.TempDir()
	nodeLocalGolden(t, cache, "https://github.com/acme/mine.git", "bun", "l1", testOrg, "stg")
	nodeLocalGolden(t, cache, "https://github.com/acme/theirs.git", "bun", "l1", testOrg, "prod")

	s := UploadNodeGoldens(UploaderOpts{CacheRoot: cache, RemoteRoot: remote, Env: "stg"})
	if s.Uploaded != 1 || s.OtherEnv != 1 {
		t.Fatalf("expected 1 uploaded and 1 skipped as another env, got %+v", s)
	}
	if !fileExists(RemoteGoldenArchivePath(remote, testOrg, "https://github.com/acme/mine.git", "bun", "l1")) {
		t.Fatal("did not upload this environment's own golden")
	}
	if fileExists(RemoteGoldenArchivePath(remote, testOrg, "https://github.com/acme/theirs.git", "bun", "l1")) {
		t.Fatal("uploaded another environment's golden")
	}
}

// An uploader with no Env configured forwards everything. Correct only where a
// single environment owns the nodes, and the documented behaviour of the field.
func TestUploadNodeGoldensUnscopedForwardsAll(t *testing.T) {
	requireTools(t)
	cache, remote := t.TempDir(), t.TempDir()
	nodeLocalGolden(t, cache, "https://github.com/acme/a.git", "bun", "l1", testOrg, "stg")
	nodeLocalGolden(t, cache, "https://github.com/acme/b.git", "bun", "l1", testOrg, "prod")

	s := UploadNodeGoldens(UploaderOpts{CacheRoot: cache, RemoteRoot: remote})
	if s.Uploaded != 2 || s.OtherEnv != 0 {
		t.Fatalf("expected both uploaded with no env scope, got %+v", s)
	}
}

// A golden written before the env was threaded through has no env in its meta.
// It is skipped by a scoped uploader rather than guessed at: the alternative is
// shipping a tree that may belong to another environment.
func TestUploadNodeGoldensSkipsGoldenWithoutEnv(t *testing.T) {
	requireTools(t)
	cache, remote := t.TempDir(), t.TempDir()
	nodeLocalGolden(t, cache, "https://github.com/acme/legacy.git", "bun", "l1", testOrg, "")

	s := UploadNodeGoldens(UploaderOpts{CacheRoot: cache, RemoteRoot: remote, Env: "stg"})
	if s.Uploaded != 0 || s.OtherEnv != 1 {
		t.Fatalf("expected the env-less golden skipped, got %+v", s)
	}
}
