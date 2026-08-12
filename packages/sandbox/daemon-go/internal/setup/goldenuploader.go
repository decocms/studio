package setup

// The node-local → shared bridge for the golden cache.
//
// WHY THIS IS NOT IN THE SANDBOX POD. Publishing to a store shared across nodes
// needs write access to it, and a sandbox pod runs untrusted code: a package
// manager installs cached content as-is, so a tenant able to write the shared
// store could poison another node's boot. The tenant's write path therefore
// stops at its own node's L1 (a hostPath it already owns, and already the
// accepted trust domain there), and this walker — running as node-level
// infrastructure with the writable mount — carries goldens the rest of the way.
//
// It decides nothing about WHAT to cache. Sandboxes are multi-tenant and run
// third-party code, so the set of (repo, lockfile) pairs is not knowable ahead
// of time: no list to maintain, no image to pre-bake, no prediction. The walker
// only forwards what a real boot already produced and the daemon already judged
// healthy enough to publish node-locally.
//
// Idempotent and cheap to run often: an object that already exists is a HEAD and
// a skip. The compression is the expensive part, and it happens at most once per
// (org, repo, lockfile) across the whole fleet.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/telemetry"
)

// UploaderOpts configures one sweep of the node-local store.
type UploaderOpts struct {
	// CacheRoot is the node-local golden store (DEPS_CACHE_ROOT).
	CacheRoot string
	// RemoteRoot is the shared store's mount point, writable here.
	RemoteRoot string
	// Env is this uploader's environment (sandbox-env's envName). The node-local
	// store is per NODE and prod and stg sandboxes share one NodePool, so a
	// node's goldens are a mix — forwarding a neighbour's would compress and ship
	// a tree that environment will never read, because its own mount is scoped to
	// a different key prefix. Empty forwards everything, which is only correct
	// where a single environment owns the nodes.
	Env string
	Log func(msg string)
}

// UploaderStats is what one sweep did, for a log line and for tests.
type UploaderStats struct {
	Scanned  int
	Uploaded int
	// Skipped is goldens already present in the shared store — the steady state.
	Skipped int
	// NoMeta is goldens with no readable org. Deliberately not an error: a golden
	// written before the org was threaded through, or by a boot Studio gave no
	// org for, simply stays node-local. Counted because a permanently non-zero
	// value means the org is not arriving and the tier is quietly doing nothing.
	NoMeta int
	// OtherEnv is goldens another environment produced on this shared node.
	// Counted apart from NoMeta because it is the steady state, not a problem:
	// prod and stg both run here.
	OtherEnv int
	Failed   int
}

func (o UploaderOpts) log(msg string) {
	if o.Log != nil {
		o.Log(msg)
	}
}

// UploadNodeGoldens sweeps the node-local store once and publishes every golden
// that has provenance and is not in the shared store yet.
//
// Best-effort per golden: one failure does not stop the sweep. Nothing here
// deletes from either store — pruning the node-local side belongs to the daemon
// that owns it, and the shared side is bounded by the object store's own
// lifecycle policy.
func UploadNodeGoldens(opts UploaderOpts) UploaderStats {
	var stats UploaderStats
	if opts.CacheRoot == "" || opts.RemoteRoot == "" {
		return stats
	}
	root := filepath.Join(opts.CacheRoot, "golden")
	repos, err := os.ReadDir(root)
	if err != nil {
		return stats // nothing published on this node yet
	}
	for _, repo := range repos {
		if !repo.IsDir() {
			continue
		}
		repoDir := filepath.Join(root, repo.Name())
		lockDirs, err := os.ReadDir(repoDir)
		if err != nil {
			continue
		}
		for _, lockDir := range lockDirs {
			if !lockDir.IsDir() {
				continue
			}
			// The node-local layout is golden/<repoHash>/<pm>-<lockHash>/node_modules.
			goldenNodeModules := filepath.Join(repoDir, lockDir.Name(), "node_modules")
			if _, err := os.Stat(goldenNodeModules); err != nil {
				continue // an in-flight publish, or a pruned leftover
			}
			stats.Scanned++

			meta, ok := ReadGoldenMeta(goldenNodeModules)
			if !ok {
				stats.NoMeta++
				continue
			}
			// Another environment's tree on a shared node. Skipped before the
			// expensive part: its archive would land under this environment's key
			// prefix, where its own sandboxes never look.
			if opts.Env != "" && meta.Env != opts.Env {
				stats.OtherEnv++
				continue
			}
			pm, lockHash, ok := splitGoldenLockDir(lockDir.Name())
			if !ok {
				stats.NoMeta++
				continue
			}
			archive := RemoteGoldenArchivePath(opts.RemoteRoot, meta.OrgId, meta.CloneUrl, pm, lockHash)
			if archive == "" {
				stats.NoMeta++
				continue
			}
			if fileExists(archive) {
				stats.Skipped++
				continue
			}
			if uploadGolden(goldenNodeModules, archive, opts) {
				stats.Uploaded++
			} else {
				stats.Failed++
			}
		}
	}
	return stats
}

// splitGoldenLockDir splits a `<pm>-<lockHash>` directory name. The lock hash is
// hex and never contains `-`, so the FIRST separator is the boundary — a package
// manager name never contains one either, but splitting from the left keeps this
// correct if one ever does.
func splitGoldenLockDir(name string) (pm, lockHash string, ok bool) {
	for i := 0; i < len(name); i++ {
		if name[i] != '-' {
			continue
		}
		// Both halves or neither: a caller that ignored ok must not be handed a
		// half-parsed key it would then use to build an archive path.
		if name[:i] == "" || name[i+1:] == "" {
			return "", "", false
		}
		return name[:i], name[i+1:], true
	}
	return "", "", false
}

// uploadGolden compresses one node-local golden straight into its shared key.
//
// Written to the final key rather than a temp name plus rename: the shared store
// is a blob store, which has no rename and does not need one — an object becomes
// visible only when its upload completes, so a killed uploader leaves no
// readable object. Then read back, because a corrupt object would be permanent:
// every later sweep would skip it as "already present" and every node would keep
// missing with nothing to repair it.
func uploadGolden(goldenNodeModules, archive string, opts UploaderOpts) bool {
	// Best-effort: on a blob store creating the prefix is a no-op, and writing
	// the key is what creates it.
	os.MkdirAll(filepath.Dir(archive), 0o755)

	installRoot := filepath.Dir(goldenNodeModules)
	tarArgs := []string{"-cf", "-", "-C", installRoot}
	for _, d := range runtimeCacheDirs {
		tarArgs = append(tarArgs, "--exclude=node_modules/"+d)
	}
	tarArgs = append(tarArgs, "node_modules")

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

// RunUploader sweeps on an interval until ctx-like cancellation via stop.
// Sequential by construction: compression is CPU-bound and this shares a node
// with tenant sandboxes, so overlapping sweeps would compete with the very boots
// the cache exists to speed up. A sweep that runs long simply delays the next.
func RunUploader(opts UploaderOpts, interval time.Duration, stop <-chan struct{}) {
	sweep := func() {
		started := time.Now()
		s := UploadNodeGoldens(opts)
		elapsed := time.Since(started)
		// Unconditional, unlike the log line below: the log is for a human reading
		// one node, the metric is for asking whether the tier is alive across the
		// fleet, and "every node reported zero uploads" is exactly the answer that
		// question needs. Cheap because it is one datapoint per node per interval.
		telemetry.RecordGoldenSweep(context.Background(), elapsed.Milliseconds(), map[string]int{
			"uploaded":      s.Uploaded,
			"present":       s.Skipped,
			"no-provenance": s.NoMeta,
			"other-env":     s.OtherEnv,
			"failed":        s.Failed,
		})
		// Silent when there was nothing to do: this runs on every node, forever,
		// and a heartbeat per node per interval is noise that buries the lines
		// that matter.
		if s.Uploaded > 0 || s.Failed > 0 || s.NoMeta > 0 {
			opts.log(fmt.Sprintf(
				"[golden-uploader] swept %d golden(s) in %s: %d uploaded, %d already present, "+
					"%d without provenance, %d from another env, %d failed",
				s.Scanned, elapsed.Truncate(time.Millisecond),
				s.Uploaded, s.Skipped, s.NoMeta, s.OtherEnv, s.Failed))
		}
	}
	sweep()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			sweep()
		}
	}
}
