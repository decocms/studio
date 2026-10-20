package setup

import (
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

// The fingerprint is what decides whether an install is skipped, so what it
// does NOT cover is the contract worth pinning: a dependency added to the
// working tree moves neither the branch head nor the package manager, and the
// step would short-circuit on a package.json it has never read.
func TestFingerprintIgnoresTheWorkingTree(t *testing.T) {
	state := NewInstallState()
	cfg := enriched("bun")
	state.Mark(Fingerprint(cfg, "head-1"), true)

	if !state.IsInstalledFor(cfg, "head-1") {
		t.Fatal("a marked install should read as installed for its own inputs")
	}
	// Same config, same commit: editing package.json in place is invisible here.
	if !state.IsInstalledFor(enriched("bun"), "head-1") {
		t.Fatal("fingerprint should be stable across equal inputs")
	}
	if state.IsInstalledFor(cfg, "head-2") {
		t.Fatal("a new branch head should invalidate the install")
	}
}

// Clear is how a caller that edited the manifest in place gets the install it
// asked for (`setup/install?force=1`).
func TestClearForcesTheNextInstall(t *testing.T) {
	state := NewInstallState()
	cfg := enriched("bun")
	state.Mark(Fingerprint(cfg, "head-1"), true)

	state.Clear()

	if state.IsInstalledFor(cfg, "head-1") {
		t.Fatal("Clear should make the next install run")
	}
}
