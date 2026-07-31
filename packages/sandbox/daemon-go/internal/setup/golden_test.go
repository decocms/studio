package setup

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

const (
	testCacheRoot = "/deps-cache"
	testRepoUrl   = "https://github.com/o/n.git"
)

func TestGoldenNodeModulesPath(t *testing.T) {
	t.Run("empty without cacheRoot / cloneUrl / lockHash", func(t *testing.T) {
		if got := GoldenNodeModulesPath("", testRepoUrl, "bun", "abc123"); got != "" {
			t.Errorf("no cacheRoot: got %q", got)
		}
		if got := GoldenNodeModulesPath(testCacheRoot, "", "bun", "abc123"); got != "" {
			t.Errorf("no cloneUrl: got %q", got)
		}
		if got := GoldenNodeModulesPath(testCacheRoot, testRepoUrl, "bun", ""); got != "" {
			t.Errorf("no lockHash: got %q", got)
		}
	})

	t.Run("composes <root>/golden/<repo>/<pm>-<lockhash>/node_modules", func(t *testing.T) {
		got := GoldenNodeModulesPath(testCacheRoot, testRepoUrl, "bun", "abc123")
		want := filepath.Join(testCacheRoot, "golden", repoCacheKey(testRepoUrl), "bun-abc123", "node_modules")
		if got != want {
			t.Errorf("got %q want %q", got, want)
		}
	})

	// The security boundary: two repos must never resolve to one golden. The
	// package manager does not re-verify cache content, so a shared golden across
	// repos would be a cross-tenant write primitive.
	t.Run("repo A's golden is unreachable from repo B", func(t *testing.T) {
		a := GoldenNodeModulesPath(testCacheRoot, testRepoUrl, "bun", "same-lock")
		b := GoldenNodeModulesPath(testCacheRoot, "https://github.com/o/other.git", "bun", "same-lock")
		if a == b {
			t.Fatalf("identical lockfiles in different repos share a golden: %q", a)
		}
		// Not merely different strings: neither path may sit inside the other's
		// repo dir, or one sandbox could walk up into the other's cache.
		if dirA, dirB := filepath.Dir(filepath.Dir(a)), filepath.Dir(filepath.Dir(b)); dirA == dirB {
			t.Fatalf("both repos share the same repo dir %q", dirA)
		}
	})

	t.Run("stable across git-token refresh (credential-stripped key)", func(t *testing.T) {
		url := func(tok string) string {
			return "https://x-access-token:" + tok + "@github.com/o/n.git"
		}
		a := GoldenNodeModulesPath(testCacheRoot, url("tok1"), "bun", "abc123")
		b := GoldenNodeModulesPath(testCacheRoot, url("tok2"), "bun", "abc123")
		bare := GoldenNodeModulesPath(testCacheRoot, testRepoUrl, "bun", "abc123")
		if a != b || a != bare {
			t.Errorf("token rotation changed the key: %q / %q / %q", a, b, bare)
		}
	})

	t.Run("separates package managers for the same lockfile hash", func(t *testing.T) {
		bun := GoldenNodeModulesPath(testCacheRoot, testRepoUrl, "bun", "abc123")
		pnpm := GoldenNodeModulesPath(testCacheRoot, testRepoUrl, "pnpm", "abc123")
		if bun == pnpm {
			t.Error("bun and pnpm share a golden")
		}
	})
}

func TestLockfileHash(t *testing.T) {
	write := func(t *testing.T, name, content string) string {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return dir
	}

	t.Run("empty when no lockfile is present", func(t *testing.T) {
		if got := LockfileHash(t.TempDir(), "bun"); got != "" {
			t.Errorf("got %q", got)
		}
	})

	t.Run("empty for a package manager with no known lockfile", func(t *testing.T) {
		if got := LockfileHash(write(t, "bun.lock", "x"), "deno"); got != "" {
			t.Errorf("got %q", got)
		}
	})

	t.Run("hashes content — same bytes same hash, different bytes differ", func(t *testing.T) {
		a := LockfileHash(write(t, "bun.lock", "lockfile-A"), "bun")
		b := LockfileHash(write(t, "bun.lock", "lockfile-A"), "bun")
		c := LockfileHash(write(t, "bun.lock", "lockfile-B"), "bun")
		if a == "" {
			t.Fatal("no hash for a present lockfile")
		}
		if a != b {
			t.Errorf("identical lockfiles hashed differently: %q vs %q", a, b)
		}
		if a == c {
			t.Error("different lockfiles hashed the same")
		}
	})

	t.Run("picks the pm's own lockfile", func(t *testing.T) {
		dir := write(t, "package-lock.json", "{}")
		if LockfileHash(dir, "npm") == "" {
			t.Error("npm ignored package-lock.json")
		}
		if got := LockfileHash(dir, "bun"); got != "" {
			t.Errorf("bun read an npm lockfile: %q", got)
		}
	})
}

func TestGoldenEnabled(t *testing.T) {
	t.Run("off when unset", func(t *testing.T) {
		os.Unsetenv(goldenEnabledEnvVar)
		if GoldenEnabled() {
			t.Error("enabled with no env var — golden must ship dormant")
		}
	})
	t.Run("on for 1 and true only", func(t *testing.T) {
		for _, v := range []string{"1", "true"} {
			t.Setenv(goldenEnabledEnvVar, v)
			if !GoldenEnabled() {
				t.Errorf("%q did not enable", v)
			}
		}
		for _, v := range []string{"0", "false", "yes", "", "on", "TRUE"} {
			t.Setenv(goldenEnabledEnvVar, v)
			if GoldenEnabled() {
				t.Errorf("%q enabled golden", v)
			}
		}
	})
}

func TestSameFilesystem(t *testing.T) {
	dir := t.TempDir()
	if !SameFilesystem(dir, dir) {
		t.Error("a path is not on its own filesystem")
	}
	if SameFilesystem(filepath.Join(dir, "nope"), dir) {
		t.Error("a missing path reported as same-fs")
	}
}

func TestPruneGoldens(t *testing.T) {
	// A golden dir <root>/golden/<repo>/<name> with a given mtime.
	mkGolden := func(t *testing.T, root, repo, name string, mtime time.Time) string {
		dir := filepath.Join(root, "golden", repo, name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(dir, mtime, mtime); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	exists := func(p string) bool { _, err := os.Stat(p); return err == nil }
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	day := 24 * time.Hour

	t.Run("no-ops on a missing root and an empty store", func(t *testing.T) {
		pruneGoldens(filepath.Join(t.TempDir(), "absent"), GoldenTTL, GoldenMaxPerRepo, now)
		pruneGoldens(t.TempDir(), GoldenTTL, GoldenMaxPerRepo, now)
	})

	t.Run("drops goldens past the TTL, keeps fresh ones", func(t *testing.T) {
		root := t.TempDir()
		fresh := mkGolden(t, root, "repoA", "bun-fresh", now.Add(-time.Second))
		stale := mkGolden(t, root, "repoA", "bun-stale", now.Add(-10*day))
		pruneGoldens(root, 7*day, 99, now)
		if !exists(fresh) {
			t.Error("pruned a fresh golden")
		}
		if exists(stale) {
			t.Error("kept a golden past its TTL")
		}
	})

	t.Run("caps to the newest maxPerRepo", func(t *testing.T) {
		root := t.TempDir()
		var dirs []string
		for i := range 4 {
			dirs = append(dirs, mkGolden(t, root, "repoB", "bun-"+string(rune('0'+i)),
				now.Add(-time.Duration(i)*time.Second)))
		}
		pruneGoldens(root, 999*day, 2, now)
		for i, d := range dirs {
			if want := i < 2; exists(d) != want {
				t.Errorf("dir %d: exists=%v want %v", i, exists(d), want)
			}
		}
	})

	t.Run("never reaps an in-flight .tmp. publish", func(t *testing.T) {
		root := t.TempDir()
		// Ancient and over every bound, but a live publish is renaming into place.
		inflight := mkGolden(t, root, "repoC", ".tmp.123.node_modules", now.Add(-999*day))
		pruneGoldens(root, time.Nanosecond, 0, now)
		if !exists(inflight) {
			t.Error("reaped an in-flight publish — that publish now renames onto nothing")
		}
	})

	t.Run("prunes each repo independently", func(t *testing.T) {
		root := t.TempDir()
		a := mkGolden(t, root, "repoA", "bun-1", now)
		b := mkGolden(t, root, "repoB", "bun-1", now)
		pruneGoldens(root, 999*day, 5, now)
		if !exists(a) || !exists(b) {
			t.Error("one repo's entries counted against another's cap")
		}
	})
}

// useBestCloner points cloneTree at the most faithful clone this machine can
// actually do, and reports whether it is copy-on-write. Prod reflinks on xfs;
// a dev mac has clonefile but no GNU cp, and ext4 CI has neither — so the
// publish/restore/isolation logic is tested everywhere and only the CoW
// independence assertion is conditional.
func useBestCloner(t *testing.T) (isCoW bool) {
	t.Helper()
	probe := func(fn func(string, string) int) bool {
		src, dst := t.TempDir(), filepath.Join(t.TempDir(), "probe")
		return fn(src, dst) == 0
	}
	darwinClone := func(src, dst string) int {
		return runCp([]string{"-a", "-c", src, dst})
	}
	plainCopy := func(src, dst string) int {
		return runCp([]string{"-a", src, dst})
	}
	for _, c := range []struct {
		fn  func(string, string) int
		cow bool
	}{{reflinkClone, true}, {darwinClone, true}, {plainCopy, false}} {
		if probe(c.fn) {
			orig := cloneTree
			cloneTree = c.fn
			t.Cleanup(func() { cloneTree = orig })
			return c.cow
		}
	}
	t.Fatal("no working cp on this machine")
	return false
}

// The restore/publish round trip, exercised for real against the filesystem.
func TestGoldenRoundTrip(t *testing.T) {
	isCoW := useBestCloner(t)
	cacheRoot := t.TempDir()
	installRoot := t.TempDir()
	t.Setenv(goldenEnabledEnvVar, "1")

	nodeModules := filepath.Join(installRoot, "node_modules")
	if err := os.MkdirAll(filepath.Join(nodeModules, ".vite"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(installRoot, "bun.lock"), []byte("lock"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nodeModules, "dep.txt"), []byte("installed"), 0o644); err != nil {
		t.Fatal(err)
	}

	p := GoldenParams{CacheRoot: cacheRoot, CloneUrl: testRepoUrl, InstallRoot: installRoot, Pm: "bun"}
	if TryRestoreGolden(p) {
		t.Fatal("restored from an empty store")
	}
	PublishGolden(p)

	golden := GoldenNodeModulesPath(cacheRoot, testRepoUrl, "bun", LockfileHash(installRoot, "bun"))
	if _, err := os.Stat(golden); err != nil {
		t.Fatalf("publish left no golden at %s: %v", golden, err)
	}
	// Pod-local runtime caches must not travel in a shared golden.
	if _, err := os.Stat(filepath.Join(golden, ".vite")); err == nil {
		t.Error(".vite published into the golden")
	}

	// A second sandbox on this node, same repo and lockfile: restores, no install.
	other := t.TempDir()
	if err := os.WriteFile(filepath.Join(other, "bun.lock"), []byte("lock"), 0o644); err != nil {
		t.Fatal(err)
	}
	q := GoldenParams{CacheRoot: cacheRoot, CloneUrl: testRepoUrl, InstallRoot: other, Pm: "bun"}
	if !TryRestoreGolden(q) {
		t.Fatal("did not restore a published golden")
	}
	got, err := os.ReadFile(filepath.Join(other, "node_modules", "dep.txt"))
	if err != nil || string(got) != "installed" {
		t.Fatalf("restored tree is wrong: %q %v", got, err)
	}

	// A different repo with a byte-identical lockfile must NOT restore.
	third := t.TempDir()
	if err := os.WriteFile(filepath.Join(third, "bun.lock"), []byte("lock"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := GoldenParams{CacheRoot: cacheRoot, CloneUrl: "https://github.com/o/other.git", InstallRoot: third, Pm: "bun"}
	if TryRestoreGolden(r) {
		t.Fatal("repo B restored repo A's golden — cross-repo cache isolation is broken")
	}

	// CoW, not a shared inode: writing the restored copy must not touch the
	// golden. Only meaningful when the clone was actually copy-on-write — a plain
	// copy trivially passes and would prove nothing about the prod path.
	if isCoW {
		if err := os.WriteFile(filepath.Join(other, "node_modules", "dep.txt"), []byte("mutated"), 0o644); err != nil {
			t.Fatal(err)
		}
		if got, _ := os.ReadFile(filepath.Join(golden, "dep.txt")); string(got) != "installed" {
			t.Errorf("a pod's write reached the shared golden: %q", got)
		}
	}
}

// The kill switch has to gate both directions, or "disabled" still writes.
func TestGoldenDisabledDoesNothing(t *testing.T) {
	os.Unsetenv(goldenEnabledEnvVar)
	cacheRoot, installRoot := t.TempDir(), t.TempDir()
	nodeModules := filepath.Join(installRoot, "node_modules")
	os.MkdirAll(nodeModules, 0o755)
	os.WriteFile(filepath.Join(installRoot, "bun.lock"), []byte("lock"), 0o644)

	p := GoldenParams{CacheRoot: cacheRoot, CloneUrl: testRepoUrl, InstallRoot: installRoot, Pm: "bun"}
	if TryRestoreGolden(p) {
		t.Error("restored while disabled")
	}
	PublishGolden(p)
	if _, err := os.Stat(filepath.Join(cacheRoot, "golden")); err == nil {
		t.Error("published while disabled")
	}
}
