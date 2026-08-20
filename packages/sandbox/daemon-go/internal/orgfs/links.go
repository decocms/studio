package orgfs

// Org-fs links: a privileged sidecar mounts the org volumes at
// `<appRoot>/org/<volume>`; this daemon only links them so relative `org/...`
// paths resolve — `<repoDir>/org → ../org`, plus `org/output` and `org/upload`
// repointed per run at the running thread's subtree. Every step is gated on the
// sidecar's status file, not on directory existence: a mount-point dir exists
// even when the mount failed, and linking into that strands the user's files on
// ephemeral disk. Fails open — org-fs is additive and must never break a call.
//
// Mounting itself (rclone/WebDAV) is desktop-only and stays in the TS bundle.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/gitx"
)

// First-touch grace: the first tool call can race the sidecar still attaching.
// Waited once, fail-open, so a broken sidecar never causes a recurring stall.
const (
	firstMountWait = 10 * time.Second
	firstMountPoll = 250 * time.Millisecond
)

// One path segment, no traversal — thread ids, volume set and skill dir names.
var safeSegment = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

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
	// expected, which is what makes the first-touch wait fire before any status.
	ConfigPath string

	firstWait sync.Once
	firstOk   bool

	// Serializes the whole repoint: without it two concurrent runs can leave the
	// memo naming thread A while the symlink points at B. ponytail: coarse by
	// design — a stuck FUSE lstat blocks only org-fs callers.
	mu               sync.Mutex
	lastOutputThread string
	skillsLinked     bool
	readySpent       bool
	publicSkillsRun  bool
	// Closed when the in-flight skill-link sync finishes; nil before the first
	// one starts. `WaitSkillLinks` is what turns the async sync back into a
	// barrier for the run that needs it.
	publicSkillsDone chan struct{}
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

// How long a dispatch waits for the org's content to be in place, and how often
// it re-checks. The budget is generous because the thing it is racing is a
// sidecar attaching a network filesystem, and short next to the cost of the run
// it gates.
const (
	orgReadyBudget = 90 * time.Second
	orgReadyPoll   = 500 * time.Millisecond
)

// WaitHomeReady blocks until the org HOME volume is attached and the org's
// skills are linked out of it, and reports whether it got there. A pod with no
// org-fs configured is ready by definition.
//
// Distinct from its neighbour `WaitSkillLinks`, which waits on the public
// skill-set COPY that a repoint kicks off in the background. This one waits for
// the mount those links and the thread's saved session both live on — there is
// nothing to sync until it exists.
//
// Waiting, where every other path in this file fails open. The difference is
// what the failure looks like downstream: a missing `org/output` link is a tool
// call that errors, which somebody sees. A missing SKILLS link is a run that
// completes confidently having never been offered the org's own instructions
// for the task — indistinguishable from a bad answer, and the reason this gate
// exists. Same for the session restore that follows it: starting the turn before
// the transcript lands is how an interactive thread silently forgets itself.
//
// Bounded, because "wait until ready" unbounded is its own outage — a wedged
// backend would mean no dispatch ever returns. At the ceiling the run proceeds
// without, loudly.
func (l *Links) WaitHomeReady(threadId string) bool {
	if l == nil || !l.Expected() {
		return true
	}
	// The budget is paid ONCE per pod. A sandbox whose sidecar mounts no home
	// volume at all — a deployment that configures only outputs, a sidecar that
	// died — would otherwise stall EVERY dispatch for the full 90s, turning a
	// missing optional volume into a permanent per-run tax. After the first
	// timeout each dispatch still re-checks (a mount that shows up late is
	// picked up on the next run), it just stops sleeping for one.
	waited := !l.readyBudgetSpent()
	started := time.Now()
	for attempt := 1; ; attempt++ {
		// Does the linking, so a mount that appears mid-wait is picked up.
		l.RepointForRun(threadId)
		if l.skillsReady() {
			if attempt > 1 {
				slog.Info("org-fs ready", "thread", threadId,
					"waited", time.Since(started), "attempts", attempt)
			}
			return true
		}
		if !waited || time.Since(started) >= orgReadyBudget {
			l.spendReadyBudget()
			slog.Warn("org-fs not ready; running without the org's skills",
				"thread", threadId, "waited", time.Since(started), "polled", waited)
			return false
		}
		time.Sleep(orgReadyPoll)
	}
}

func (l *Links) readyBudgetSpent() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.readySpent
}

func (l *Links) spendReadyBudget() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.readySpent = true
}

// skillsReady reports whether the org's skills dir is where the SDK will look.
func (l *Links) skillsReady() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.skillsLinked
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
	// Best-effort: older sandboxes have no `.uploads` mount, and attachments flow
	// through Studio regardless.
	if mounted(".uploads") {
		l.repointThreadLink(threadId, ".uploads", "upload")
	}
	if !mounted(".outputs") {
		return false
	}
	// Cache only a confirmed repoint — caching a soft failure would pin the memo
	// here while the symlink still points at the previous thread.
	if !l.repointThreadLink(threadId, ".outputs", "output") {
		return false
	}
	l.lastOutputThread = threadId
	return true
}

// ensureRepoLinkLocked drops `<repoDir>/org → ../org` and excludes it so the
// shutdown `git add -A` never commits it. At dispatch time, not boot — a link in
// place first makes `git clone` refuse the non-empty dir. Also links the org's
// skills folder into the pod's Claude config dir (same job: make org content
// resolve where the harness looks for it).
func (l *Links) ensureRepoLinkLocked() {
	l.ensureSkillsLinkLocked()
	defer l.ensurePublicSkillLinksLocked()
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

// ensureSkillsLinkLocked points the pod's USER skill dir (`~/.claude/skills`,
// or `$CLAUDE_CONFIG_DIR/skills`) at the org's `org/home/skills` on the mount.
//
// User scope, not the repo's `.claude/skills`: Claude Code loads both, so the
// org's skills add to whatever the checkout ships instead of shadowing it. And
// because the link IS the mount, a skill the agent writes there is an org-fs
// write — it syncs back with no extra machinery, and the next run in any pod
// sees it.
//
// Absolute target (the config dir is outside `<appRoot>`), and a real directory
// already sitting there wins — never shadow a pod's own skills.
func (l *Links) ensureSkillsLinkLocked() {
	if l.skillsLinked {
		return
	}
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	if dir == "" {
		home := os.Getenv("HOME")
		if home == "" {
			return
		}
		dir = filepath.Join(home, ".claude")
	}
	// Gated on the SIDECAR's report, not on the directory: a mount point exists
	// even when the mount failed, and MkdirAll into that puts the org's skills on
	// ephemeral disk, where they die with the pod (this file's whole premise).
	if !l.volumeMounted("home") {
		return
	}
	target := filepath.Join(l.AppRoot, "org", "home", "skills")
	if err := os.MkdirAll(target, 0o755); err != nil {
		slog.Warn("org-fs skills dir failed", "err", err)
		return
	}
	// Reads and writes fail independently on this mount, and only reads can kill
	// a run: rclone's write-back cache absorbs a write and flushes it out of band
	// (a skill the agent authors syncs even while GETs are wedged), but Claude
	// Code READS every skill in this dir during startup, on the thread pool that
	// then never answers.
	//
	// So the read gate applies only when there is something to read. An empty
	// skills dir has no file to hang on, and linking it is what gives the agent
	// somewhere durable to write — skip the link there and the agent writes its
	// skill into the checkout, which is the whole bug this exists to fix.
	if names := skillDirNames(target); len(names) > 0 && !setReads(target, names) {
		return
	}
	link := filepath.Join(dir, "skills")
	if st, err := os.Lstat(link); err == nil {
		if st.Mode()&os.ModeSymlink == 0 {
			slog.Warn("org-fs skills link skipped: exists and is not a symlink", "link", link)
			l.skillsLinked = true
			return
		}
		if cur, err := os.Readlink(link); err == nil && cur == target {
			l.skillsLinked = true
			return
		}
		if err := os.Remove(link); err != nil {
			slog.Warn("org-fs skills link failed", "err", err)
			return
		}
	} else if err := os.MkdirAll(dir, 0o755); err != nil {
		slog.Warn("org-fs skills link failed", "err", err)
		return
	}
	if err := os.Symlink(target, link); err != nil {
		slog.Warn("org-fs skills link failed", "err", err)
		return
	}
	l.skillsLinked = true
}

// How long a single org-fs read may take before the mount counts as unusable
// for skills. Generous for a network filesystem, tiny next to a dead run.
const skillReadBudget = 3 * time.Second

// errReadTimeout marks the ONE probe failure that speaks for the whole mount: a
// read that never answered. Every other error is one object's problem.
var errReadTimeout = errors.New("read did not answer within budget")

// setReads reports whether a skill set's mount serves reads, probing skills in
// order until one answers.
//
// The distinction is the point. A TIMEOUT is the mount's answer for the entire
// set — one volume, one backend — and probing past it would spend the budget
// again on exactly the wedged mount this gate exists to catch, so it condemns
// the set on the spot. Any other error belongs to that single object (bytes that
// were never uploaded surface as EIO) and returns immediately, so it must not
// take the healthy skills behind it down: condemning a set on its alphabetically
// first skill is how 84 good skills disappeared.
func setReads(setDir string, names []string) bool {
	for _, name := range names {
		ok, err := readableWithin(filepath.Join(setDir, name, "SKILL.md"), skillReadBudget)
		if ok {
			return true
		}
		if errors.Is(err, errReadTimeout) {
			slog.Warn("org-fs skills skipped: mount does not read",
				"dir", setDir, "probe", name, "skills", len(names), "err", err)
			return false
		}
		slog.Warn("org-fs skills: unreadable skill, probing past it",
			"dir", setDir, "probe", name, "err", err)
	}
	return false
}

// readableWithin reports whether path's first byte can be read within d, and
// why not when it fails. The reason matters: "hung mount" and "backend returns
// EIO because the bytes were never uploaded" both surface here as a skipped
// set, and only the error tells them apart — without it the warn line sends you
// exec'ing into a pod to find out.
//
// This gate is the whole reason skills are safe to expose: org-fs is a network
// filesystem, and a wedged backend turns a read into an INDEFINITE block, not an
// error. Claude Code scans every skill dir during STARTUP, on its I/O thread
// pool — so one hung read there means the CLI never emits `init`, the run
// produces nothing at all, and the pod bills a full idle TTL having done zero
// work. Observed live: both Bun pool threads parked in `request_wait_answer`.
//
// A timeout leaks its goroutine until the FUSE request finally answers. That is
// the point: the blocked read is quarantined in the daemon, where it costs a
// skill, instead of in the CLI, where it costs the run.
func readableWithin(path string, d time.Duration) (bool, error) {
	done := make(chan error, 1)
	go func() {
		f, err := os.Open(path)
		if err != nil {
			done <- err
			return
		}
		defer f.Close()
		if _, err := f.Read(make([]byte, 1)); err != nil && err != io.EOF {
			done <- err
			return
		}
		done <- nil
	}()
	select {
	case err := <-done:
		return err == nil, err
	case <-time.After(d):
		return false, fmt.Errorf("%w (%s)", errReadTimeout, d)
	}
}

// skillDirNames lists the subdirectories of dir that hold a SKILL.md. Listing
// and stat are the org-fs operations that survive a wedged backend (both are
// served from the mount's metadata), so this is safe to call before any read —
// and filtering here is what keeps a non-skill directory from being chosen as
// the read probe and condemning a whole set.
func skillDirNames(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() || !safeSegment.MatchString(e.Name()) {
			continue
		}
		if _, err := os.Stat(filepath.Join(dir, e.Name(), "SKILL.md")); err != nil {
			continue
		}
		names = append(names, e.Name())
	}
	return names
}

// volumeMounted reports whether the sidecar has `<appRoot>/org/<dir>` mounted.
func (l *Links) volumeMounted(dir string) bool {
	want := filepath.Join(l.AppRoot, "org", dir)
	for _, m := range l.mountsOrWait() {
		if m.MountPath == want {
			return true
		}
	}
	return false
}

// Prefix for the symlinks this daemon plants in the checkout's skills dir. It
// is what makes them ours: everything matching it is removed and rebuilt on
// sync, and one git-exclude line covers the whole set.
const publicSkillPrefix = "orgfs-"

// ensurePublicSkillLinksLocked exposes the read-only public skill sets
// (`org/public/<set>/<skill>`) to Claude Code as PROJECT skills — one symlink
// per skill under `<repoDir>/.claude/skills/`.
//
// Why not the user dir like home skills: that dir IS the home mount now, so a
// symlink dropped there would be written into org-fs — pod-local paths synced
// org-wide. And the public mounts are read-only, so a plugin manifest cannot go
// next to them either. The checkout's skills dir is the one writable place the
// SDK already scans.
//
// Additive and disposable: the repo's own skills are untouched (only `orgfs-*`
// entries are ours, and they are cleared before rebuild so a removed set leaves
// no dangling skill), and one exclude line keeps them out of every commit.
func (l *Links) ensurePublicSkillLinksLocked() {
	if l.publicSkillsRun || l.RepoDir == "" {
		return
	}
	// Claimed before the work starts, so concurrent fs calls don't each launch a
	// sync; released again below if nothing linked, so a mount that recovers gets
	// another attempt.
	l.publicSkillsRun = true
	done := make(chan struct{})
	l.publicSkillsDone = done
	// OFF the caller's thread: this walks a network filesystem and would
	// otherwise hold `mu` across it. Callers that must not race the harness's own
	// startup skill scan await `done` via WaitSkillLinks instead of blocking here.
	go func() {
		defer close(done)
		if l.syncPublicSkills() {
			return
		}
		l.mu.Lock()
		l.publicSkillsRun = false
		l.mu.Unlock()
	}()
}

// WaitSkillLinks blocks until the in-flight skill-link sync finishes, or budget
// elapses. Call it on the dispatch path after the links are triggered and before
// the harness starts: Claude Code scans its skill dirs ONCE at startup, so a
// symlink that lands a moment later is invisible for the whole run — which is
// how a freshly-synced repo's skills went missing while being correctly mounted.
//
// Bounded, and fail-open. The sync spends the read budget at most once per set
// (a timeout condemns that set immediately; every other probe error returns
// without waiting), so the honest worst case is small — but a run must never
// hang behind a symlink, so the deadline is the backstop and a miss only costs
// this run's late skills, which the next dispatch picks up.
func (l *Links) WaitSkillLinks(budget time.Duration) {
	l.mu.Lock()
	done := l.publicSkillsDone
	l.mu.Unlock()
	if done == nil {
		return
	}
	select {
	case <-done:
	case <-time.After(budget):
		slog.Warn("org-fs skill links still syncing; starting the run without them",
			"waited", budget)
	}
}

// skillSet is one directory to scan for `<skill>/SKILL.md` children, with the
// name its copies are prefixed by.
type skillSet struct {
	name string
	dir  string
}

// Mount paths under `org/` that are not skill sets: the org home (linked, not
// copied — the agent writes skills there and they must sync back), and the two
// hidden per-thread volumes.
var nonSkillVolumeDirs = map[string]bool{
	"home": true, ".outputs": true, ".uploads": true,
}

// skillSetRoots is every directory whose children are candidate skills: the
// read-only public sets (`org/public/<set>`) plus each repo-sync volume
// (`org/<volume>`). Synced volumes are read off the live mount list rather than
// by listing `org/` — a stray local dir there is not a mount and must not be
// scanned. Reads `ActiveMounts` rather than `mountsOrWait`: this runs after the
// mounts are already up (the public ReadDir above only succeeds through one), so
// paying the grace wait here would only stall the retry path.
func (l *Links) skillSetRoots() []skillSet {
	orgRoot := filepath.Join(l.AppRoot, "org")
	var out []skillSet
	if sets, err := os.ReadDir(filepath.Join(orgRoot, "public")); err == nil {
		for _, set := range sets {
			if !set.IsDir() || !safeSegment.MatchString(set.Name()) {
				continue
			}
			out = append(out, skillSet{set.Name(), filepath.Join(orgRoot, "public", set.Name())})
		}
	}
	for _, m := range l.ActiveMounts() {
		name := filepath.Base(m.MountPath)
		if filepath.Dir(m.MountPath) != orgRoot || nonSkillVolumeDirs[name] {
			continue
		}
		if !safeSegment.MatchString(name) {
			continue
		}
		out = append(out, skillSet{name, m.MountPath})
	}
	return out
}

// syncPublicSkills copies every read-only set's skills onto the pod's disk under
// `<repoDir>/.claude/skills/`, reporting whether anything landed. Runs without
// `mu`: it touches only the checkout's skills dir and the read-only mounts,
// which no other link path writes.
//
// Copied rather than symlinked — see skillcopy.go for why. The pod therefore
// holds a snapshot for its lifetime, which is what we want: this already ran
// once per boot (`publicSkillsRun` latches on success), and a skill that
// changes underneath a running agent is a hazard, not a feature.
func (l *Links) syncPublicSkills() bool {
	sets := l.skillSetRoots()
	if len(sets) == 0 {
		// No public or synced mount on this pod (older sandbox, or none configured).
		return false
	}
	dir := filepath.Join(l.RepoDir, ".claude", "skills")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		slog.Warn("org-fs public skills copy failed", "err", err)
		return false
	}
	// Ours are cleared first: a set that lost a skill must not leave a stale copy
	// behind, and a partial copy from a previous attempt must not be reused.
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), publicSkillPrefix) {
				os.RemoveAll(filepath.Join(dir, e.Name()))
			}
		}
	}
	gitx.EnsureExclude(l.RepoDir, "/.claude/skills/"+publicSkillPrefix+"*")

	var jobs []skillJob
	unreadable := 0
	for _, set := range sets {
		names := skillDirNames(set.dir)
		if len(names) == 0 {
			continue
		}
		// `stat` is served from the mount's metadata and succeeds on a backend
		// whose GETs hang forever, so a read has to be proven before we commit to
		// copying a whole set off it.
		if !setReads(set.dir, names) {
			unreadable += len(names)
			continue
		}
		for _, name := range names {
			// `<set>-<skill>`: collision-free across sets. Cosmetic — the name the
			// model sees comes from SKILL.md's frontmatter, not the directory.
			jobs = append(jobs, skillJob{
				src: filepath.Join(set.dir, name),
				dst: filepath.Join(dir, publicSkillPrefix+set.name+"-"+name),
			})
		}
	}
	copied := prefetchSkills(jobs)
	slog.Info("org-fs skills prefetched",
		"count", copied, "of", len(jobs), "unreadable", unreadable)
	return copied > 0
}

// repointThreadLink points `org/<linkName>` at `<mountDir>/<threadId>`, creating
// the thread's subtree through the mount. Relative target so the tree survives
// being moved.
func (l *Links) repointThreadLink(threadId, mountDir, linkName string) bool {
	if !safeSegment.MatchString(threadId) {
		slog.Warn("org-fs link skipped: unsafe threadId", "link", linkName, "threadId", threadId)
		return false
	}
	orgRoot := filepath.Join(l.AppRoot, "org")
	volumeMount := filepath.Join(orgRoot, mountDir)
	// Without the mount, MkdirAll would create local dirs that later shadow it.
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
			// A write that lands before the first repoint materializes a REAL
			// `org/output` on ephemeral disk (the fs write route MkdirAlls its
			// parent), which would shadow the mount for the pod's whole life.
			// Empty: safe to replace with the link. Populated: those are agent
			// bytes with nowhere else to live — leave them visible and loud.
			if entries, err := os.ReadDir(link); err != nil || len(entries) > 0 {
				slog.Warn("org-fs link skipped: exists and is not a symlink", "link", link)
				return false
			}
		} else if cur, err := os.Readlink(link); err == nil && cur == target {
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

// AdoptStrayRepoSkills moves skills written into the checkout's
// `.claude/skills/` onto the org mount, where they outlive the pod.
//
// This exists because prose lost. The harness prompt tells the model to author
// skills at the user-scope path (the org mount), and it still wrote
// `<repoDir>/.claude/skills/rubber-duck/` — that dir is where Claude Code's own
// skill-authoring convention points, and a bundled skill's body beats an
// appended system-prompt paragraph. So the destination is enforced after the
// fact instead of asked for: a skill in the checkout dies with the branch, and
// nobody notices until they look for it next week.
//
// Only UNTRACKED dirs move: the repo's own committed skills are the one thing
// that legitimately lives there, and `--exclude-standard` already drops the
// `orgfs-*` symlinks this daemon plants (they are in `.git/info/exclude`).
// Copy-then-remove, not rename — the checkout is local disk and the target is
// FUSE, so a rename is EXDEV.
func (l *Links) AdoptStrayRepoSkills() {
	if l == nil || l.RepoDir == "" || !l.Expected() {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.volumeMounted("home") {
		return
	}
	target := filepath.Join(l.AppRoot, "org", "home", "skills")
	for _, name := range strayRepoSkillDirs(l.RepoDir) {
		src := filepath.Join(l.RepoDir, ".claude", "skills", name)
		dst := filepath.Join(target, name)
		// A same-named org skill wins: it is shared, this one is one run's guess.
		if _, err := os.Lstat(dst); err == nil {
			slog.Warn("stray skill not adopted: name already in the org", "skill", name)
			continue
		}
		if err := os.CopyFS(dst, os.DirFS(src)); err != nil {
			slog.Warn("stray skill adopt failed", "skill", name, "err", err)
			// Leave the source in place — a half-copy on the mount is worse than
			// a skill still sitting in the checkout, and the next run retries.
			os.RemoveAll(dst)
			continue
		}
		if err := os.RemoveAll(src); err != nil {
			slog.Warn("stray skill left in checkout", "skill", name, "err", err)
		}
		slog.Info("stray skill adopted into the org", "skill", name)
	}
}

// strayRepoSkillDirs names the untracked skill directories in the checkout —
// the ones holding a SKILL.md, deduped from git's per-FILE listing.
func strayRepoSkillDirs(repoDir string) []string {
	var names []string
	seen := map[string]bool{}
	for _, p := range gitx.UntrackedUnder(repoDir, ".claude/skills") {
		// `.claude/skills/<name>/...` — anything shallower is not a skill.
		parts := strings.Split(p, "/")
		if len(parts) < 4 {
			continue
		}
		name := parts[2]
		if seen[name] || !safeSegment.MatchString(name) ||
			strings.HasPrefix(name, publicSkillPrefix) {
			continue
		}
		if _, err := os.Stat(filepath.Join(
			repoDir, ".claude", "skills", name, "SKILL.md",
		)); err != nil {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	return names
}
