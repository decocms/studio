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
	budget := sessionBudget()
	if err := copyTree(src, filepath.Join(local, projectsSubdir), budget); err != nil {
		slog.Warn("claude session restore: transcript copy failed",
			"thread", threadId, "err", err)
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
	staging := filepath.Join(store, projectsStaging)
	os.RemoveAll(staging)
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
