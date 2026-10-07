package setup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

func writeSetupScript(t *testing.T, repoDir, body string) {
	t.Helper()
	// 0o644: a repo that commits the script without the executable bit is the
	// common case, and the hook must still run it.
	if err := os.WriteFile(filepath.Join(repoDir, RepoSetupScript), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func collect(out *strings.Builder) func(string) {
	return func(data string) { out.WriteString(data) }
}

func enabledCfg(env map[string]string) *config.Enriched {
	on := true
	return &config.Enriched{TenantConfig: config.TenantConfig{
		RepoSetupScript: &on,
		Env:             env,
	}}
}

// The hook's whole reason to exist: write a credential file the package manager
// needs before it can resolve anything, from a token that only exists in env.
func TestSpawnRepoSetupWritesFromEnv(t *testing.T) {
	repo := t.TempDir()
	writeSetupScript(t, repo, "printf '_authToken=%s\\n' \"$NPM_TOKEN\" > .npmrc\n")
	cfg := enabledCfg(map[string]string{"NPM_TOKEN": "synthetic-not-a-real-token"})

	var out strings.Builder
	code, ran := SpawnRepoSetup(cfg, repo, collect(&out))
	if !ran || code != 0 {
		t.Fatalf("SpawnRepoSetup = (%d, %v), want (0, true): %s", code, ran, out.String())
	}
	written, err := os.ReadFile(filepath.Join(repo, ".npmrc"))
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(written)); got != "_authToken=synthetic-not-a-real-token" {
		t.Fatalf("script did not see the configured env: %q", got)
	}
}

// Default off. This runs repo-controlled shell on every sandbox's boot path, so
// an org that has not opted in must not execute one — and `nil`, the shape a
// pod carries before Studio has configured it, must read as off too.
func TestSpawnRepoSetupSkippedWhenFlagOff(t *testing.T) {
	repo := t.TempDir()
	writeSetupScript(t, repo, "touch ran-anyway\n")
	off := false

	for name, cfg := range map[string]*config.Enriched{
		"nil config": nil,
		"unset flag": {},
		"false flag": {TenantConfig: config.TenantConfig{RepoSetupScript: &off}},
	} {
		var out strings.Builder
		if code, ran := SpawnRepoSetup(cfg, repo, collect(&out)); ran || code != 0 {
			t.Fatalf("%s: SpawnRepoSetup = (%d, %v), want (0, false)", name, code, ran)
		}
	}
	if _, err := os.Stat(filepath.Join(repo, "ran-anyway")); err == nil {
		t.Fatal("script ran with the flag off")
	}
}

// A repo without the hook is every repo today — the boot must not change.
func TestSpawnRepoSetupSkippedWhenAbsent(t *testing.T) {
	var out strings.Builder
	if code, ran := SpawnRepoSetup(enabledCfg(nil), t.TempDir(), collect(&out)); ran || code != 0 {
		t.Fatalf("SpawnRepoSetup = (%d, %v), want (0, false)", code, ran)
	}
	if out.String() != "" {
		t.Fatalf("absent hook still logged: %q", out.String())
	}
}

// A directory at the hook's path is not a script. Without the regular-file
// check `sh` reports a cryptic read error and the boot fails for a repo that
// never opted in.
func TestSpawnRepoSetupSkippedWhenNotRegularFile(t *testing.T) {
	repo := t.TempDir()
	if err := os.MkdirAll(filepath.Join(repo, RepoSetupScript), 0o755); err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	if code, ran := SpawnRepoSetup(enabledCfg(nil), repo, collect(&out)); ran || code != 0 {
		t.Fatalf("SpawnRepoSetup = (%d, %v), want (0, false)", code, ran)
	}
}

// The exit code reaches the caller, which is what makes the failure fatal to
// the boot instead of surfacing later as a resolution error naming the wrong
// cause.
func TestSpawnRepoSetupPropagatesFailure(t *testing.T) {
	repo := t.TempDir()
	writeSetupScript(t, repo, "echo 'no credentials configured' >&2\nexit 7\n")

	var out strings.Builder
	code, ran := SpawnRepoSetup(enabledCfg(nil), repo, collect(&out))
	if !ran || code != 7 {
		t.Fatalf("SpawnRepoSetup = (%d, %v), want (7, true)", code, ran)
	}
	if !strings.Contains(out.String(), "no credentials configured") {
		t.Fatalf("stderr not streamed to the caller: %q", out.String())
	}
}
