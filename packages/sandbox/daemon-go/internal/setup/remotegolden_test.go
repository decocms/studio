package setup

// Real files, real tar/zstd, no mocks — the whole point of this tier is that a
// tree survives a compress/decompress round trip through a store the daemon does
// not control, and a mocked pipe proves nothing about that.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// requireTools skips rather than fails when the host lacks zstd: the sandbox
// image ships it, a contributor's machine may not, and a red suite there would
// train people to ignore it.
func requireTools(t *testing.T) {
	t.Helper()
	for _, bin := range []string{"tar", "zstd"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not on PATH", bin)
		}
	}
}

// installRootWithTree builds an install root holding a node_modules with enough
// shape to prove the round trip: nested dirs, a file per dir, and one of the
// pod-local caches that must NOT travel.
func installRootWithTree(t *testing.T, pkgs int) string {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "bun.lock"), []byte("lockfile-v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < pkgs; i++ {
		dir := filepath.Join(root, "node_modules", fmt.Sprintf("pkg-%d", i), "dist")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		body := fmt.Sprintf("module.exports = %d;", i)
		if err := os.WriteFile(filepath.Join(dir, "index.js"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	cache := filepath.Join(root, "node_modules", ".vite")
	if err := os.MkdirAll(cache, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, "junk"), []byte("pod-local"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func params(remoteRoot, installRoot string) RemoteGoldenParams {
	return RemoteGoldenParams{
		RemoteRoot:  remoteRoot,
		CloneUrl:    "https://github.com/acme/site.git",
		InstallRoot: installRoot,
		Pm:          "bun",
	}
}

func TestRemoteGoldenArchivePath(t *testing.T) {
	t.Run("keyed by repo, pm and lockfile", func(t *testing.T) {
		got := RemoteGoldenArchivePath("/store", "https://github.com/acme/site.git", "bun", "abc")
		want := filepath.Join("/store", "golden", repoCacheKey("https://github.com/acme/site.git"), "bun-abc.tar.zst")
		if got != want {
			t.Fatalf("got %q want %q", got, want)
		}
	})
	t.Run("credentials do not change the key", func(t *testing.T) {
		bare := RemoteGoldenArchivePath("/store", "https://github.com/acme/site.git", "bun", "abc")
		creds := RemoteGoldenArchivePath("/store", "https://user:tok@github.com/acme/site.git", "bun", "abc")
		if bare != creds {
			t.Fatalf("credential-stripping broken:\n bare  %q\n creds %q", bare, creds)
		}
	})
	t.Run("empty when a component is missing", func(t *testing.T) {
		for _, c := range [][4]string{
			{"", "url", "bun", "hash"},
			{"/store", "", "bun", "hash"},
			{"/store", "url", "bun", ""},
		} {
			if got := RemoteGoldenArchivePath(c[0], c[1], c[2], c[3]); got != "" {
				t.Fatalf("expected empty for %v, got %q", c, got)
			}
		}
	})
	t.Run("two repos never share an archive", func(t *testing.T) {
		a := RemoteGoldenArchivePath("/store", "https://github.com/acme/a.git", "bun", "same")
		b := RemoteGoldenArchivePath("/store", "https://github.com/acme/b.git", "bun", "same")
		if a == b {
			t.Fatal("distinct repos collided on one archive — bun does not re-verify cache content")
		}
	})
}

func TestRemoteEnabled(t *testing.T) {
	t.Setenv(remoteEnabledEnvVar, "")
	if RemoteEnabled() {
		t.Fatal("must be off when unset")
	}
	t.Setenv(remoteEnabledEnvVar, "/golden-cache")
	if !RemoteEnabled() {
		t.Fatal("must be on when set to a path")
	}
}

// The tier's whole purpose: a tree published where one pod ran is restored where
// another one runs, with no node-local state in common.
func TestRemoteGoldenPublishOnOneNodeRestoreOnAnother(t *testing.T) {
	requireTools(t)
	store := t.TempDir()
	t.Setenv(remoteEnabledEnvVar, store)

	nodeA := installRootWithTree(t, 12)
	PublishRemoteGolden(params(store, nodeA))

	// A cold node: same lockfile, no node_modules at all.
	nodeB := t.TempDir()
	if err := os.WriteFile(filepath.Join(nodeB, "bun.lock"), []byte("lockfile-v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !TryRestoreRemoteGolden(params(store, nodeB)) {
		t.Fatal("restore reported no hit on a cold node")
	}

	got, err := os.ReadFile(filepath.Join(nodeB, "node_modules", "pkg-7", "dist", "index.js"))
	if err != nil {
		t.Fatalf("restored tree missing a package: %v", err)
	}
	if string(got) != "module.exports = 7;" {
		t.Fatalf("restored contents wrong: %q", got)
	}
	// Pod-local caches must not travel in a shared archive.
	if _, err := os.Stat(filepath.Join(nodeB, "node_modules", ".vite")); err == nil {
		t.Fatal(".vite travelled in the archive — every consumer pays for pod-local churn")
	}
	// No staging left behind.
	entries, _ := os.ReadDir(nodeB)
	for _, e := range entries {
		if len(e.Name()) > 15 && e.Name()[:15] == ".node_modules.l" {
			t.Fatalf("staging dir survived: %s", e.Name())
		}
	}
}

// A tree big enough that the transfer cannot complete inside one pipe buffer —
// this is the case that caught a truncating implementation in the TypeScript
// version, where a 1 KB fixture passed and a multi-MB one did not.
func TestRemoteGoldenRoundTripsUnderBackpressure(t *testing.T) {
	requireTools(t)
	store := t.TempDir()
	t.Setenv(remoteEnabledEnvVar, store)

	nodeA := installRootWithTree(t, 40)
	// ~8 MB of incompressible payload, well past any pipe buffer.
	big := make([]byte, 8<<20)
	for i := range big {
		big[i] = byte(i * 7)
	}
	if err := os.WriteFile(filepath.Join(nodeA, "node_modules", "pkg-0", "dist", "big.bin"), big, 0o644); err != nil {
		t.Fatal(err)
	}
	PublishRemoteGolden(params(store, nodeA))

	nodeB := t.TempDir()
	if err := os.WriteFile(filepath.Join(nodeB, "bun.lock"), []byte("lockfile-v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !TryRestoreRemoteGolden(params(store, nodeB)) {
		t.Fatal("restore reported no hit")
	}
	back, err := os.ReadFile(filepath.Join(nodeB, "node_modules", "pkg-0", "dist", "big.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if len(back) != len(big) {
		t.Fatalf("payload truncated: got %d bytes want %d", len(back), len(big))
	}
	for i := range back {
		if back[i] != big[i] {
			t.Fatalf("payload corrupted at byte %d", i)
		}
	}
}

// Discriminating counterpart: without this, the tests above would pass even if
// the code ignored its configuration and restored from somewhere else.
func TestRemoteGoldenDormantWhenUnconfigured(t *testing.T) {
	requireTools(t)
	store := t.TempDir()

	t.Setenv(remoteEnabledEnvVar, "")
	nodeA := installRootWithTree(t, 4)
	PublishRemoteGolden(params("", nodeA))
	if entries, _ := os.ReadDir(store); len(entries) != 0 {
		t.Fatal("published with the tier disabled")
	}

	nodeB := t.TempDir()
	if err := os.WriteFile(filepath.Join(nodeB, "bun.lock"), []byte("lockfile-v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if TryRestoreRemoteGolden(params("", nodeB)) {
		t.Fatal("restored with the tier disabled")
	}
	if _, err := os.Stat(filepath.Join(nodeB, "node_modules")); err == nil {
		t.Fatal("created node_modules with the tier disabled")
	}
}

// A truncated archive must fail closed. A partial node_modules that later code
// reads as complete is worse than a miss: the boot skips install and fails
// somewhere unrelated.
func TestRemoteGoldenTruncatedArchiveFailsClosed(t *testing.T) {
	requireTools(t)
	store := t.TempDir()
	t.Setenv(remoteEnabledEnvVar, store)

	nodeA := installRootWithTree(t, 20)
	PublishRemoteGolden(params(store, nodeA))

	archive := RemoteGoldenArchivePath(store, "https://github.com/acme/site.git", "bun",
		LockfileHash(nodeA, "bun"))
	full, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(archive, full[:len(full)/2], 0o644); err != nil {
		t.Fatal(err)
	}

	nodeB := t.TempDir()
	if err := os.WriteFile(filepath.Join(nodeB, "bun.lock"), []byte("lockfile-v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if TryRestoreRemoteGolden(params(store, nodeB)) {
		t.Fatal("reported success on a truncated archive")
	}
	if _, err := os.Stat(filepath.Join(nodeB, "node_modules")); err == nil {
		t.Fatal("left a partial node_modules behind")
	}
	entries, _ := os.ReadDir(nodeB)
	for _, e := range entries {
		if len(e.Name()) > 15 && e.Name()[:15] == ".node_modules.l" {
			t.Fatalf("staging dir survived a failed restore: %s", e.Name())
		}
	}
}

// Publish no-ops once the key exists. It matters because the store has no
// rename: a second publisher rewriting a live key would expose a partial object
// to concurrent readers.
func TestRemoteGoldenPublishIsIdempotent(t *testing.T) {
	requireTools(t)
	store := t.TempDir()
	t.Setenv(remoteEnabledEnvVar, store)

	nodeA := installRootWithTree(t, 6)
	PublishRemoteGolden(params(store, nodeA))
	archive := RemoteGoldenArchivePath(store, "https://github.com/acme/site.git", "bun",
		LockfileHash(nodeA, "bun"))
	first, err := os.Stat(archive)
	if err != nil {
		t.Fatal(err)
	}

	// Change the tree so a rewrite would be observable, then publish again.
	if err := os.WriteFile(filepath.Join(nodeA, "node_modules", "pkg-0", "dist", "index.js"),
		[]byte("module.exports = 'rewritten';"), 0o644); err != nil {
		t.Fatal(err)
	}
	PublishRemoteGolden(params(store, nodeA))

	second, err := os.Stat(archive)
	if err != nil {
		t.Fatal(err)
	}
	if !first.ModTime().Equal(second.ModTime()) || first.Size() != second.Size() {
		t.Fatal("republished over an existing key")
	}
}

// Garbage at the key — not a truncated archive but never-valid bytes — is also a
// miss, not a crash and not a partial tree.
//
// NOTE: this exercises the RESTORE side only. Publish's read-back guard (drop the
// object when `zstd -dc | tar -tf -` rejects what was just written) is not
// covered: publish no-ops on an existing key, so a corrupt object cannot be
// planted ahead of it, and making zstd emit a bad archive on demand would mean
// faking the pipe, which defeats the point of testing against real tools.
func TestRemoteGoldenRestoreRejectsCorruptArchive(t *testing.T) {
	requireTools(t)
	store := t.TempDir()
	t.Setenv(remoteEnabledEnvVar, store)

	nodeB := t.TempDir()
	if err := os.WriteFile(filepath.Join(nodeB, "bun.lock"), []byte("lockfile-v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	archive := RemoteGoldenArchivePath(store, "https://github.com/acme/site.git", "bun",
		LockfileHash(nodeB, "bun"))
	if err := os.MkdirAll(filepath.Dir(archive), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(archive, []byte("not a zstd stream"), 0o644); err != nil {
		t.Fatal(err)
	}

	if TryRestoreRemoteGolden(params(store, nodeB)) {
		t.Fatal("restored from a corrupt archive")
	}
	if _, err := os.Stat(filepath.Join(nodeB, "node_modules")); err == nil {
		t.Fatal("left a node_modules behind after a corrupt archive")
	}
}

func TestPruneRemoteGoldens(t *testing.T) {
	now := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
	write := func(t *testing.T, dir, name string, age time.Duration) string {
		t.Helper()
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		stamp := now.Add(-age)
		if err := os.Chtimes(p, stamp, stamp); err != nil {
			t.Fatal(err)
		}
		return p
	}

	t.Run("absent store is a no-op", func(t *testing.T) {
		pruneRemoteGoldens("", GoldenTTL, GoldenMaxPerRepo, now, nil)
		pruneRemoteGoldens(filepath.Join(t.TempDir(), "absent"), GoldenTTL, GoldenMaxPerRepo, now, nil)
	})

	t.Run("drops archives past the TTL", func(t *testing.T) {
		store := t.TempDir()
		repo := filepath.Join(store, "golden", "repo-a")
		fresh := write(t, repo, "bun-fresh.tar.zst", time.Hour)
		stale := write(t, repo, "bun-stale.tar.zst", 8*24*time.Hour)
		pruneRemoteGoldens(store, GoldenTTL, GoldenMaxPerRepo, now, nil)
		if _, err := os.Stat(fresh); err != nil {
			t.Fatal("pruned an archive inside the TTL")
		}
		if _, err := os.Stat(stale); err == nil {
			t.Fatal("kept an archive past the TTL")
		}
	})

	t.Run("keeps only the newest per repo", func(t *testing.T) {
		store := t.TempDir()
		repo := filepath.Join(store, "golden", "repo-a")
		var paths []string
		for i := 0; i < GoldenMaxPerRepo+3; i++ {
			paths = append(paths, write(t, repo, fmt.Sprintf("bun-%d.tar.zst", i), time.Duration(i)*time.Minute))
		}
		pruneRemoteGoldens(store, GoldenTTL, GoldenMaxPerRepo, now, nil)
		for i, p := range paths {
			_, err := os.Stat(p)
			if i < GoldenMaxPerRepo && err != nil {
				t.Fatalf("pruned archive %d, inside the cap", i)
			}
			if i >= GoldenMaxPerRepo && err == nil {
				t.Fatalf("kept archive %d, past the cap", i)
			}
		}
	})

	t.Run("leaves non-archive entries alone", func(t *testing.T) {
		store := t.TempDir()
		repo := filepath.Join(store, "golden", "repo-a")
		other := write(t, repo, "README", 8*24*time.Hour)
		pruneRemoteGoldens(store, GoldenTTL, GoldenMaxPerRepo, now, nil)
		if _, err := os.Stat(other); err != nil {
			t.Fatal("pruned something that is not an archive")
		}
	})

	t.Run("one repo's cap does not affect another", func(t *testing.T) {
		store := t.TempDir()
		a := filepath.Join(store, "golden", "repo-a")
		b := filepath.Join(store, "golden", "repo-b")
		for i := 0; i < GoldenMaxPerRepo+2; i++ {
			write(t, a, fmt.Sprintf("bun-%d.tar.zst", i), time.Duration(i)*time.Minute)
		}
		only := write(t, b, "bun-only.tar.zst", time.Minute)
		pruneRemoteGoldens(store, GoldenTTL, GoldenMaxPerRepo, now, nil)
		if _, err := os.Stat(only); err != nil {
			t.Fatal("pruned another repo's only archive")
		}
	})
}

// A successful publish prunes, so the store stays bounded wherever it is
// writable without anything having to walk it on a schedule.
func TestRemoteGoldenPublishPrunes(t *testing.T) {
	requireTools(t)
	store := t.TempDir()
	t.Setenv(remoteEnabledEnvVar, store)

	nodeA := installRootWithTree(t, 4)
	repoDir := filepath.Dir(RemoteGoldenArchivePath(store, "https://github.com/acme/site.git", "bun",
		LockfileHash(nodeA, "bun")))
	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(repoDir, "bun-ancient.tar.zst")
	if err := os.WriteFile(stale, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-30 * 24 * time.Hour)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}

	PublishRemoteGolden(params(store, nodeA))

	if _, err := os.Stat(stale); err == nil {
		t.Fatal("publish did not prune a stale archive")
	}
}
