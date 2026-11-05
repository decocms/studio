package setup

import (
	"sync"
	"testing"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

func enriched(pm string) *config.Enriched {
	return &config.Enriched{TenantConfig: config.TenantConfig{
		Application: &config.Application{
			PackageManager: &config.PackageManagerConfig{Name: &pm},
		},
	}}
}

// Why `force` exists: the fingerprint is the package manager, the runtime and
// the branch head, so editing package.json in the working tree moves none of
// it and the install would be skipped on a manifest it has never read.
func TestFingerprintIgnoresTheWorkingTree(t *testing.T) {
	state := NewInstallState()
	cfg := enriched("bun")
	state.Mark(Fingerprint(cfg, "head-1"), true)

	if !state.IsInstalledFor(enriched("bun"), "head-1") {
		t.Fatal("equal config and head should read as installed")
	}
	if state.IsInstalledFor(cfg, "head-2") {
		t.Fatal("a new branch head should invalidate the install")
	}
}

// The force travels with the queued step. Were it applied to InstallState from
// the HTTP goroutine instead, an install finishing in between would re-Mark the
// fingerprint and the queued step would skip — the silent no-op this flag
// exists to prevent.
func TestForceSurvivesAConcurrentMark(t *testing.T) {
	o := &Orchestrator{}
	o.armForce(&o.forceInstall, true)

	NewInstallState().Mark(Fingerprint(enriched("bun"), "head-1"), true)

	if !o.takeForce(&o.forceInstall) {
		t.Fatal("the queued step lost its force")
	}
}

func TestTakeForceIsConsumedOnce(t *testing.T) {
	o := &Orchestrator{}
	o.armForce(&o.forceInstall, true)

	if !o.takeForce(&o.forceInstall) {
		t.Fatal("first read should see the force")
	}
	// A later step must not inherit it.
	if o.takeForce(&o.forceInstall) {
		t.Fatal("force should not survive the step that consumed it")
	}
}

// A plain resume arriving between a forced one and its step must not cancel it.
func TestArmForceNeverLowersTheFlag(t *testing.T) {
	o := &Orchestrator{}
	o.armForce(&o.forceInstall, true)
	o.armForce(&o.forceInstall, false)

	if !o.takeForce(&o.forceInstall) {
		t.Fatal("an unforced resume cleared a pending force")
	}
}

func TestForceFlagsAreIndependentPerStep(t *testing.T) {
	o := &Orchestrator{}
	o.armForce(&o.forceInstall, true)

	if o.takeForce(&o.forceStart) {
		t.Fatal("forcing an install should not force a start")
	}
	if !o.takeForce(&o.forceInstall) {
		t.Fatal("the install force should still be there")
	}
}

// Exactly one caller may act on a force, however many race for it.
func TestTakeForceIsRaceSafe(t *testing.T) {
	o := &Orchestrator{}
	o.armForce(&o.forceInstall, true)

	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	for range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if o.takeForce(&o.forceInstall) {
				mu.Lock()
				wins++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if wins != 1 {
		t.Fatalf("force taken %d times, want exactly 1", wins)
	}
}
