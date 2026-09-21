package setup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

func TestInstallGitCredentialsPointsEveryGitInThePodAtADaemonOwnedConfig(t *testing.T) {
	tmpDir, home := t.TempDir(), t.TempDir()
	t.Setenv("GIT_CONFIG_GLOBAL", "")

	hosts, invalid, err := InstallGitCredentials(tmpDir, home, []config.SubmoduleCredential{
		{Host: "github.com", Token: "ghs_live_token"},
	})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if len(invalid) != 0 {
		t.Fatalf("invalid hosts = %v, want none", invalid)
	}
	if len(hosts) != 1 || hosts[0] != "github.com" {
		t.Fatalf("hosts = %v, want [github.com]", hosts)
	}

	// The env var is how a package manager's git finds this at all, and it must
	// carry the path, never the secret.
	if got := os.Getenv("GIT_CONFIG_GLOBAL"); got != GitConfigPath(tmpDir) {
		t.Fatalf("GIT_CONFIG_GLOBAL = %q, want %q", got, GitConfigPath(tmpDir))
	}

	// Assert on the bytes git will read, not on the struct that produced them.
	cfg, err := os.ReadFile(GitConfigPath(tmpDir))
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	got := string(cfg)
	if strings.Contains(got, "ghs_live_token") {
		t.Fatal("git config carries the token; it belongs only in the store file")
	}
	for _, want := range []string{
		// Without this, GIT_CONFIG_GLOBAL would SHADOW the user's own file and
		// silently undo `gh auth setup-git`.
		"path = " + filepath.Join(home, ".gitconfig"),
		"helper = store --file=" + GitCredentialsStorePath(tmpDir),
		"[url \"https://github.com/\"]",
		"insteadOf = git@github.com:",
		"insteadOf = ssh://git@github.com/",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("git config missing %q:\n%s", want, got)
		}
	}

	store, err := os.ReadFile(GitCredentialsStorePath(tmpDir))
	if err != nil {
		t.Fatalf("read store: %v", err)
	}
	if string(store) != "https://x-access-token:ghs_live_token@github.com\n" {
		t.Fatalf("store file = %q", string(store))
	}
	info, err := os.Stat(GitCredentialsStorePath(tmpDir))
	if err != nil {
		t.Fatalf("stat store: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("store mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestInstallGitCredentialsKeepsEverythingOutOfTheWorkingTreeAndHome(t *testing.T) {
	tmpDir, home := t.TempDir(), t.TempDir()
	t.Setenv("GIT_CONFIG_GLOBAL", "")

	if _, _, err := InstallGitCredentials(tmpDir, home, []config.SubmoduleCredential{
		{Host: "github.com", Token: "ghs_live_token"},
	}); err != nil {
		t.Fatalf("install: %v", err)
	}

	// $HOME is partly linked into a SYNCED org volume, and the repo is a tree a
	// commit could sweep up. Neither may hold a token.
	for _, path := range []string{GitConfigPath(tmpDir), GitCredentialsStorePath(tmpDir)} {
		if strings.HasPrefix(path, home+string(os.PathSeparator)) {
			t.Fatalf("%s is under $HOME", path)
		}
	}
	entries, err := os.ReadDir(home)
	if err != nil {
		t.Fatalf("read home: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("wrote into $HOME: %v", entries)
	}
}

func TestInstallGitCredentialsClearsBothFilesWhenTheLastCredentialIsRemoved(t *testing.T) {
	tmpDir, home := t.TempDir(), t.TempDir()
	t.Setenv("GIT_CONFIG_GLOBAL", "")

	if _, _, err := InstallGitCredentials(tmpDir, home, []config.SubmoduleCredential{
		{Host: "github.com", Token: "ghs_live_token"},
	}); err != nil {
		t.Fatalf("install: %v", err)
	}
	if _, _, err := InstallGitCredentials(tmpDir, home, nil); err != nil {
		t.Fatalf("uninstall: %v", err)
	}

	for _, path := range []string{GitConfigPath(tmpDir), GitCredentialsStorePath(tmpDir)} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("%s survived the removal (err=%v)", path, err)
		}
	}
	// Left set, it would point every git at a file that no longer exists.
	if got := os.Getenv("GIT_CONFIG_GLOBAL"); got != "" {
		t.Fatalf("GIT_CONFIG_GLOBAL = %q, want unset", got)
	}
}

func TestInstallGitCredentialsRejectsAMalformedHostWithoutWritingIt(t *testing.T) {
	tmpDir, home := t.TempDir(), t.TempDir()
	t.Setenv("GIT_CONFIG_GLOBAL", "")

	hosts, invalid, err := InstallGitCredentials(tmpDir, home, []config.SubmoduleCredential{
		{Host: "github.com/somalabs", Token: "ghs_live_token"},
	})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if len(hosts) != 0 {
		t.Fatalf("hosts = %v, want none", hosts)
	}
	if len(invalid) != 1 || invalid[0] != "github.com/somalabs" {
		t.Fatalf("invalid = %v, want [github.com/somalabs]", invalid)
	}
	if _, err := os.Stat(GitCredentialsStorePath(tmpDir)); !os.IsNotExist(err) {
		t.Fatalf("store file written for a rejected host (err=%v)", err)
	}
}

func TestSweepGitCredentialsClearsAFileAKillStranded(t *testing.T) {
	tmpDir := t.TempDir()
	if err := os.WriteFile(GitCredentialsStorePath(tmpDir), []byte("https://x:y@github.com\n"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := SweepGitCredentials(tmpDir); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if _, err := os.Stat(GitCredentialsStorePath(tmpDir)); !os.IsNotExist(err) {
		t.Fatalf("stranded credentials survived the sweep (err=%v)", err)
	}
}
