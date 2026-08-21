package orgfs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// A pod with no org-fs at all must not wait for it.
func TestWaitReadyIsImmediateWithoutOrgFs(t *testing.T) {
	l := &Links{AppRoot: t.TempDir()}
	started := time.Now()
	if !l.WaitHomeReady("thread1") {
		t.Fatal("reported not ready with org-fs absent")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("waited %s for a pod with no org-fs", elapsed)
	}
}

// The budget is paid once. A sandbox whose home volume never arrives would
// otherwise stall every dispatch for the full 90s, forever.
func TestWaitReadyPaysItsBudgetOnlyOnce(t *testing.T) {
	appRoot := t.TempDir()
	statusPath := filepath.Join(t.TempDir(), "status.json")
	// org-fs is expected and mounted — but only `.outputs`, never `home`. Skills
	// can never link, so the wait can never succeed.
	outputs := filepath.Join(appRoot, "org", ".outputs")
	if err := os.MkdirAll(outputs, 0o755); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(sidecarStatus{
		Mounts: []Mount{{Volume: ".outputs", MountPath: outputs}},
	})
	if err := os.WriteFile(statusPath, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	l := &Links{AppRoot: appRoot, StatusPath: statusPath, ConfigPath: "unused"}
	// Stand in for the first dispatch having already spent the budget, so the
	// test does not sit here for 90 seconds proving it.
	l.spendReadyBudget()

	started := time.Now()
	if l.WaitHomeReady("thread1") {
		t.Fatal("reported ready with no home mount")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("second dispatch paid the budget again: waited %s", elapsed)
	}
}

// One pod's worth of state: an org-fs root with the home volume mounted, and a
// Claude config dir standing in for the pod's local disk.
func sessionFixture(t *testing.T) (*Links, string) {
	t.Helper()
	appRoot := t.TempDir()
	local := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", local)

	home := filepath.Join(appRoot, "org", "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	statusPath := filepath.Join(t.TempDir(), "status.json")
	raw, _ := json.Marshal(sidecarStatus{
		Mounts: []Mount{{Volume: "home", MountPath: home}},
	})
	if err := os.WriteFile(statusPath, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	return &Links{AppRoot: appRoot, StatusPath: statusPath, ConfigPath: "unused"}, local
}

// Write what a finished turn leaves on local disk: a transcript and the id
// pointing at it.
func writeLocalSession(t *testing.T, local, threadId, sessionId, transcript string) {
	t.Helper()
	dir := filepath.Join(local, "projects", "-app-repo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, sessionId+".jsonl"), []byte(transcript), 0o644); err != nil {
		t.Fatal(err)
	}
	idDir := filepath.Join(local, localSessionDir)
	if err := os.MkdirAll(idDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(idDir, threadId), []byte(sessionId), 0o644); err != nil {
		t.Fatal(err)
	}
}

// The whole point: a turn's session survives the pod that produced it.
func TestSessionSurvivesThePod(t *testing.T) {
	l, local := sessionFixture(t)
	writeLocalSession(t, local, "thread1", "sess-abc", `{"turn":1}`)
	l.SaveSession("thread1")

	// A brand-new pod: same org volume, empty local disk.
	next := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", next)
	l.RestoreSession("thread1")

	id, err := os.ReadFile(filepath.Join(next, localSessionDir, "thread1"))
	if err != nil {
		t.Fatalf("session id not restored: %v", err)
	}
	if string(id) != "sess-abc" {
		t.Fatalf("session id = %q, want sess-abc", id)
	}
	body, err := os.ReadFile(filepath.Join(next, "projects", "-app-repo", "sess-abc.jsonl"))
	if err != nil {
		t.Fatalf("transcript not restored: %v", err)
	}
	if string(body) != `{"turn":1}` {
		t.Fatalf("transcript = %q", body)
	}
}

// A live pod's session is newer than anything stored. Restoring over it would
// rewind the conversation by a turn.
func TestRestoreDoesNotClobberALiveSession(t *testing.T) {
	l, local := sessionFixture(t)
	writeLocalSession(t, local, "thread1", "sess-abc", `{"turn":1}`)
	l.SaveSession("thread1")

	writeLocalSession(t, local, "thread1", "sess-abc", `{"turn":1}{"turn":2}`)
	l.RestoreSession("thread1")

	body, _ := os.ReadFile(filepath.Join(local, "projects", "-app-repo", "sess-abc.jsonl"))
	if string(body) != `{"turn":1}{"turn":2}` {
		t.Fatalf("live transcript was overwritten: %q", body)
	}
}

// An id with no transcript behind it fails every resume, so it must never be
// written. A save that copied nothing leaves the store untouched.
func TestSaveWritesNoIdWithoutATranscript(t *testing.T) {
	l, local := sessionFixture(t)
	idDir := filepath.Join(local, localSessionDir)
	if err := os.MkdirAll(idDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(idDir, "thread1"), []byte("sess-abc"), 0o644); err != nil {
		t.Fatal(err)
	}
	l.SaveSession("thread1")

	store := filepath.Join(l.AppRoot, "org", "home", sessionsDirName, "thread1")
	if _, err := os.Stat(filepath.Join(store, sessionIdName)); err == nil {
		t.Fatal("stored an id with no transcript")
	}
}

// A run that produced no session must not erase the previous turns.
func TestSaveWithNothingLocalKeepsTheStoredSession(t *testing.T) {
	l, local := sessionFixture(t)
	writeLocalSession(t, local, "thread1", "sess-abc", `{"turn":1}`)
	l.SaveSession("thread1")

	empty := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", empty)
	l.SaveSession("thread1")

	store := filepath.Join(l.AppRoot, "org", "home", sessionsDirName, "thread1")
	id, err := os.ReadFile(filepath.Join(store, sessionIdName))
	if err != nil || string(id) != "sess-abc" {
		t.Fatalf("stored session lost: id=%q err=%v", id, err)
	}
}

// Org-fs is where the durability comes from. Without the home volume there is
// nowhere to put a session, and neither direction may leave local state behind.
func TestSessionIsANoOpWithoutTheHomeMount(t *testing.T) {
	local := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", local)
	l := &Links{AppRoot: t.TempDir()} // no StatusPath/ConfigPath: org-fs absent

	writeLocalSession(t, local, "thread1", "sess-abc", `{"turn":1}`)
	l.SaveSession("thread1")
	l.RestoreSession("thread1")

	if _, err := os.Stat(filepath.Join(l.AppRoot, "org", "home", sessionsDirName)); err == nil {
		t.Fatal("wrote a session store with no mount")
	}
}

// Thread ids reach this from a run envelope. A traversing one must not let a
// copy escape the store.
func TestSessionRejectsATraversingThreadId(t *testing.T) {
	l, local := sessionFixture(t)
	writeLocalSession(t, local, "../escape", "sess-abc", `{"turn":1}`)
	l.SaveSession("../escape")

	if _, err := os.Stat(filepath.Join(l.AppRoot, "org", sessionsDirName)); err == nil {
		t.Fatal("a traversing thread id wrote outside the store")
	}
	if _, ok := l.sessionStore("../escape"); ok {
		t.Fatal("resolved a store for a traversing thread id")
	}
}

// A FIFO nobody writes to stands in for the failure this whole file is shaped
// around: an org-fs read that never answers. Unbounded, it parks the dispatch
// before its first byte and Studio declares a healthy pod dead.
func wedged(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(path, 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustReturn(t *testing.T, what string, fn func()) {
	t.Helper()
	prev := sessionIOBudget
	sessionIOBudget = 2 * time.Second
	t.Cleanup(func() { sessionIOBudget = prev })
	done := make(chan struct{})
	go func() { fn(); close(done) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatalf("%s never returned: unbounded org-fs I/O on the dispatch path", what)
	}
}

func TestRestoreGivesUpOnAWedgedIdRead(t *testing.T) {
	l, _ := sessionFixture(t)
	store := filepath.Join(l.AppRoot, "org", "home", sessionsDirName, "thread1")
	wedged(t, filepath.Join(store, sessionIdName))
	mustReturn(t, "RestoreSession", func() { l.RestoreSession("thread1") })
}

func TestSaveGivesUpOnAWedgedStore(t *testing.T) {
	l, local := sessionFixture(t)
	writeLocalSession(t, local, "thread1", "sess-abc", `{"turn":1}`)
	store := filepath.Join(l.AppRoot, "org", "home", sessionsDirName, "thread1")
	// The staging dir is a FIFO, so the copy's first MkdirAll/open blocks.
	wedged(t, filepath.Join(store, projectsStaging))
	mustReturn(t, "SaveSession", func() { l.SaveSession("thread1") })
}

// The invariant the store's id is supposed to carry: it names a transcript that
// exists. `copyTree` returns nil for a tree that listed empty — which is what a
// backend answering a readdir it cannot serve looks like — so success has to be
// verified, not assumed. An id with nothing behind it does not start fresh, it
// FAILS the run ("No conversation found with session ID").
func TestRestoreWritesNoIdWhenTheTranscriptDidNotLand(t *testing.T) {
	l, local := sessionFixture(t)
	store := filepath.Join(l.AppRoot, "org", "home", sessionsDirName, "thread1")
	if err := os.MkdirAll(filepath.Join(store, projectsSubdir, "-app-repo"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store, sessionIdName), []byte("sess-ghost"), 0o644); err != nil {
		t.Fatal(err)
	}
	l.RestoreSession("thread1")
	if id, err := os.ReadFile(filepath.Join(local, localSessionDir, "thread1")); err == nil {
		t.Fatalf("restored id %q with no transcript behind it", id)
	}
}

// One pod serves every thread on its `(user, ref)` key, and they share one
// `projects/` tree. Restoring thread B must not overwrite the transcript thread
// A is live on.
func TestRestoreDoesNotOverwriteAnotherThreadsTranscript(t *testing.T) {
	l, local := sessionFixture(t)
	// Thread B's saved session, stored while its pod also held an older A.
	writeLocalSession(t, local, "threadB", "sess-b", `{"b":1}`)
	writeLocalSession(t, local, "threadA", "sess-a", `{"a":1}`)
	l.SaveSession("threadB")

	// A newer pod: A has run further, B has never run here.
	if err := os.WriteFile(
		filepath.Join(local, "projects", "-app-repo", "sess-a.jsonl"),
		[]byte(`{"a":1}{"a":2}`), 0o644,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(local, localSessionDir, "threadB")); err != nil {
		t.Fatal(err)
	}
	l.RestoreSession("threadB")

	if body, _ := os.ReadFile(filepath.Join(local, "projects", "-app-repo", "sess-a.jsonl")); string(body) != `{"a":1}{"a":2}` {
		t.Fatalf("thread A's live transcript was rewound: %q", body)
	}
	if _, err := os.ReadFile(filepath.Join(local, localSessionDir, "threadB")); err != nil {
		t.Fatalf("thread B was not restored: %v", err)
	}
}

// A wedged read costs the session it was reading and nothing else. Serializing
// flights behind a lock looked safer and was strictly worse: the abandoned
// goroutine never releases it, so every later session on the pod was skipped —
// caught in a live pod, where a perfectly good saved session stopped restoring
// after an unrelated thread's mount hung.
func TestAWedgedTransferDoesNotPoisonTheNextOne(t *testing.T) {
	l, local := sessionFixture(t)
	prev := sessionIOBudget
	sessionIOBudget = 2 * time.Second
	t.Cleanup(func() { sessionIOBudget = prev })

	sessions := filepath.Join(l.AppRoot, "org", "home", sessionsDirName)
	wedged(t, filepath.Join(sessions, "wedged-thread", sessionIdName))
	l.RestoreSession("wedged-thread") // abandoned at the budget, goroutine parked

	writeLocalSession(t, local, "good-thread", "sess-good", `{"turn":1}`)
	l.SaveSession("good-thread")
	next := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", next)
	l.RestoreSession("good-thread")

	id, err := os.ReadFile(filepath.Join(next, localSessionDir, "good-thread"))
	if err != nil || string(id) != "sess-good" {
		t.Fatalf("a healthy session was collateral damage: id=%q err=%v", id, err)
	}
}
