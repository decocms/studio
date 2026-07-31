package setup

// Golden node_modules cache: keep a per-(repo, packageManager, lockfile)
// node_modules under DEPS_CACHE_ROOT and `cp --reflink=always` it into the repo
// to skip install. Best-effort throughout — any failure falls back to a normal
// install. Keyed by credential-stripped cloneUrl, so two repos never share one
// golden.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// GC bounds, applied after each publish. Restore touches a golden's mtime, so
// an actively-used lockfile never ages out.
const (
	GoldenTTL           = 7 * 24 * time.Hour
	GoldenMaxPerRepo    = 5
	goldenTmpPrefix     = ".tmp."
	goldenTmpSuffix     = ".node_modules"
	goldenEnabledEnvVar = "GOLDEN_CACHE_ENABLED"
)

// Pod-local runtime caches that must not travel in a shared golden.
var runtimeCacheDirs = []string{".vite", ".cache"}

// No lockfile → no golden: the tree is not reproducible, so caching it is unsafe.
var goldenLockfiles = map[string][]string{
	"bun":  {"bun.lock", "bun.lockb"},
	"npm":  {"package-lock.json", "npm-shrinkwrap.json"},
	"pnpm": {"pnpm-lock.yaml"},
	"yarn": {"yarn.lock"},
}

// LockfileHash hashes the first present lockfile for pm. Empty when none exists.
func LockfileHash(installRoot, pm string) string {
	for _, name := range goldenLockfiles[pm] {
		buf, err := os.ReadFile(filepath.Join(installRoot, name))
		if err != nil {
			continue
		}
		sum := sha256.Sum256(buf)
		return hex.EncodeToString(sum[:])[:32]
	}
	return ""
}

// GoldenNodeModulesPath is the golden path for a (repo, pm, lockfile) triple, or
// empty when golden cannot apply.
func GoldenNodeModulesPath(cacheRoot, cloneUrl, pm, lockHash string) string {
	if cacheRoot == "" || cloneUrl == "" || lockHash == "" {
		return ""
	}
	return filepath.Join(cacheRoot, "golden", repoCacheKey(cloneUrl),
		pm+"-"+lockHash, "node_modules")
}

// SameFilesystem reports whether both paths share an st_dev. A cheap negative
// filter only — two bind-mounts of one fs can share a dev yet still EXDEV on
// reflink, so the cp exit code stays the authoritative test.
func SameFilesystem(a, b string) bool {
	sa, err := os.Stat(a)
	if err != nil {
		return false
	}
	sb, err := os.Stat(b)
	if err != nil {
		return false
	}
	da, ok := sa.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	db, ok := sb.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	return da.Dev == db.Dev
}

// GoldenEnabled is an independent kill switch: golden touches the install path,
// so it ships dormant and off unless explicitly enabled.
func GoldenEnabled() bool {
	v := os.Getenv(goldenEnabledEnvVar)
	return v == "1" || v == "true"
}

// Swappable only by tests — reflink needs a CoW filesystem, which dev macs and
// ext4 CI lack.
var cloneTree = reflinkClone

// reflinkClone CoW-clones src → dst, returning cp's exit code. `always`, not
// `auto`, so a non-CoW filesystem fails loudly instead of degrading to a full
// copy that would block the boot.
func reflinkClone(src, dst string) int {
	return runCp([]string{"-a", "--reflink=always", src, dst})
}

func runCp(args []string) int {
	if err := exec.Command("cp", args...).Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return exit.ExitCode()
		}
		return 1
	}
	return 0
}

// GoldenParams identifies the golden for one install step.
type GoldenParams struct {
	CacheRoot   string
	CloneUrl    string
	InstallRoot string
	Pm          string
	Log         func(msg string)
}

type goldenPaths struct {
	golden            string
	targetNodeModules string
}

func (p GoldenParams) resolve() (goldenPaths, bool) {
	if !GoldenEnabled() {
		return goldenPaths{}, false
	}
	cacheRoot := p.CacheRoot
	if cacheRoot == "" {
		cacheRoot = os.Getenv("DEPS_CACHE_ROOT")
	}
	golden := GoldenNodeModulesPath(cacheRoot, p.CloneUrl, p.Pm,
		LockfileHash(p.InstallRoot, p.Pm))
	if golden == "" {
		return goldenPaths{}, false
	}
	return goldenPaths{
		golden:            golden,
		targetNodeModules: filepath.Join(p.InstallRoot, "node_modules"),
	}, true
}

func (p GoldenParams) log(msg string) {
	if p.Log != nil {
		p.Log(msg)
	}
}

// TryRestoreGolden reflinks an existing golden into the repo's node_modules,
// skipping install. True only when node_modules is now populated from it.
func TryRestoreGolden(p GoldenParams) bool {
	paths, ok := p.resolve()
	if !ok {
		return false
	}
	if _, err := os.Stat(paths.golden); err != nil {
		return false
	}
	// reflink needs the golden and the destination parent on one filesystem.
	if !SameFilesystem(paths.golden, p.InstallRoot) {
		p.log("[golden] cache and workdir on different filesystems — skipping")
		return false
	}
	// A partial node_modules (interrupted prior boot) would make cp nest the
	// clone inside it; start clean.
	os.RemoveAll(paths.targetNodeModules)
	if code := cloneTree(paths.golden, paths.targetNodeModules); code != 0 {
		p.log(fmt.Sprintf("[golden] restore failed (cp exit %d) — falling back to install", code))
		os.RemoveAll(paths.targetNodeModules)
		return false
	}
	// Mark recently-used so the TTL does not reap an actively-restored lockfile.
	now := time.Now()
	os.Chtimes(paths.golden, now, now)
	p.log("[golden] restored node_modules from cache (skipped install)")
	return true
}

// PublishGolden snapshots a node_modules as the golden for its lockfile. The
// orchestrator defers this to the `running` transition, so a boot that never
// came up healthy never publishes. Reflink to a temp dir then atomic rename, so
// a crash mid-copy leaves no half-written golden.
func PublishGolden(p GoldenParams) {
	paths, ok := p.resolve()
	if !ok {
		return
	}
	if _, err := os.Stat(paths.targetNodeModules); err != nil {
		return
	}
	if _, err := os.Stat(paths.golden); err == nil {
		return // already published for this lockfile
	}
	goldenDir := filepath.Dir(paths.golden)
	if err := os.MkdirAll(goldenDir, 0o755); err != nil {
		p.log("[golden] publish skipped: " + err.Error())
		return
	}
	// Checked after the mkdir, not before: stat on a not-yet-created dir fails.
	if !SameFilesystem(p.InstallRoot, goldenDir) {
		p.log("[golden] cache and workdir on different filesystems — not publishing")
		return
	}
	// Unique temp in the same dir (→ same fs → atomic rename). The pid keeps
	// concurrent publishers on one node from colliding.
	tmp := filepath.Join(goldenDir, fmt.Sprintf("%s%d%s", goldenTmpPrefix, os.Getpid(), goldenTmpSuffix))
	os.RemoveAll(tmp)
	if code := cloneTree(paths.targetNodeModules, tmp); code != 0 {
		os.RemoveAll(tmp)
		p.log(fmt.Sprintf("[golden] publish reflink failed (cp exit %d)", code))
		return
	}
	// Cheap — reflink is CoW, so these were near-free to clone and to drop.
	for _, d := range runtimeCacheDirs {
		os.RemoveAll(filepath.Join(tmp, d))
	}
	if err := os.Rename(tmp, paths.golden); err != nil {
		// Lost the race (another publisher renamed first) — fine; drop our temp.
		os.RemoveAll(tmp)
		return
	}
	p.log("[golden] published node_modules to cache")
}

// PruneGoldens bounds golden-store growth with the shipped defaults. Safe to
// race a restore: a reflink from a deleted golden just fails into an install.
func PruneGoldens(cacheRoot string) {
	if cacheRoot == "" {
		cacheRoot = os.Getenv("DEPS_CACHE_ROOT")
		if cacheRoot == "" {
			return
		}
	}
	pruneGoldens(cacheRoot, GoldenTTL, GoldenMaxPerRepo, time.Now())
}

// pruneGoldens drops goldens older than ttl, then keeps the newest maxPerRepo.
func pruneGoldens(cacheRoot string, ttl time.Duration, maxPerRepo int, now time.Time) {
	root := filepath.Join(cacheRoot, "golden")
	repos, err := os.ReadDir(root)
	if err != nil {
		return // no golden store yet
	}
	for _, repo := range repos {
		repoDir := filepath.Join(root, repo.Name())
		names, err := os.ReadDir(repoDir)
		if err != nil {
			continue
		}
		type entry struct {
			path  string
			mtime time.Time
		}
		var entries []entry
		for _, name := range names {
			if strings.HasPrefix(name.Name(), goldenTmpPrefix) {
				continue // in-flight publish
			}
			info, err := name.Info()
			if err != nil {
				continue
			}
			entries = append(entries, entry{filepath.Join(repoDir, name.Name()), info.ModTime()})
		}
		// Newest first; anything past the cap or older than the TTL is pruned.
		sort.Slice(entries, func(i, j int) bool { return entries[i].mtime.After(entries[j].mtime) })
		for i, e := range entries {
			if i >= maxPerRepo || now.Sub(e.mtime) > ttl {
				os.RemoveAll(e.path)
			}
		}
	}
}
