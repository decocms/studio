package orgfs

// Org-fs links — the cluster-pod half of org-fs.
//
// A hosted sandbox's main container cannot mount (locked-down
// securityContext); a privileged sidecar FUSE-mounts the org volumes at
// `<appRoot>/org/<volume>` and Bidirectional propagation surfaces them here.
// This daemon's job is therefore not mounting but *linking*, so every harness —
// including CLI ones that only read real files — resolves the prompts' relative
// `org/...` paths:
//
//   - `<repoDir>/org` → `../org`, so a harness shell with cwd `<appRoot>/repo`
//     sees the volumes (repo-link).
//   - `<appRoot>/org/output` → `.outputs/<threadId>` and `org/upload` →
//     `.uploads/<threadId>`, repointed per run, so an agent writing the bare
//     link path lands in the running thread's subtree (thread-links).
//
// Every step is gated on the volumes being ACTUALLY mounted, read from the
// sidecar's status file: a mount-point dir exists locally even when the mount
// failed, and linking into that would silently strand the user's files on the
// pod's ephemeral disk. Never returns an error — org-fs is additive, and a
// failure must never break a tool call.
//
// The rclone/WebDAV mounting side (`org-fs/mount-manager.ts`, `webdav.ts`,
// `mounter.ts`, `invalidator.ts`, `detach-mount.ts`) is deliberately NOT ported:
// it runs only where the daemon mounts for itself, which is the desktop
// (`ORGFS_CONFIG` + `ORGFS_RCLONE_PATH`, set by `link-daemon`), and the desktop
// ships the TS bundle. Boot warns if that env reaches this binary.

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/gitx"
)

// First-touch grace: a freshly provisioned sandbox can take its first tool call
// while the sidecar is still attaching (~2-5s after the config relay), so the
// agent's very first `ls org/` races the mount. Waited once, deadline-bounded,
// fail-open — after this window every call takes the cheap path, so a broken
// sidecar can never cause a recurring stall.
const (
	firstMountWait = 10 * time.Second
	firstMountPoll = 250 * time.Millisecond
)

// One path segment, no traversal — threadIds are cluster-issued slugs/UUIDs.
var safeThreadId = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// Mount is one live mount, as reported by the sidecar's status file (mirrors
// MountManager.list()).
type Mount struct {
	Volume    string `json:"volume"`
	MountPath string `json:"mountPath"`
}

type sidecarStatus struct {
	Mounts []Mount `json:"mounts"`
}

// Links owns the daemon's org-fs symlinks. Zero StatusPath/ConfigPath means
// org-fs is not expected and every method is a no-op.
type Links struct {
	AppRoot string
	RepoDir string
	// StatusPath is ORGFS_SIDECAR_STATUS_PATH — what the sidecar reports mounted.
	StatusPath string
	// ConfigPath is ORGFS_SIDECAR_CONFIG_PATH. Its presence alone means org-fs is
	// expected on this pod, which is what makes the first-touch wait fire before
	// the sidecar has written any status.
	ConfigPath string

	firstWait sync.Once
	firstOk   bool

	// One mutex serializes the whole repoint. The links are shared mutable state:
	// without it, two concurrent runs could interleave and leave the memo naming
	// thread A while the symlink points at thread B — silently misrouting a
	// thread's files. ponytail: coarse by design; a stuck FUSE lstat blocks only
	// org-fs callers (never the health probe, which is the TS daemon's hazard).
	mu               sync.Mutex
	lastOutputThread string
}

// Expected reports whether org-fs volumes should exist on this pod.
func (l *Links) Expected() bool {
	return l != nil && (l.ConfigPath != "" || l.StatusPath != "")
}

// ActiveMounts is what the sidecar reports mounted; empty on any failure.
func (l *Links) ActiveMounts() []Mount {
	if l == nil || l.StatusPath == "" {
		return nil
	}
	raw, err := os.ReadFile(l.StatusPath)
	if err != nil {
		return nil
	}
	var st sidecarStatus
	if json.Unmarshal(raw, &st) != nil {
		return nil
	}
	return st.Mounts
}

// waitForFirstMounts blocks until the sidecar reports a mount or the deadline
// passes, at most once per process. Fail-open: a timeout returns false and the
// caller proceeds without links (a later call self-heals).
func (l *Links) waitForFirstMounts() bool {
	l.firstWait.Do(func() {
		deadline := time.Now().Add(firstMountWait)
		for time.Now().Before(deadline) {
			if len(l.ActiveMounts()) > 0 {
				l.firstOk = true
				return
			}
			time.Sleep(firstMountPoll)
		}
		slog.Warn("org-fs mounts not up; continuing without", "waited", firstMountWait)
	})
	return l.firstOk
}

// mountsOrWait returns the live mounts, paying the one-shot grace wait if none
// have appeared yet.
func (l *Links) mountsOrWait() []Mount {
	if mounts := l.ActiveMounts(); len(mounts) > 0 {
		return mounts
	}
	if !l.waitForFirstMounts() {
		return nil
	}
	return l.ActiveMounts()
}

// EnsureRepoLink makes the prompts' relative `org/...` paths resolve from the
// harness cwd. Idempotent and cheap after the first call (one lstat).
func (l *Links) EnsureRepoLink() {
	if !l.Expected() || len(l.mountsOrWait()) == 0 {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.ensureRepoLinkLocked()
}

// RepointForRun points `org/output` (and `org/upload`, when that volume is
// mounted) at threadId's subtree. Reports whether the output link is confirmed
// pointing there.
func (l *Links) RepointForRun(threadId string) bool {
	if !l.Expected() {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if threadId != "" && threadId == l.lastOutputThread {
		// Already pointing here; keep the repo link fresh (one lstat).
		l.ensureRepoLinkLocked()
		return true
	}
	mounts := l.mountsOrWait()
	if len(mounts) == 0 {
		return false
	}
	l.ensureRepoLinkLocked()
	mounted := func(dir string) bool {
		want := filepath.Join(l.AppRoot, "org", dir)
		for _, m := range mounts {
			if m.MountPath == want {
				return true
			}
		}
		return false
	}
	// Uploads is best-effort: sandboxes provisioned before the uploads volume
	// existed have no `.uploads` mount, and inbound attachments flow through
	// Studio regardless — never fail a run over it.
	if mounted(".uploads") {
		l.repointThreadLink(threadId, ".uploads", "upload")
	}
	if !mounted(".outputs") {
		return false
	}
	// Cache only a CONFIRMED repoint: repointThreadLink fails soft, and caching a
	// failure would pin the memo at this thread while the symlink still points at
	// the previous one, with no retry.
	if !l.repointThreadLink(threadId, ".outputs", "output") {
		return false
	}
	l.lastOutputThread = threadId
	return true
}

// ensureRepoLinkLocked drops the relative `<repoDir>/org → ../org` symlink and
// registers it in `.git/info/exclude` so the shutdown `git add -A` never commits
// it onto a user branch. Created at dispatch time, never at boot — a link in
// place first would make `git clone` refuse the non-empty dir.
func (l *Links) ensureRepoLinkLocked() {
	if l.RepoDir == "" {
		return
	}
	link := filepath.Join(l.RepoDir, "org")
	st, err := os.Lstat(link)
	if err == nil {
		// A real `org/` tracked by the repo wins; never shadow user content.
		if st.Mode()&os.ModeSymlink == 0 {
			return
		}
	} else if err := os.Symlink("../org", link); err != nil {
		slog.Warn("org-fs repo link failed", "err", err)
		return
	}
	gitx.EnsureExclude(l.RepoDir, "/org")
}

// repointThreadLink points `org/<linkName>` at `<mountDir>/<threadId>`, creating
// the thread's subtree through the mount. Relative target so the tree survives
// being moved.
func (l *Links) repointThreadLink(threadId, mountDir, linkName string) bool {
	if !safeThreadId.MatchString(threadId) {
		slog.Warn("org-fs link skipped: unsafe threadId", "link", linkName, "threadId", threadId)
		return false
	}
	orgRoot := filepath.Join(l.AppRoot, "org")
	volumeMount := filepath.Join(orgRoot, mountDir)
	// Defense in depth (the caller already gates on the live mount): without the
	// mount, MkdirAll would create local dirs that later shadow it.
	if st, err := os.Lstat(volumeMount); err != nil || !st.IsDir() {
		return false
	}
	if err := os.MkdirAll(filepath.Join(volumeMount, threadId), 0o755); err != nil {
		slog.Warn("org-fs link repoint failed", "link", linkName, "err", err)
		return false
	}
	link := filepath.Join(orgRoot, linkName)
	target := filepath.Join(mountDir, threadId)
	if st, err := os.Lstat(link); err == nil {
		if st.Mode()&os.ModeSymlink == 0 {
			slog.Warn("org-fs link skipped: exists and is not a symlink", "link", link)
			return false
		}
		if cur, err := os.Readlink(link); err == nil && cur == target {
			return true
		}
		if err := os.Remove(link); err != nil {
			slog.Warn("org-fs link repoint failed", "link", linkName, "err", err)
			return false
		}
	}
	if err := os.Symlink(target, link); err != nil {
		slog.Warn("org-fs link repoint failed", "link", linkName, "err", err)
		return false
	}
	return true
}
