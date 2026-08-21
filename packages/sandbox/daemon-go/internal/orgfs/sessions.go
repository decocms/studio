package orgfs

// Claude Code session persistence: the SDK's own conversation state, carried
// between the pod's Claude config dir and the org volume that outlives the pod.
//
// Why this exists: a thread's chat is interactive now, and the pod is not. A
// sandbox is reclaimed ~15 minutes after the last viewer leaves, so a follow-up
// sent an hour later lands in a fresh pod whose SDK session is empty — the model
// reads "make that button blue" with no idea what "that" is. The transcript is
// the only full-fidelity record of the turn (tool calls included; Studio's
// thread_message_parts has the rendered chat, not the agent's own context), so
// it is what has to survive.
//
// COPIED, never mounted. Claude Code reads the transcript on its STARTUP path,
// and org-fs is a network filesystem whose reads can block indefinitely — the
// same hazard `readableWithin` exists for in links.go, but on a file the run
// cannot choose to skip. Symlinking the config dir would turn a wedged backend
// into "every run produces nothing"; copying turns it into a slow dispatch, and
// at worst a session that starts fresh. That is the whole design.
//
// Single writer by construction: Studio's thread gate runs one dispatch per
// thread at a time, and each run's save happens after its harness has exited.

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

// Where a thread's session state lives on the home volume, under
// `org/home/<sessionsDirName>/<threadId>/`.
const sessionsDirName = "claude-sessions"

// The two things a resumable session is made of, mirrored on both sides:
//
//   - `projects/` is the SDK's own transcript tree
//     (`projects/<cwd-slug>/<sessionId>.jsonl`). Copied whole rather than
//     reaching for one file: the slug is a Claude Code internal, and a pod is
//     thread-scoped anyway, so "the tree" and "this thread's transcripts" are
//     the same set. Nothing here has to know the format — which also means the
//     restored tree only resolves if the next pod's cwd matches, i.e. as long as
//     WORKDIR is the same. Changing it deploy-wide costs every live thread its
//     session once, and nothing worse: an unresolvable id starts fresh.
//   - `session-id` is the id the harness resumes, which it keeps locally at
//     `deco-sessions/<threadId>` (see `sessionFile` in claude-code.ts). The two
//     must travel together — an id whose transcript is missing fails the run
//     outright, which is worse than starting fresh.
const (
	projectsSubdir  = "projects"
	sessionIdName   = "session-id"
	localSessionDir = "deco-sessions"
	// Where a save is assembled before it replaces the live tree. Inside the
	// store so the swap is a rename within one filesystem.
	projectsStaging = ".projects.staging"
)

// Ceiling on a saved session, charged per file by `copyTree`. A long coding
// thread's transcript is megabytes of JSONL and every turn pays to copy it both
// ways over a network filesystem.
//
// ponytail: past this the copy stops and the save is abandoned, so the next cold
// pod starts fresh — a slow dispatch on every future turn is a worse failure
// than one lost conversation. If real threads start hitting it, prune the
// transcript's oldest entries rather than raising the cap.
const sessionCopyBudgetBytes int64 = 64 << 20

// sessionBudget is one copy's byte allowance. Fresh per call: the budget bounds
// a single transfer, not the pod's lifetime.
func sessionBudget() *atomic.Int64 {
	budget := &atomic.Int64{}
	budget.Store(sessionCopyBudgetBytes)
	return budget
}

// How long either direction of a session transfer may take before the dispatch
// stops waiting for it. Every path below touches org-fs, a network filesystem
// whose reads BLOCK INDEFINITELY when the backend is wedged — the hazard
// `readableWithin` exists for in links.go, and the reason this file copies
// instead of symlinking. Copying only downgrades a wedged mount from "the run
// produces nothing" to "a slow dispatch" if the copy has a deadline; without
// one, the dispatch never writes its first byte and Studio declares the pod
// gone (`DAEMON_SILENCE_TIMEOUT_MS`) on a pod that is perfectly alive.
// var, not const, only so the wedged-mount tests do not each sit here for the
// full budget proving that they stop.
var sessionIOBudget = 30 * time.Second

// withinSessionBudget runs one direction of a transfer under that deadline.
//
// A timeout LEAKS its goroutine, deliberately and on the same bargain as
// `readableWithin`: the blocked syscall is quarantined here, where it costs a
// session, rather than in the dispatch, where it costs the run.
//
// Deliberately NOT serialized behind a lock. A leaked flight never returns, so a
// lock it holds is never released — one wedged read would then skip every
// session on the pod for as long as the pod lives, turning a per-turn
// degradation into a permanent one (measured: a real saved session stopped
// restoring after an unrelated wedged read). Two flights overlapping is instead
// made harmless where it would hurt: restore only fills gaps (`copyMissing`),
// and each save stages into its own directory.
func withinSessionBudget(op, threadId string, fn func()) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		fn()
	}()
	select {
	case <-done:
	case <-time.After(sessionIOBudget):
		slog.Warn("claude session "+op+" abandoned: org-fs did not answer within budget",
			"thread", threadId, "budget", sessionIOBudget)
	}
}

// copyMissing copies src into dst like `copyTree`, but never overwrites a file
// that is already there.
//
// A pod is keyed by `(user, ref)`, not by thread, so two threads on one agent
// branch share one — and `projects/` is a single tree holding both their
// transcripts. Overwriting on restore would hand thread B's older snapshot to
// thread A's LIVE session and rewind it by a turn, the same corruption the
// "a live local session wins" check prevents for the thread being restored.
// Filling only the gaps gets B its transcript and leaves A's alone.
func copyMissing(src, dst string, budget *atomic.Int64) error {
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
			if err := copyMissing(from, to, budget); err != nil {
				return err
			}
			continue
		}
		if !e.Type().IsRegular() {
			continue
		}
		if _, err := os.Lstat(to); err == nil {
			continue
		}
		info, err := e.Info()
		if err != nil {
			return err
		}
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

// transcriptPresent reports whether the transcript the id names is on local
// disk. The SDK files it as `projects/<cwd-slug>/<sessionId>.jsonl` and the slug
// is its own business, so this looks for the leaf by name rather than assuming
// where it sits.
func transcriptPresent(localProjects, sessionId string) bool {
	want := sessionId + ".jsonl"
	found := false
	filepath.WalkDir(localProjects, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() && d.Name() == want {
			found = true
			return filepath.SkipAll
		}
		return nil
	})
	return found
}

// ClaudeConfigDir is the pod's Claude Code config dir — where the SDK keeps its
// transcripts and the harness keeps its session-id pointer.
func ClaudeConfigDir() string {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return dir
	}
	if home := os.Getenv("HOME"); home != "" {
		return filepath.Join(home, ".claude")
	}
	return ""
}

// sessionStore is the durable directory for threadId, and whether org-fs can
// serve it at all.
func (l *Links) sessionStore(threadId string) (string, bool) {
	if l == nil || !l.Expected() || !safeSegment.MatchString(threadId) {
		return "", false
	}
	if !l.volumeMounted("home") {
		return "", false
	}
	return filepath.Join(l.AppRoot, "org", "home", sessionsDirName, threadId), true
}

// RestoreSession copies threadId's saved session state onto local disk, so the
// harness's `resume` finds a transcript in a pod that never ran this thread.
//
// Best-effort in one direction only: a session that cannot be restored means a
// fresh conversation, which is exactly today's behaviour. It must never be a
// reason not to run.
//
// A local transcript already present WINS and nothing is copied — the pod that
// just ran this thread has the live session, and overwriting it with an older
// snapshot would rewind the conversation by a turn.
func (l *Links) RestoreSession(threadId string) {
	withinSessionBudget("restore", threadId, func() { l.restoreSession(threadId) })
}

func (l *Links) restoreSession(threadId string) {
	store, ok := l.sessionStore(threadId)
	if !ok {
		return
	}
	local := ClaudeConfigDir()
	if local == "" {
		return
	}

	idPath := filepath.Join(local, localSessionDir, threadId)
	if _, err := os.Stat(idPath); err == nil {
		// This pod already holds the session. Nothing to restore.
		return
	}

	savedId, err := os.ReadFile(filepath.Join(store, sessionIdName))
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("claude session restore: id unreadable", "thread", threadId, "err", err)
		}
		return
	}
	id := strings.TrimSpace(string(savedId))
	if id == "" {
		return
	}

	// Transcript first: the id is the claim that a transcript exists, so writing
	// it before the copy succeeds would point the harness at nothing and fail the
	// run it was meant to help.
	src := filepath.Join(store, projectsSubdir)
	if _, err := os.Stat(src); err != nil {
		slog.Warn("claude session restore: id saved with no transcript; starting fresh",
			"thread", threadId, "session", id)
		return
	}
	localProjects := filepath.Join(local, projectsSubdir)
	if err := copyMissing(src, localProjects, sessionBudget()); err != nil {
		slog.Warn("claude session restore: transcript copy failed",
			"thread", threadId, "err", err)
		return
	}
	// "The copy did not error" is NOT "the transcript is there": `copyTree`
	// returns nil for a tree that listed empty, which org-fs does whenever the
	// backend answers a readdir it cannot yet serve. Writing the id then hands
	// the harness a session the SDK never had, and THAT fails the whole run
	// ("No conversation found with session ID") — strictly worse than the fresh
	// start we are trying to improve on. So verify the named transcript.
	if !transcriptPresent(localProjects, id) {
		slog.Warn("claude session restore: transcript did not land; starting fresh",
			"thread", threadId, "session", id)
		return
	}

	if err := os.MkdirAll(filepath.Dir(idPath), 0o755); err != nil {
		slog.Warn("claude session restore: local dir failed", "thread", threadId, "err", err)
		return
	}
	if err := os.WriteFile(idPath, []byte(id), 0o644); err != nil {
		slog.Warn("claude session restore: id write failed", "thread", threadId, "err", err)
		return
	}
	slog.Info("claude session restored", "thread", threadId, "session", id)
}

// SaveSession copies threadId's session state back onto the org volume, so the
// next pod can resume it. Called after the harness exits, however it exited: a
// crashed turn's transcript is still the conversation the follow-up needs.
//
// No local session means nothing to save — notably NOT a reason to delete what
// is stored. A run that died before the harness wrote its id would otherwise
// take the previous turns down with it.
func (l *Links) SaveSession(threadId string) {
	withinSessionBudget("save", threadId, func() { l.saveSession(threadId) })
}

func (l *Links) saveSession(threadId string) {
	store, ok := l.sessionStore(threadId)
	if !ok {
		return
	}
	local := ClaudeConfigDir()
	if local == "" {
		return
	}

	id, err := os.ReadFile(filepath.Join(local, localSessionDir, threadId))
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("claude session save: id unreadable", "thread", threadId, "err", err)
		}
		return
	}
	if strings.TrimSpace(string(id)) == "" {
		return
	}

	src := filepath.Join(local, projectsSubdir)
	if _, err := os.Stat(src); err != nil {
		// A run that produced no transcript. Leave the stored session alone —
		// deleting it would take the earlier turns with it.
		return
	}

	// Staged, then swapped. `copyTree` writes each file in place, so copying
	// straight onto the store would overwrite a good transcript with a partial
	// one if the pod is reclaimed mid-save — and the id still pointing at it
	// makes that a run-killing resume rather than a fresh start. The swap's own
	// interrupted window leaves NO transcript, which `RestoreSession` already
	// treats as "start fresh".
	started := time.Now()
	if err := os.MkdirAll(store, 0o755); err != nil {
		slog.Warn("claude session save: store dir failed", "thread", threadId, "err", err)
		return
	}
	pruneStaleStaging(store)
	// Its OWN staging dir, not a shared name. A save abandoned at the budget goes
	// on writing where nobody looks; sharing the path would let it land its
	// leftovers in the next save's swap and put a partial transcript behind a
	// live id — the one outcome worse than no session at all.
	staging, err := os.MkdirTemp(store, projectsStaging+"-")
	if err != nil {
		slog.Warn("claude session save: staging dir failed", "thread", threadId, "err", err)
		return
	}
	defer os.RemoveAll(staging)
	if err := copyTree(src, staging, sessionBudget()); err != nil {
		slog.Warn("claude session save: transcript copy failed", "thread", threadId, "err", err)
		return
	}
	live := filepath.Join(store, projectsSubdir)
	if err := os.RemoveAll(live); err != nil {
		slog.Warn("claude session save: could not clear the previous transcript",
			"thread", threadId, "err", err)
		return
	}
	if err := os.Rename(staging, live); err != nil {
		slog.Warn("claude session save: swap failed", "thread", threadId, "err", err)
		return
	}
	// Id last, mirroring restore: it is the pointer, and a pointer written before
	// the thing it points at is a pointer to nothing if the copy dies halfway.
	if err := os.WriteFile(filepath.Join(store, sessionIdName), id, 0o644); err != nil {
		slog.Warn("claude session save: id write failed", "thread", threadId, "err", err)
		return
	}
	slog.Info("claude session saved", "thread", threadId, "took", time.Since(started))
}

// pruneStaleStaging clears staging dirs left behind by abandoned saves. Anything
// older than twice the budget cannot belong to a flight still in the air, and
// nothing else in the store is named this way.
func pruneStaleStaging(store string) {
	entries, err := os.ReadDir(store)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), projectsStaging) {
			continue
		}
		info, err := e.Info()
		if err != nil || time.Since(info.ModTime()) < 2*sessionIOBudget {
			continue
		}
		os.RemoveAll(filepath.Join(store, e.Name()))
	}
}
