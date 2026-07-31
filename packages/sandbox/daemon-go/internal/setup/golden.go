package setup

// Golden node_modules cache — the reflink "last mile" on top of the per-repo
// download cache (see DepsCacheEnv in install.go).
//
// A fresh pod has an empty node_modules and pays a full install (download +
// materialize). This keeps a per-(repo, packageManager, lockfile) "golden"
// node_modules on the node-local hostPath (DEPS_CACHE_ROOT). On a hit we
// `cp --reflink=always` it into the repo — a CoW clone that is near-instant
// regardless of tree size (~1s for 700MB on prod xfs) and skips install
// entirely. On a miss the normal install runs and its result is published as
// the golden for next time.
//
// Isolation mirrors DepsCacheEnv's per-repo key, which is the only cross-repo
// boundary (the package manager does not re-verify cache content): a golden is
// keyed by the credential-stripped cloneUrl, so two repos can never resolve to
// one golden. Within a repo, sharing is the same trust domain (sandbox access
// implies repo write). reflink is copy-on-write, so a pod mutating its own
// node_modules never writes through to the shared golden.
//
// Only applies when the golden dir and the repo's node_modules are on the same
// filesystem — reflink requires it. Best-effort throughout: any failure falls
// back to a normal install and never blocks the boot.

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

// GC bounds for the golden store (a golden ≈ a full node_modules on the node
// hostPath, so unbounded growth fills the disk). Pruned opportunistically after
// each publish: drop goldens untouched for longer than the TTL, then cap how
// many are kept per repo (newest by mtime win). Restore touches a golden's
// mtime, so an actively-used lockfile never ages out.
const (
	GoldenTTL           = 7 * 24 * time.Hour
	GoldenMaxPerRepo    = 5
	goldenTmpPrefix     = ".tmp."
	goldenTmpSuffix     = ".node_modules"
	goldenEnabledEnvVar = "GOLDEN_CACHE_ENABLED"
)

// Pod-local runtime caches that must not travel in a shared golden.
var runtimeCacheDirs = []string{".vite", ".cache"}

// Lockfiles that fully pin a package manager's resolution, so an identical
// lockfile yields an identical node_modules. No lockfile → no golden: the tree
// is not guaranteed reproducible, so caching it is unsafe.
var goldenLockfiles = map[string][]string{
	"bun":  {"bun.lock", "bun.lockb"},
	"npm":  {"package-lock.json", "npm-shrinkwrap.json"},
	"pnpm": {"pnpm-lock.yaml"},
	"yarn": {"yarn.lock"},
}

// LockfileHash is the content hash of the first present lockfile for pm under
// installRoot. Empty when no lockfile exists (→ golden disabled for this
// install).
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

// GoldenNodeModulesPath is the absolute golden path for a (repo, pm, lockfile)
// triple, or empty when golden cannot apply: no cache root, no cloneUrl, or no
// lockfile. Pure given lockHash — the fs read lives in LockfileHash.
func GoldenNodeModulesPath(cacheRoot, cloneUrl, pm, lockHash string) string {
	if cacheRoot == "" || cloneUrl == "" || lockHash == "" {
		return ""
	}
	return filepath.Join(cacheRoot, "golden", repoCacheKey(cloneUrl),
		pm+"-"+lockHash, "node_modules")
}

// SameFilesystem reports whether both paths share an st_dev — a cheap NEGATIVE
// filter for reflink (different dev ⇒ reflink cannot work, so skip the doomed
// cp). It is NOT sufficient: two bind-mounts of one underlying fs can share a
// dev number yet still EXDEV on reflink (observed on kind: /deps-cache hostPath
// and /app emptyDir both dev fe01, `cp --reflink=always` fails). The cp exit
// code is the authoritative test; callers must handle its failure regardless.
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

// GoldenEnabled is an independent kill switch. Golden touches the boot's
// install path, so it stays OFF unless explicitly enabled — separate from the
// deps cache (which only partitions the download cache). Ships dormant; unset
// it to disable without redeploying the image.
func GoldenEnabled() bool {
	v := os.Getenv(goldenEnabledEnvVar)
	return v == "1" || v == "true"
}

// The tree cloner, swappable only by tests: prod always reflinks, but reflink
// needs a CoW filesystem (xfs/btrfs in prod), which neither a dev mac's GNU-less
// cp nor ext4 CI provides — so without this seam the publish/restore/isolation
// tests would skip everywhere and prove nothing.
var cloneTree = reflinkClone

// reflinkClone CoW-clones src → dst via coreutils cp, returning its exit code.
// --reflink=always (not auto) so a filesystem without reflink support fails
// loudly instead of silently degrading to a full copy that would block the
// boot; the caller falls back to a normal install. -a preserves the tree. argv,
// never a shell, so paths are not reinterpreted.
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

// PublishGolden snapshots a node_modules as the golden for its lockfile.
// Publish only ever runs for a boot whose dev server came up healthy (the
// orchestrator defers it to the `running` transition), so a broken install
// never becomes a golden that every later boot then reuses.
//
// Best-effort and idempotent: no-op if a golden already exists; reflink to a
// temp dir, strip the pod-local runtime caches, then atomically rename, so a
// concurrent publisher or a crash mid-copy never leaves a half-written golden
// in place.
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

// PruneGoldens bounds golden-store growth on the node with the shipped
// defaults. Opportunistic (called after a publish) and best-effort. Safe to
// race a concurrent restore: an in-flight reflink from a golden we delete just
// fails → that pod falls back to install, and completed CoW clones are
// independent of the source.
func PruneGoldens(cacheRoot string) {
	if cacheRoot == "" {
		cacheRoot = os.Getenv("DEPS_CACHE_ROOT")
		if cacheRoot == "" {
			return
		}
	}
	pruneGoldens(cacheRoot, GoldenTTL, GoldenMaxPerRepo, time.Now())
}

// pruneGoldens is the parameterized core: per repo, drop goldens whose mtime is
// older than ttl, then keep only the newest maxPerRepo. Split out so the bounds
// are testable — maxPerRepo=0 ("keep none") is a meaningful value, which a
// zero-value-defaulting options struct could not express.
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
