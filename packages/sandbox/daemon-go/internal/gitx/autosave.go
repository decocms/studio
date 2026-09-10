package gitx

import (
	"log/slog"
	"sync"
	"time"
)

// AutosaveInterval is how often a run's working tree is checkpointed to its
// branch.
//
// The window it bounds is data loss, not latency: on a hard pod death
// (OOMKill, node loss, SIGKILL) the daemon's shutdown sync never runs, so
// whatever is uncommitted is gone and the replacement pod clones only what was
// pushed. A long agent run that edits for many turns without committing had an
// unbounded window before this existed.
const AutosaveInterval = 2 * time.Minute

// AutosaveMessage is the commit subject for every checkpoint. Fixed on purpose:
// a reader scanning a branch's history needs to tell the agent's own deliberate
// commits from the daemon's periodic ones at a glance.
const AutosaveMessage = "chore(daemon): checkpoint work in progress"

// AutosaveDeps is what the checkpoint loop needs from the daemon. Injected
// rather than reached for, so the loop is testable without a daemon, a repo or
// a network.
type AutosaveDeps struct {
	// Publish carries the same PublishDeps the shutdown sync uses. Its
	// ReconcileRemote MUST stay false: a checkpoint that force-pushed could
	// clobber a concurrent writer, and losing a checkpoint is strictly better
	// than losing someone else's commit.
	Publish PublishDeps
	// Interval between checks. Zero means AutosaveInterval.
	Interval time.Duration
	// Lock is the daemon's working-tree lock. Held only for the publish itself.
	Lock interface{ Acquire() func() }
	// Configured reports whether a branch is known yet. False before the clone
	// lands, when there is nothing to push to.
	Configured func() bool
	// RunActive reports whether a harness run is in flight. Checkpoints exist
	// for runs; an idle sandbox already syncs on shutdown and does not need its
	// tree committed under someone who is just browsing.
	RunActive func() bool
	// Dirty reports whether the tree has uncommitted changes. Checked WITHOUT
	// the tree lock: it is a read, and a wrong answer only costs one skipped or
	// one wasted cycle, whereas taking the lock every interval would stall
	// writers for nothing on a clean tree.
	Dirty func() bool
	// publishFn is the publish to call. nil means the real Publish; set by tests.
	publishFn func(PublishDeps, string) error
}

// Autosaver periodically commits and pushes a running agent's working tree to
// its own branch, so a pod that dies without a grace period loses minutes of
// work instead of the whole run.
//
// Non-blocking by construction: it owns a goroutine and never runs on a request
// path. It takes the tree lock only around the publish, and the health probe
// reads none of that state, so a slow push cannot make the pod look dead.
//
// Idempotent by construction: Publish stages the tree, commits ONLY when the
// index is non-empty, and pushes; a tick that finds nothing new commits nothing
// and pushes a no-op. Two ticks in a row on an unchanged tree leave one commit,
// not two.
//
// ponytail: whole-tree checkpoint on a timer, no coalescing with the agent's own
// commits and no attempt to squash the checkpoints afterwards. They are cheap and
// they are on a feature branch that gets squash-merged. If the noise ever matters,
// squash them at PR time — not by making the daemon clever about it.
type Autosaver struct {
	deps AutosaveDeps
	stop chan struct{}
	mu   sync.Mutex
	// done is closed when the loop exits, so Stop can be called from shutdown
	// without racing a publish already in flight.
	done    chan struct{}
	started bool
}

func NewAutosaver(deps AutosaveDeps) *Autosaver {
	if deps.Interval <= 0 {
		deps.Interval = AutosaveInterval
	}
	if deps.publishFn == nil {
		deps.publishFn = Publish
	}
	return &Autosaver{
		deps: deps,
		stop: make(chan struct{}),
		done: make(chan struct{}),
	}
}

// Start runs the checkpoint loop until Stop. Safe to call once; later calls are
// no-ops.
func (a *Autosaver) Start() {
	a.mu.Lock()
	if a.started {
		a.mu.Unlock()
		return
	}
	a.started = true
	a.mu.Unlock()
	go a.loop()
}

// Stop ends the loop and waits for an in-flight checkpoint to finish, so the
// shutdown sync that follows never races it for the tree lock.
func (a *Autosaver) Stop() {
	a.mu.Lock()
	if !a.started {
		a.mu.Unlock()
		return
	}
	a.mu.Unlock()
	select {
	case <-a.stop:
		// already stopping
	default:
		close(a.stop)
	}
	<-a.done
}

func (a *Autosaver) loop() {
	defer close(a.done)
	t := time.NewTicker(a.deps.Interval)
	defer t.Stop()
	for {
		select {
		case <-a.stop:
			return
		case <-t.C:
			a.Tick()
		}
	}
}

// Tick performs one checkpoint if the tree warrants it. Exported for the test:
// the decision is the part worth asserting on, and driving it directly beats
// waiting on a timer.
func (a *Autosaver) Tick() {
	if a.deps.Configured != nil && !a.deps.Configured() {
		return
	}
	if a.deps.RunActive != nil && !a.deps.RunActive() {
		return
	}
	// Cheap read, no lock. A clean tree is the common case and must cost nothing.
	if a.deps.Dirty != nil && !a.deps.Dirty() {
		return
	}
	if a.deps.Lock != nil {
		release := a.deps.Lock.Acquire()
		defer release()
	}
	// The tree lock serializes the daemon's own writers, NOT the agent: its
	// edits go through Bash straight to the filesystem. So a checkpoint can
	// capture a half-written file. That is acceptable for a checkpoint and only
	// for a checkpoint — it is superseded by the next one and by the agent's own
	// commit, and the alternative (cancelling the run to get a quiet tree, which
	// is what shutdown does) is not available to a periodic save.
	if err := a.deps.publishFn(a.deps.Publish, AutosaveMessage); err != nil {
		// Never fatal. A checkpoint is best-effort: a detached HEAD mid-rebase, a
		// protected branch, a transient push failure all mean "not this time",
		// and the next tick tries again.
		slog.Warn("autosave checkpoint failed", "err", err)
		return
	}
	slog.Info("autosave checkpoint pushed")
}

// IsDirty reports whether the working tree has anything uncommitted. A cheap
// porcelain read, deliberately not the full ComputeWorkingTreeStatus: the
// checkpoint loop only needs the boolean, and it asks every interval.
//
// An error reads as clean. A tree whose status cannot be read is not one to
// commit blind.
func IsDirty(repoDir string) bool {
	out, ok := tryReadGit(repoDir, []string{"status", "--porcelain=v1", "-z"})
	if !ok {
		return false
	}
	return len(ParsePorcelainZ(out)) > 0
}
