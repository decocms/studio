package paths

import (
	"path/filepath"
	"testing"
)

func TestSecondaryRepoRootIsASiblingOfThePrimary(t *testing.T) {
	got := SecondaryRepoRoot("/work/repo")
	if got != "/work/repos" {
		t.Fatalf("want /work/repos, got %s", got)
	}
	// Never inside the primary, or its `git status` grows the other checkouts.
	if filepath.Dir(got) != filepath.Dir("/work/repo") {
		t.Fatalf("secondary root must be a sibling, got %s", got)
	}
}

func TestSecondaryRepoDirStaysUnderTheRoot(t *testing.T) {
	dir, ok := SecondaryRepoDir("/work/repo", "checkout")
	if !ok || dir != "/work/repos/checkout" {
		t.Fatalf("want /work/repos/checkout, got %s (ok=%v)", dir, ok)
	}
}

func TestSecondaryRepoDirRejectsAnEscape(t *testing.T) {
	// `name` arrives over HTTP; validation is not the only thing before this join.
	for _, name := range []string{"", ".", "..", "../evil", "/etc", "a/../.."} {
		if dir, ok := SecondaryRepoDir("/work/repo", name); ok {
			t.Fatalf("name %q must be rejected, got %s", name, dir)
		}
	}
}
