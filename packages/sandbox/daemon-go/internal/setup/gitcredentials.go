package setup

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

// The configured git credentials, put where EVERY git process in the pod reads
// them — not just the daemon's own `git submodule update`.
//
// Why a second home for the same tokens: a private dependency is fetched by the
// package manager, not by us. `flutter pub get`, `go mod download`, npm's
// `git+https://` specs and cargo all shell out to their own `git`, long after
// the clone step whose argv carried the credential. Those processes see only
// the ambient config, so a private dep on a host the clone token cannot reach
// 404s however carefully the clone was authenticated.
//
// The delivery is `GIT_CONFIG_GLOBAL` on the daemon's own environment, set once
// before the clone. Every spawn path in this daemon builds its child env from
// `os.Environ()` (gitx.Run, SpawnStepArgv, proc.TaskManager, dispatch.Runner),
// so one Setenv reaches install, the dev server, `/exec` and the harness with
// no plumbing — and a package manager's git inherits it like anything else.
//
// Two things it deliberately is NOT:
//
//   - Not in $HOME. Nothing here is in the user's working tree (that is
//     /app/repo, a different tree — it cannot be committed), but $HOME is a
//     surface the org-fs sidecar links parts of into a SYNCED volume. The
//     daemon's own scratch dir is not shared with anything.
//   - Not a token in the environment. `GIT_CONFIG_GLOBAL` carries a PATH. The
//     secret stays in a 0600 file that `git-credential-store` reads, so an
//     `env` dump, a crash report or a child process listing does not spill it.
//
// ⚠️ SECURITY: this is the deliberate trade in this feature. Unlike the
// submodule fetch's file (see runSubmoduleUpdate), these tokens live for the
// pod's lifetime, because the package manager may run at any point in a
// session. Every process in a pod runs as the same uid, so tenant code can read
// them — as it can already read the clone token off `origin` and `$GH_TOKEN`
// out of its own environment. What 0600 buys is a co-tenant on the node, not
// isolation from in-pod code. The UI says this next to the field.

// GitConfigPath is the git config the daemon owns, in its own scratch dir.
func GitConfigPath(tmpDir string) string {
	return filepath.Join(tmpDir, "gitconfig")
}

// GitCredentialsStorePath is the `git-credential-store` file that config points
// at. Beside it, so the boot sweep clears both.
func GitCredentialsStorePath(tmpDir string) string {
	return filepath.Join(tmpDir, "git-credentials")
}

// renderGitConfig is the file's entire contents: the user's own `~/.gitconfig`
// included FIRST (so `gh auth setup-git` and anything an agent configures still
// applies — `GIT_CONFIG_GLOBAL` replaces that file rather than adding to it,
// and a missing include is silently ignored), then the store helper and an
// SSH→HTTPS rewrite per host so a `git@host:` dependency URL resolves to
// something the stored credential applies to.
//
// One consequence of setting GIT_CONFIG_GLOBAL at all: `git config --global`
// inside the pod now WRITES here rather than to `~/.gitconfig`, so what
// `gh auth setup-git` adds holds for the session and is dropped by the next
// rewrite. Both helpers are consulted meanwhile — git tries the list in order —
// so that costs durability, not authentication.
//
// Carries NO token — deterministic, and safe to log.
func renderGitConfig(hosts []string, credFile, home string) string {
	var b strings.Builder
	b.WriteString("# Managed by the deco sandbox daemon. Rewritten on every boot; edits are lost.\n")
	if home != "" {
		b.WriteString("[include]\n")
		b.WriteString("\tpath = " + filepath.Join(home, ".gitconfig") + "\n")
	}
	b.WriteString("[credential]\n")
	b.WriteString("\thelper = store --file=" + credFile + "\n")
	for _, host := range hosts {
		// Quoted subsection: the host is matched case-sensitively and verbatim.
		b.WriteString(fmt.Sprintf("[url \"https://%s/\"]\n", host))
		b.WriteString(fmt.Sprintf("\tinsteadOf = git@%s:\n", host))
		b.WriteString(fmt.Sprintf("\tinsteadOf = ssh://git@%s/\n", host))
	}
	return b.String()
}

// InstallGitCredentials writes the pod's git config and points the daemon's
// environment at it, or — with no valid credential — removes both files and
// unsets the variable, so git falls back to its own defaults. Returns the hosts
// it authenticated and the hosts it rejected as malformed, so the caller can say
// which in the boot log — never the tokens.
//
// Removal is not a special case but the point: a pod is reused across configs,
// and a credential dropped in the UI has to stop working rather than linger in
// a file nothing rewrites.
func InstallGitCredentials(tmpDir, home string, credentials []config.SubmoduleCredential) (hosts, invalidHosts []string, err error) {
	if tmpDir == "" {
		return nil, nil, nil
	}
	configPath := GitConfigPath(tmpDir)
	credPath := GitCredentialsStorePath(tmpDir)

	lines, hosts, invalidHosts := prepareSubmoduleCredentials(credentials)
	if len(hosts) == 0 {
		os.Unsetenv("GIT_CONFIG_GLOBAL")
		return nil, invalidHosts, SweepGitCredentials(tmpDir)
	}

	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return nil, invalidHosts, err
	}
	// Remove first: WriteFile's mode applies only when it CREATES the file, so
	// writing over a leftover would inherit that file's permissions.
	os.Remove(credPath)
	if err := os.WriteFile(credPath, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		return nil, invalidHosts, err
	}
	if err := os.WriteFile(configPath, []byte(renderGitConfig(hosts, credPath, home)), 0o600); err != nil {
		// The store file is on disk and nothing points at it — clear it rather
		// than strand a live token for a feature that did not turn on.
		os.Remove(credPath)
		return nil, invalidHosts, err
	}
	// Last: a child that reads the variable must find a complete file behind it.
	if err := os.Setenv("GIT_CONFIG_GLOBAL", configPath); err != nil {
		return nil, invalidHosts, err
	}
	return hosts, invalidHosts, nil
}

// SweepGitCredentials unlinks the pair. Called on removal, and at boot before
// the orchestrator can run: a SIGKILL or an eviction leaves a live PAT on disk,
// and the next boot rewrites it anyway if the config still asks for it.
func SweepGitCredentials(tmpDir string) error {
	if tmpDir == "" {
		return nil
	}
	var firstErr error
	for _, p := range []string{GitCredentialsStorePath(tmpDir), GitConfigPath(tmpDir)} {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
