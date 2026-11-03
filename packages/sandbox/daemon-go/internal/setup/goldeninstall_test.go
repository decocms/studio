package setup

import (
	"testing"

	"github.com/decocms/studio/sandbox-daemon/internal/events"
	"github.com/decocms/studio/sandbox-daemon/internal/lifecycle"
)

type silentBroadcaster struct{}

func (silentBroadcaster) BroadcastChunk(string, string, ...events.ChunkOpts) {}
func (silentBroadcaster) Emit(string, any)                                  {}

func goldenOrchestrator() *Orchestrator {
	return &Orchestrator{deps: OrchestratorDeps{
		Broadcaster:  silentBroadcaster{},
		InstallState: NewInstallState(),
		Lifecycle:    lifecycle.New(silentBroadcaster{}),
	}}
}

// The relink is best-effort on an ordinary boot: the restored tree already
// matches the lockfile, so a failure costs nothing and the pipeline goes on.
func TestFailedRelinkIsToleratedOnAPlainInstall(t *testing.T) {
	o := goldenOrchestrator()
	cfg := enriched("bun")

	if !o.finishGoldenInstall(cfg, false, false) {
		t.Fatal("a plain install should survive a failed relink")
	}
	if !o.deps.InstallState.IsInstalledFor(cfg, "") {
		t.Fatal("a plain install should still read as installed")
	}
}

// A forced install is the opposite case: the caller rewrote the manifest in
// the working tree, and the relink is the only thing that fetches what it
// added. Calling that a success starts a dev server on a tree missing the
// package the app being installed imports — and records a fingerprint saying
// it is installed, so nothing retries.
func TestFailedRelinkFailsAForcedInstall(t *testing.T) {
	o := goldenOrchestrator()
	cfg := enriched("bun")

	if o.finishGoldenInstall(cfg, true, false) {
		t.Fatal("a forced install should abort when its relink failed")
	}
	if o.deps.InstallState.IsInstalledFor(cfg, "") {
		t.Fatal("a failed forced install must not mark the fingerprint good")
	}
	if phase := o.deps.Lifecycle.Current().Phase; phase != events.PhaseInstallFailed {
		t.Fatalf("phase = %q, want %q", phase, events.PhaseInstallFailed)
	}
}

// The golden path that works is still the common one.
func TestSuccessfulRelinkMarksTheInstall(t *testing.T) {
	o := goldenOrchestrator()
	cfg := enriched("bun")

	if !o.finishGoldenInstall(cfg, true, true) {
		t.Fatal("a forced install whose relink worked should continue")
	}
	if !o.deps.InstallState.IsInstalledFor(cfg, "") {
		t.Fatal("it should read as installed")
	}
}
