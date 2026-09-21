package setup

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

// The configured git credentials, installed where EVERY git process in the pod
// reads them — not just the daemon's own `git submodule update`.
//
// Why a second home for the same tokens: a private dependency is fetched by the
// package manager, not by us. `flutter pub get`, `go mod download`, npm's
// `git+https://` specs and cargo all shell out to their own `git`, long after
// the clone step whose argv carried the credential. Those processes see only
// the ambient config, so a private dep on a host the clone token cannot reach
// 404s however carefully the clone was authenticated.
//
// XDG, not `~/.gitconfig`: git reads BOTH as global scope, so owning this file
// outright (clear-then-write, every boot) leaves `~/.gitconfig` free for the
// user and for whatever `gh auth setup-git` writes into it mid-run. Nothing
// here merges or parses existing config.
//
// ⚠️ SECURITY: this is the deliberate trade in this feature. Unlike the
// submodule fetch's file (see runSubmoduleUpdate), these tokens live for the
// pod's lifetime, because the package manager may run at any point in a
// session. Every process in the pod runs as the same uid, so tenant code can
// read them — as it can already read the clone token off `origin` and
// `$GH_TOKEN` out of its own environment. What 0600 buys is a co-tenant on the
// node, not isolation from in-pod code. The UI says this next to the field.

// GitConfigPath is the git global config the daemon owns, under a given HOME.
func GitConfigPath(home string) string {
	return filepath.Join(home, ".config", "git", "config")
}

// GitCredentialsStorePath is the `git-credential-store` file that config points
// at. Beside the config, not in the repo (never committable, never served).
func GitCredentialsStorePath(home string) string {
	return filepath.Join(home, ".config", "git", "credentials")
}

// renderGitConfig is the file's entire contents: the store helper pointing at
// `credFile`, plus an SSH→HTTPS rewrite per host so a `git@host:` dependency URL
// resolves to something the stored credential applies to. Carries NO token —
// deterministic, and safe to log.
func renderGitConfig(hosts []string, credFile string) string {
	var b strings.Builder
	b.WriteString("# Managed by the deco sandbox daemon. Rewritten on every boot; edits are lost.\n")
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

// InstallGitCredentials writes (or, with no valid credential, removes) the pod's
// git credential config. Returns the hosts it authenticated and the hosts it
// rejected as malformed, so the caller can say which in the boot log — never
// the tokens.
//
// Removal is not a special case but the point: a pod is reused across configs,
// and a credential dropped in the UI has to stop working on the next boot
// rather than linger in a file nothing rewrites.
func InstallGitCredentials(home string, credentials []config.SubmoduleCredential) (hosts, invalidHosts []string, err error) {
	if home == "" {
		return nil, nil, nil
	}
	configPath := GitConfigPath(home)
	credPath := GitCredentialsStorePath(home)

	lines, hosts, invalidHosts := prepareSubmoduleCredentials(credentials)
	if len(hosts) == 0 {
		return nil, invalidHosts, removeBoth(configPath, credPath)
	}

	if err := os.MkdirAll(filepath.Dir(configPath), 0o700); err != nil {
		return nil, invalidHosts, err
	}
	// Remove first: WriteFile's mode applies only when it CREATES the file, so
	// writing over a leftover would inherit that file's permissions.
	os.Remove(credPath)
	if err := os.WriteFile(credPath, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		return nil, invalidHosts, err
	}
	if err := os.WriteFile(configPath, []byte(renderGitConfig(hosts, credPath)), 0o600); err != nil {
		// The store file is already on disk and nothing points at it — clear it
		// rather than strand a live token for a feature that did not turn on.
		os.Remove(credPath)
		return nil, invalidHosts, err
	}
	return hosts, invalidHosts, nil
}

func removeBoth(configPath, credPath string) error {
	var firstErr error
	for _, p := range []string{credPath, configPath} {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
