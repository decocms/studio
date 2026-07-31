package gitx

import (
	"os"
	"os/exec"
	"testing"
)

// The image already runs as uid 1000, so there is nothing to drop; dropping
// unconditionally would EPERM every git route.
func TestUidDropOnlyWhenRoot(t *testing.T) {
	cmd := exec.Command("git", "status")
	applyUidDrop(cmd)

	isRoot := os.Geteuid() == 0
	hasCredential := cmd.SysProcAttr != nil && cmd.SysProcAttr.Credential != nil
	if hasCredential != isRoot {
		t.Fatalf("euid=%d: credential set=%v, want %v", os.Geteuid(), hasCredential, isRoot)
	}
	if isRoot && cmd.SysProcAttr.Credential.Uid != DecoUID {
		t.Fatalf("dropped to uid %d, want %d", cmd.SysProcAttr.Credential.Uid, DecoUID)
	}
}
