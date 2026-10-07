package setup

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

// RepoSetupScript is a repo-owned hook that runs after the checkout and before
// the dependency install, with the sandbox's configured env in scope.
//
// It exists for credentials a package manager needs BEFORE it can resolve
// anything — a private registry's `.npmrc` being the case that forced it. That
// file cannot be produced by the dev script: a package manager resolves every
// import of a script before executing its first line, so a generator that needs
// the registry to load its own dependencies can never bootstrap one. And Deno
// has no install step at all (see PackageManagers in pm.go), so for a Deno repo
// there is otherwise no point between the clone and `deno task dev` where
// anything of the tenant's can run.
//
// `sh`, deliberately, not a package-manager script: the whole problem is that
// the runtime's own resolution is what fails.
const RepoSetupScript = "decocms.setup.sh"

// SpawnRepoSetup runs {@link RepoSetupScript} if the flag is on and the repo
// ships one. Returns (exitCode, true) when the script ran, (0, false) when
// there was nothing to run.
//
// Gated by `repoSetupScript` in the sandbox config, which Studio sets from an
// organization flag. Deliberately not from `cfg.Env`: that bag is tenant-owned,
// so reading the gate there would let any project grant itself shell on the
// boot path.
//
// The script sees `cfg.Env` — the same bag the install and dev steps get — so a
// token configured in Studio reaches it without a second channel. It does NOT
// see submodule credentials: those stay in a git-only credential file, and
// widening that is a separate decision.
func SpawnRepoSetup(cfg *config.Enriched, repoDir string, onChunk func(data string)) (int, bool) {
	// Nil check before the method: a pod that Studio has not configured yet has
	// no config at all, and that reads as off like any other unset gate.
	if cfg == nil || !cfg.IsRepoSetupScriptEnabled() || repoDir == "" {
		return 0, false
	}
	info, err := os.Stat(filepath.Join(repoDir, filepath.FromSlash(RepoSetupScript)))
	if err != nil || !info.Mode().IsRegular() {
		return 0, false
	}
	// `sh <path>`, not an exec of the file: a repo that commits the script
	// without the executable bit is the common case, and git on a fresh clone
	// preserves whatever mode was committed.
	cmd := fmt.Sprintf("cd %s && sh %s", repoDir, RepoSetupScript)
	onChunk("\r\n$ " + cmd + "\r\n")
	env := map[string]string{}
	for k, v := range cfg.Env {
		env[k] = v
	}
	return SpawnStep(cmd, onChunk, env), true
}
