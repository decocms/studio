package orgfs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// An org-fs root whose status file reports the given volumes as mounted.
func memoryFixture(t *testing.T, volumes ...string) (*Links, string) {
	t.Helper()
	appRoot := t.TempDir()
	statusPath := filepath.Join(t.TempDir(), "status.json")
	var mounts []Mount
	for _, volume := range volumes {
		path := filepath.Join(appRoot, "org", volume)
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
		mounts = append(mounts, Mount{Volume: volume, MountPath: path})
	}
	raw, _ := json.Marshal(sidecarStatus{Mounts: mounts})
	if err := os.WriteFile(statusPath, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	l := &Links{AppRoot: appRoot, StatusPath: statusPath, ConfigPath: "unused"}
	return l, filepath.Join(appRoot, "org", "home")
}

func TestMemoryDirResolvesOntoTheMountedHome(t *testing.T) {
	l, home := memoryFixture(t, "home")
	want := filepath.Join(home, "users", "user_1")
	if got := l.MemoryDir("users/user_1"); got != want {
		t.Fatalf("MemoryDir = %q, want %q", got, want)
	}
	if info, err := os.Stat(want); err != nil || !info.IsDir() {
		t.Fatalf("the folder was not created: %v", err)
	}
}

func TestMemoryDirKeepsMembersApart(t *testing.T) {
	l, _ := memoryFixture(t, "home")
	one, other := l.MemoryDir("users/user_1"), l.MemoryDir("users/user_2")
	if one == "" || other == "" || one == other {
		t.Fatalf("two members resolved to %q and %q", one, other)
	}
}

func TestMemoryDirReadsAnExistingIndex(t *testing.T) {
	l, home := memoryFixture(t, "home")
	dir := filepath.Join(home, "users", "user_1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, memoryIndexName), []byte("# User memory\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := l.MemoryDir("users/user_1"); got != dir {
		t.Fatalf("MemoryDir = %q, want %q", got, dir)
	}
}

// A mount point directory exists even when its mount failed, so only the
// sidecar's status counts.
func TestMemoryDirIsOffWithoutTheHomeMount(t *testing.T) {
	notMounted, home := memoryFixture(t, ".outputs")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := notMounted.MemoryDir("users/user_1"); got != "" {
		t.Fatalf("resolved %q with home unmounted", got)
	}
	if _, err := os.Stat(filepath.Join(home, "users")); err == nil {
		t.Fatal("wrote a memory folder onto the pod's own disk")
	}

	var absent *Links
	if got := absent.MemoryDir("users/user_1"); got != "" {
		t.Fatalf("a pod without org-fs resolved %q", got)
	}
	if got := (&Links{AppRoot: t.TempDir()}).MemoryDir("users/user_1"); got != "" {
		t.Fatalf("a pod with no status file resolved %q", got)
	}
}

func TestMemoryDirRefusesPathsOutsideHome(t *testing.T) {
	l, home := memoryFixture(t, "home")
	for _, directory := range []string{
		"", ".", "..", "../.outputs", "users/../..", "users/../../repo",
		"/etc", home, filepath.Join(home, "users", "user_1"),
	} {
		if got := l.MemoryDir(directory); got != "" {
			t.Errorf("MemoryDir(%q) = %q, want off", directory, got)
		}
	}
}

func TestMemoryDirIsOffWhenTheFolderCannotBeCreated(t *testing.T) {
	l, home := memoryFixture(t, "home")
	if err := os.WriteFile(filepath.Join(home, "users"), []byte("not a folder"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := l.MemoryDir("users/user_1"); got != "" {
		t.Fatalf("resolved %q under a file", got)
	}
}

// A wedged org-fs blocks a read without end; the run must go on without memory.
func TestMemoryDirGivesUpOnAnIndexThatNeverAnswers(t *testing.T) {
	l, home := memoryFixture(t, "home")
	dir := filepath.Join(home, "users", "user_1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(dir, memoryIndexName), 0o644); err != nil {
		t.Skipf("no fifo on this filesystem: %v", err)
	}
	prev := memoryProbeBudget
	memoryProbeBudget = 50 * time.Millisecond
	t.Cleanup(func() { memoryProbeBudget = prev })

	started := time.Now()
	if got := l.MemoryDir("users/user_1"); got != "" {
		t.Fatalf("resolved %q on a folder that never answered", got)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("waited %s past the budget", elapsed)
	}
}
