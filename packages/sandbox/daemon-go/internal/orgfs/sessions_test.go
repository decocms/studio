package orgfs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

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
