package paths

import (
	"strings"
	"testing"
)

func TestSafePath(t *testing.T) {
	root := "/work"
	base := "/work/repo"
	tests := []struct {
		userPath string
		want     string
		ok       bool
	}{
		{"file.txt", "/work/repo/file.txt", true},
		{"sub/dir/file.txt", "/work/repo/sub/dir/file.txt", true},
		{"../tmp/app/dev", "/work/tmp/app/dev", true},
		{"../..", "", false},
		{"../../etc/passwd", "", false},
		{"/etc/passwd", "", false},
		{"/work/repo/x", "/work/repo/x", true},
		{"/work", "/work", true},
		{"/workspace-sibling/x", "", false},
		{"..", "/work", true},
		{"a/../../..", "", false},
		{"./../repo/./ok", "/work/repo/ok", true},
	}
	for _, tt := range tests {
		got, ok := SafePath(root, base, tt.userPath)
		if ok != tt.ok || got != tt.want {
			t.Errorf("SafePath(%q) = (%q, %v), want (%q, %v)", tt.userPath, got, ok, tt.want, tt.ok)
		}
	}
}

func FuzzSafePathClamp(f *testing.F) {
	for _, seed := range []string{
		"x", "../x", "../../x", "/abs", "a/b/../../../c", "..\\x",
		"..%2f..", "....//", "repo/../../escape", "\x00", "a\x00b",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, userPath string) {
		root := "/work"
		resolved, ok := SafePath(root, "/work/repo", userPath)
		if !ok {
			return
		}
		if resolved != root && !strings.HasPrefix(resolved, root+"/") {
			t.Fatalf("escape: SafePath(%q) = %q", userPath, resolved)
		}
		if strings.Contains(resolved, "/../") || strings.HasSuffix(resolved, "/..") {
			t.Fatalf("unresolved dotdot: SafePath(%q) = %q", userPath, resolved)
		}
	})
}
