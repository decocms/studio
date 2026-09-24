package setup

// Gradle's caches for the Android image, carried across nodes the same way the
// node_modules goldens are: the tenant writes only its node's store, and the
// uploader DaemonSet forwards it to the shared one.
//
// Different from a node_modules golden in one way that shapes everything here:
// a Gradle cache is not an immutable tree for one lockfile, it is a directory
// every build on the node adds to. So there is no content key. The node-local
// dir is per repository, the shared archives are per (org, repo, ISO week) and
// named for the build cache they carry, and a restore takes the newest week's
// largest — a stale cache is still a cache, and Gradle downloads only what it
// lacks.
//
// Only the relocatable parts travel: the dependency cache, the build cache and
// the wrapper distributions. Transforms and the per-version dirs are rebuilt.

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// androidGradleArchived is what an archive carries, relative to the repo's
// node-local gradle dir. A missing one is skipped, not an error.
var androidGradleArchived = []string{"caches/modules-2", "caches/build-cache-1", "wrapper/dists"}

// androidGradleRestoring is created in the Gradle home while a restore runs, so
// `qa-android start` waits for the links instead of racing them with its own.
const androidGradleRestoring = ".studio-cache-restoring"

// A week's first archive can come from an early or partial build, with deps but
// barely any compiled outputs. A node whose build cache has since at least
// doubled, and by this much, publishes a new one beside it.
const androidGradleRepublishMin = 64 << 20

func androidGradleDir(cacheRoot, cloneUrl string) string {
	return filepath.Join(cacheRoot, "android", "gradle", repoCacheKey(cloneUrl))
}

func androidGradleRemoteDir(remoteRoot, orgId, cloneUrl string) string {
	if remoteRoot == "" || orgId == "" || cloneUrl == "" {
		return ""
	}
	return filepath.Join(remoteRoot, "android-gradle", orgId, repoCacheKey(cloneUrl))
}

func isoWeek(t time.Time) string {
	y, w := t.ISOWeek()
	return fmt.Sprintf("%04d-W%02d", y, w)
}

// AndroidGradleParams is one sandbox's view of the cache.
type AndroidGradleParams struct {
	CacheRoot  string // DEPS_CACHE_ROOT
	RemoteRoot string // GOLDEN_CACHE_REMOTE, read-only here
	GradleHome string // the sandbox user's ~/.gradle
	OrgId      string
	CloneUrl   string
	Env        string
	Log        func(msg string)
}

func (p AndroidGradleParams) log(msg string) {
	if p.Log != nil {
		p.Log(msg)
	}
}

// PrepareAndroidGradle points the sandbox's Gradle home at this repo's
// node-local cache, seeding that cache from the shared store when the node has
// never built the repo. Best-effort throughout: without it the first build is
// just cold.
func PrepareAndroidGradle(p AndroidGradleParams) {
	if p.CacheRoot == "" || p.CloneUrl == "" || p.GradleHome == "" {
		return
	}
	if err := os.MkdirAll(p.GradleHome, 0o755); err != nil {
		return
	}
	marker := filepath.Join(p.GradleHome, androidGradleRestoring)
	os.WriteFile(marker, nil, 0o644)
	defer os.Remove(marker)

	dir := androidGradleDir(p.CacheRoot, p.CloneUrl)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	// The meta sits at <dir>/.golden-meta.json; WriteGoldenMeta takes a child
	// of the directory it describes.
	WriteGoldenMeta(filepath.Join(dir, "caches"), GoldenMeta{
		OrgId: p.OrgId, CloneUrl: p.CloneUrl, Pm: "gradle", Env: p.Env,
	})
	if !fileExists(filepath.Join(dir, "caches")) {
		p.restoreFromRemote(dir)
	}
	for _, d := range []string{"caches", "wrapper"} {
		os.MkdirAll(filepath.Join(dir, d), 0o755)
		link := filepath.Join(p.GradleHome, d)
		if _, err := os.Lstat(link); err == nil {
			continue // a build already made its own; never swap one under it
		}
		os.Symlink(filepath.Join(dir, d), link)
	}
}

// restoreFromRemote extracts the newest archive beside dir and moves its parts
// into place only once complete, so a concurrent build never reads a
// half-written cache.
func (p AndroidGradleParams) restoreFromRemote(dir string) {
	if !RemoteEnabled() {
		return
	}
	root := p.RemoteRoot
	if root == "" {
		root = os.Getenv(remoteEnabledEnvVar)
	}
	archive := latestArchive(androidGradleRemoteDir(root, p.OrgId, p.CloneUrl))
	if archive == "" {
		return
	}
	tmp, err := os.MkdirTemp(dir, ".restore-")
	if err != nil {
		return
	}
	defer os.RemoveAll(tmp)
	started := time.Now()
	if r := runPiped(exec.Command("zstd", "-dc", archive), exec.Command("tar", "-xf", "-", "-C", tmp)); r.code != 0 {
		p.log(fmt.Sprintf("[android-gradle] restore of %s failed (exit %d: %s)", archive, r.code, r.stderr))
		return
	}
	for _, rel := range androidGradleArchived {
		src := filepath.Join(tmp, rel)
		dst := filepath.Join(dir, rel)
		if !fileExists(src) || fileExists(dst) {
			continue
		}
		os.MkdirAll(filepath.Dir(dst), 0o755)
		os.Rename(src, dst)
	}
	p.log(fmt.Sprintf("[android-gradle] restored %s in %s", archive, time.Since(started).Truncate(time.Millisecond)))
}

func latestArchive(dir string) string {
	if dir == "" {
		return ""
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), remoteArchiveSuffix) {
			names = append(names, e.Name())
		}
	}
	if len(names) == 0 {
		return ""
	}
	// `<week>_<build-cache bytes, zero-padded>`: newest week first, then the
	// biggest build cache. A pre-size `<week>` name sorts below its week's others.
	sort.Strings(names)
	return filepath.Join(dir, names[len(names)-1])
}

// uploadAndroidGradle forwards each repo's node-local Gradle cache as this
// week's archive, when there is none yet or the node's build cache has outgrown
// the week's largest. Called from UploadNodeGoldens, so it
// shares its stats, its environment filter and its read-back discipline.
func uploadAndroidGradle(opts UploaderOpts, now time.Time, stats *UploaderStats) {
	root := filepath.Join(opts.CacheRoot, "android", "gradle")
	repos, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, repo := range repos {
		if !repo.IsDir() {
			continue
		}
		dir := filepath.Join(root, repo.Name())
		var parts []string
		for _, rel := range androidGradleArchived {
			if fileExists(filepath.Join(dir, rel)) {
				parts = append(parts, rel)
			}
		}
		if !fileExists(filepath.Join(dir, "caches", "modules-2")) {
			continue // never built here; nothing worth shipping
		}
		stats.Scanned++
		meta, ok := ReadGoldenMeta(filepath.Join(dir, "caches"))
		if !ok {
			stats.NoMeta++
			continue
		}
		if opts.Env != "" && meta.Env != opts.Env {
			stats.OtherEnv++
			continue
		}
		remote := androidGradleRemoteDir(opts.RemoteRoot, meta.OrgId, meta.CloneUrl)
		if remote == "" {
			stats.NoMeta++
			continue
		}
		week := isoWeek(now)
		local := dirSize(filepath.Join(dir, "caches", "build-cache-1"))
		if published, ok := weekBuildCache(remote, week); ok &&
			(local < 2*published || local-published < androidGradleRepublishMin) {
			stats.Skipped++
			continue
		}
		archive := filepath.Join(remote, fmt.Sprintf("%s_%012d%s", week, local, remoteArchiveSuffix))
		if uploadTree(dir, parts, []string{"*.lock", "gc.properties"}, archive, opts) {
			stats.Uploaded++
		} else {
			stats.Failed++
		}
	}
}

// weekBuildCache is the largest build cache among week's archives in remote, and
// whether there is any archive for that week.
func weekBuildCache(remote, week string) (int64, bool) {
	entries, _ := os.ReadDir(remote)
	var largest int64
	found := false
	for _, e := range entries {
		name, isArchive := strings.CutSuffix(e.Name(), remoteArchiveSuffix)
		if !isArchive || (name != week && !strings.HasPrefix(name, week+"_")) {
			continue
		}
		found = true
		// The pre-size `<week>` name fails to parse and counts as 0.
		if n, err := strconv.ParseInt(strings.TrimPrefix(name, week+"_"), 10, 64); err == nil {
			largest = max(largest, n)
		}
	}
	return largest, found
}

func dirSize(dir string) int64 {
	var n int64
	filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if info, err := d.Info(); err == nil {
				n += info.Size()
			}
		}
		return nil
	})
	return n
}

// uploadTree compresses parts (relative to dir) straight to its shared key.
//
// Written to the final key rather than a temp name plus rename: the shared store
// is a blob store, which has no rename and does not need one — an object becomes
// visible only when its upload completes, so a killed uploader leaves no
// readable object. Then read back, because a corrupt object would be permanent:
// every later sweep would skip it as "already present" and every node would keep
// missing with nothing to repair it.
func uploadTree(dir string, parts, excludes []string, archive string, opts UploaderOpts) bool {
	// Best-effort: on a blob store creating the prefix is a no-op, and writing
	// the key is what creates it.
	os.MkdirAll(filepath.Dir(archive), 0o755)
	tarArgs := []string{"-cf", "-", "-C", dir}
	for _, e := range excludes {
		tarArgs = append(tarArgs, "--exclude="+e)
	}
	tarArgs = append(tarArgs, parts...)
	zstdArgs := append(append([]string{}, zstdPublishArgs...), "-q", "-o", archive)
	if r := runPiped(exec.Command("tar", tarArgs...), exec.Command("zstd", zstdArgs...)); r.code != 0 {
		opts.log(fmt.Sprintf("[golden-uploader] compress failed for %s (exit %d: %s)", archive, r.code, r.stderr))
		os.Remove(archive)
		return false
	}
	if check := runPiped(exec.Command("zstd", "-dc", archive), exec.Command("tar", "-tf", "-")); check.code != 0 {
		opts.log(fmt.Sprintf("[golden-uploader] discarded %s — failed read-back (%s)", archive, check.stderr))
		os.Remove(archive)
		return false
	}
	opts.log("[golden-uploader] published " + archive)
	return true
}
