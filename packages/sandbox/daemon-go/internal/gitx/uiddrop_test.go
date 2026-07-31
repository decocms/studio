package gitx

import (
	"os"
	"os/exec"
	"testing"
)

// The sandbox image runs `USER sandbox` (uid 1000) with no k8s runAsUser
// override, so the daemon is already uid 1000 and there is nothing to drop.
// Dropping unconditionally would EPERM every git route — the guard is what
// keeps this a no-op rather than a landmine.
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
