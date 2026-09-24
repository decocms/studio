package store

import (
	"testing"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
)

// Studio's in-process runner locks on the same key (apps/api
// sandbox-runner-state.ts: sha256 of `user\0ref\0agent-sandbox`, first 8 bytes
// as a signed big-endian int64). If the two drift, a mis-drained cutover has
// two unserialized writers rotating one daemon's token.
func TestLockKeyMatchesStudio(t *testing.T) {
	got := LockKey(protocol.SandboxID{UserID: "u_1", ProjectRef: "agent:org:vmcp:main"}, "agent-sandbox")
	if want := int64(-5548940740434667027); got != want {
		t.Fatalf("LockKey = %d, want %d (value computed with node:crypto)", got, want)
	}
}
