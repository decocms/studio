package orgfs

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

// Prefetching skills onto the pod's own disk instead of symlinking them into the
// org-fs mount. The mount is a network filesystem reached over WebDAV+rclone,
// two round trips per file (a presign against the studio, then the object
// itself), and Claude Code reads EVERY skill it can see during startup, on the
// thread pool that then owes the run its `init`. In prod that scan is ~136
// SKILL.md files / ~1.3MB per pod — trivial bandwidth, a few hundred serialized
// round trips of latency, and an unbounded hang whenever the backend is wedged.
//
// Copying moves all of that off the harness's critical path: the daemon pays it
// once, in parallel, before the run starts, and every read the harness then does
// is local disk. It also retires the failure mode the read gate exists to
// contain — a wedged mount cannot hang a scan that never touches the mount.
//
// Only READ-ONLY sets are copied (public sets and repo-sync volumes). The org's
// home skills stay a live mount: a skill the agent authors there has to sync
// back, which is the whole point of that link.

// Ceiling on what the prefetch may write to the pod's disk. Skill sets are
// kilobytes, but a repo-sync volume is arbitrary user content — without a cap, a
// synced repo with a large file parked in a skill directory fills the pod's
// ephemeral disk and takes the sandbox with it. Skills past the budget are
// skipped, loudly.
const skillCopyBudget int64 = 64 << 20

// Per-skill deadline. Same bargain as `readableWithin`: a copy that never
// answers leaks its goroutine inside the daemon, where it costs one skill,
// rather than inside the CLI, where it costs the run.
const skillCopyTimeout = 30 * time.Second

var errSkillBudget = errors.New("skill prefetch budget exhausted")

// copySkillTreeWithin copies the skill directory src to dst, charging bytes
// against budget, and gives up after skillCopyTimeout. dst is left behind on
// failure for the caller to remove — a half-copied skill must not be exposed.
func copySkillTreeWithin(src, dst string, budget *atomic.Int64) error {
	done := make(chan error, 1)
	go func() { done <- copyTree(src, dst, budget) }()
	select {
	case err := <-done:
		return err
	case <-time.After(skillCopyTimeout):
		return fmt.Errorf("copy did not finish within %s", skillCopyTimeout)
	}
}

// copyTree recursively copies regular files and directories, preserving the mode
// bits (org-fs serves read-only volumes as 0755, and skill helper scripts need
// the exec bit). Anything else — symlink, socket, device — is skipped: org-fs
// stores only files and dirs, so an oddity here is not ours to reproduce.
func copyTree(src, dst string, budget *atomic.Int64) error {
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	for _, e := range entries {
		from, to := filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())
		if e.IsDir() {
			if err := copyTree(from, to, budget); err != nil {
				return err
			}
			continue
		}
		if !e.Type().IsRegular() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			return err
		}
		// Charge before copying, and hand it back if the copy fails: two workers
		// racing must not both be told there is room for the last megabyte.
		if budget.Add(-info.Size()) < 0 {
			budget.Add(info.Size())
			return fmt.Errorf("%w (at %s)", errSkillBudget, e.Name())
		}
		if err := copyFile(from, to, info.Mode().Perm()); err != nil {
			budget.Add(info.Size())
			return err
		}
	}
	return nil
}

func copyFile(src, dst string, perm os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// prefetchSkill materializes one skill at dst, reporting whether it is usable.
// A partial copy is removed rather than left for the harness to trip over.
func prefetchSkill(src, dst string, budget *atomic.Int64) bool {
	if err := copySkillTreeWithin(src, dst, budget); err != nil {
		slog.Warn("org-fs skill prefetch failed", "skill", filepath.Base(src), "err", err)
		os.RemoveAll(dst)
		return false
	}
	return true
}

// skillJob is one skill directory to materialize: read it from src, land it at
// dst.
type skillJob struct{ src, dst string }

// How many skills are copied at once. These are network reads with two round
// trips each, so the win is overlap, not CPU — but every one of them is also a
// FUSE request against a single rclone process, so the pool stays small enough
// not to become the queue it is trying to drain.
const skillCopyConcurrency = 8

// prefetchSkills copies every job onto local disk, bounded-parallel, and reports
// how many landed. The byte budget is passed in and shared with the tar path:
// the cap protects the pod's disk, so it cannot be per set, per worker, or per
// transport.
func prefetchSkills(jobs []skillJob, budget *atomic.Int64) int {
	if len(jobs) == 0 {
		return 0
	}
	work := make(chan skillJob)
	var wg sync.WaitGroup
	var copied atomic.Int64
	workers := min(skillCopyConcurrency, len(jobs))
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range work {
				if prefetchSkill(j.src, j.dst, budget) {
					copied.Add(1)
				}
			}
		}()
	}
	for _, j := range jobs {
		work <- j
	}
	close(work)
	wg.Wait()
	return int(copied.Load())
}
