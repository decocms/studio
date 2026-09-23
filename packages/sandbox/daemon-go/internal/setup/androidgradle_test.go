package setup

// Real files, real tar/zstd, like the node_modules uploader tests: the round
// trip IS the contract.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const gradleCloneUrl = "https://x-access-token:ghs_secret@github.com/acme/app.git"

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// nodeLocalGradle is what a pod leaves behind after a build on this node.
func nodeLocalGradle(t *testing.T, cacheRoot, orgId, env string) string {
	t.Helper()
	dir := androidGradleDir(cacheRoot, gradleCloneUrl)
	writeFile(t, filepath.Join(dir, "caches", "modules-2", "files-2.1", "com.acme", "lib.jar"), "jar")
	writeFile(t, filepath.Join(dir, "caches", "modules-2", "modules-2.lock"), "lock")
	writeFile(t, filepath.Join(dir, "caches", "transforms-4", "big"), "not shipped")
	writeFile(t, filepath.Join(dir, "wrapper", "dists", "gradle-8.12-all", "gradle.zip"), "dist")
	WriteGoldenMeta(filepath.Join(dir, "caches"), GoldenMeta{OrgId: orgId, CloneUrl: gradleCloneUrl, Pm: "gradle", Env: env})
	return dir
}

func archiveMembers(t *testing.T, archive string) string {
	t.Helper()
	out, err := exec.Command("sh", "-c", "zstd -dc '"+archive+"' | tar -tf -").Output()
	if err != nil {
		t.Fatalf("list %s: %v", archive, err)
	}
	return string(out)
}

func TestUploadAndroidGradle(t *testing.T) {
	now := time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)

	t.Run("publishes this week's archive of the relocatable parts", func(t *testing.T) {
		cache, remote := t.TempDir(), t.TempDir()
		nodeLocalGradle(t, cache, "org_a", "prod")
		var stats UploaderStats
		uploadAndroidGradle(UploaderOpts{CacheRoot: cache, RemoteRoot: remote, Env: "prod"}, now, &stats)
		if stats.Uploaded != 1 {
			t.Fatalf("stats = %+v", stats)
		}
		archive := filepath.Join(remote, "android-gradle", "org_a", repoCacheKey(gradleCloneUrl), "2026-W39.tar.zst")
		members := archiveMembers(t, archive)
		for _, want := range []string{"caches/modules-2/files-2.1/com.acme/lib.jar", "wrapper/dists/gradle-8.12-all/gradle.zip"} {
			if !strings.Contains(members, want) {
				t.Errorf("archive lacks %s:\n%s", want, members)
			}
		}
		for _, unwanted := range []string{".lock", "transforms-4"} {
			if strings.Contains(members, unwanted) {
				t.Errorf("archive carries %s:\n%s", unwanted, members)
			}
		}

		// Same week again: one HEAD and a skip.
		stats = UploaderStats{}
		uploadAndroidGradle(UploaderOpts{CacheRoot: cache, RemoteRoot: remote, Env: "prod"}, now, &stats)
		if stats.Skipped != 1 || stats.Uploaded != 0 {
			t.Fatalf("re-sweep stats = %+v", stats)
		}
	})

	t.Run("never publishes without an owner or for another env", func(t *testing.T) {
		for _, c := range []struct{ org, env, want string }{{"", "prod", "noMeta"}, {"org_a", "stg", "otherEnv"}} {
			cache, remote := t.TempDir(), t.TempDir()
			nodeLocalGradle(t, cache, c.org, c.env)
			var stats UploaderStats
			uploadAndroidGradle(UploaderOpts{CacheRoot: cache, RemoteRoot: remote, Env: "prod"}, now, &stats)
			if stats.Uploaded != 0 || (c.want == "noMeta" && stats.NoMeta != 1) || (c.want == "otherEnv" && stats.OtherEnv != 1) {
				t.Fatalf("%s: stats = %+v", c.want, stats)
			}
			if entries, _ := os.ReadDir(remote); len(entries) != 0 {
				t.Fatalf("%s: wrote to the shared store", c.want)
			}
		}
	})

	t.Run("a repo never built here is not scanned", func(t *testing.T) {
		cache := t.TempDir()
		os.MkdirAll(androidGradleDir(cache, gradleCloneUrl), 0o755)
		var stats UploaderStats
		uploadAndroidGradle(UploaderOpts{CacheRoot: cache, RemoteRoot: t.TempDir()}, now, &stats)
		if stats != (UploaderStats{}) {
			t.Fatalf("stats = %+v", stats)
		}
	})
}

func TestPrepareAndroidGradle(t *testing.T) {
	// Publish from one "node", restore on another.
	seed := func(t *testing.T, remote string, weeks ...time.Time) {
		cache := t.TempDir()
		dir := nodeLocalGradle(t, cache, "org_a", "prod")
		for _, w := range weeks {
			writeFile(t, filepath.Join(dir, "caches", "modules-2", "week"), isoWeek(w))
			uploadAndroidGradle(UploaderOpts{CacheRoot: cache, RemoteRoot: remote, Env: "prod"}, w, &UploaderStats{})
		}
	}
	params := func(cache, remote, home string) AndroidGradleParams {
		return AndroidGradleParams{CacheRoot: cache, RemoteRoot: remote, GradleHome: home,
			OrgId: "org_a", CloneUrl: gradleCloneUrl, Env: "prod"}
	}

	t.Run("a cold node restores the newest week and links the Gradle home", func(t *testing.T) {
		remote := t.TempDir()
		seed(t, remote, time.Date(2026, 9, 9, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 23, 0, 0, 0, 0, time.UTC))
		t.Setenv(remoteEnabledEnvVar, remote)
		cache, home := t.TempDir(), filepath.Join(t.TempDir(), ".gradle")
		PrepareAndroidGradle(params(cache, remote, home))

		week, err := os.ReadFile(filepath.Join(home, "caches", "modules-2", "week"))
		if err != nil || string(week) != "2026-W39" {
			t.Fatalf("restored week = %q, %v", week, err)
		}
		if _, err := os.Stat(filepath.Join(home, "wrapper", "dists", "gradle-8.12-all", "gradle.zip")); err != nil {
			t.Fatalf("wrapper not restored: %v", err)
		}
		if target, _ := os.Readlink(filepath.Join(home, "caches")); target != filepath.Join(androidGradleDir(cache, gradleCloneUrl), "caches") {
			t.Fatalf("caches link = %q", target)
		}
		if _, err := os.Stat(filepath.Join(home, androidGradleRestoring)); err == nil {
			t.Fatal("left the restoring marker behind")
		}
		meta, ok := ReadGoldenMeta(filepath.Join(androidGradleDir(cache, gradleCloneUrl), "caches"))
		if !ok || meta.OrgId != "org_a" || strings.Contains(meta.CloneUrl, "ghs_secret") {
			t.Fatalf("meta = %+v, %v", meta, ok)
		}
	})

	t.Run("another org's archive is never restored", func(t *testing.T) {
		remote := t.TempDir()
		seed(t, remote, time.Date(2026, 9, 23, 0, 0, 0, 0, time.UTC))
		t.Setenv(remoteEnabledEnvVar, remote)
		cache, home := t.TempDir(), filepath.Join(t.TempDir(), ".gradle")
		p := params(cache, remote, home)
		p.OrgId = "org_b"
		PrepareAndroidGradle(p)
		if _, err := os.Stat(filepath.Join(home, "caches", "modules-2")); err == nil {
			t.Fatal("restored org_a's cache into org_b's sandbox")
		}
	})

	t.Run("a warm node keeps its own cache", func(t *testing.T) {
		remote := t.TempDir()
		seed(t, remote, time.Date(2026, 9, 23, 0, 0, 0, 0, time.UTC))
		t.Setenv(remoteEnabledEnvVar, remote)
		cache, home := t.TempDir(), filepath.Join(t.TempDir(), ".gradle")
		writeFile(t, filepath.Join(androidGradleDir(cache, gradleCloneUrl), "caches", "modules-2", "week"), "local")
		PrepareAndroidGradle(params(cache, remote, home))
		if week, _ := os.ReadFile(filepath.Join(home, "caches", "modules-2", "week")); string(week) != "local" {
			t.Fatalf("overwrote the node's cache with %q", week)
		}
	})

	t.Run("never swaps a Gradle home a build already made", func(t *testing.T) {
		cache, home := t.TempDir(), filepath.Join(t.TempDir(), ".gradle")
		writeFile(t, filepath.Join(home, "caches", "mine"), "x")
		PrepareAndroidGradle(params(cache, "", home))
		if fi, err := os.Lstat(filepath.Join(home, "caches")); err != nil || fi.Mode()&os.ModeSymlink != 0 {
			t.Fatal("replaced an existing caches dir with a link")
		}
	})
}
