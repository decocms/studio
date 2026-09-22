package setup

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

func TestInstallGitCredentialsPointsEveryGitInThePodAtADaemonOwnedConfig(t *testing.T) {
	tmpDir, home := t.TempDir(), t.TempDir()
	t.Setenv("GIT_CONFIG_GLOBAL", "")

	got, err := InstallGitCredentials(tmpDir, home, "", []config.SubmoduleCredential{
		{Host: "github.com", Token: "ghs_live_token"},
	})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if len(got.InvalidHosts) != 0 {
		t.Fatalf("invalid hosts = %v, want none", got.InvalidHosts)
	}
	if len(got.Hosts) != 1 || got.Hosts[0] != "github.com" {
		t.Fatalf("hosts = %v, want [github.com]", got.Hosts)
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
	body := string(cfg)
	if strings.Contains(body, "ghs_live_token") {
		t.Fatal("git config carries the token; it belongs only in the store file")
	}
	for _, want := range []string{
		// Without this, GIT_CONFIG_GLOBAL would SHADOW the user's own file.
		"path = " + filepath.Join(home, ".gitconfig"),
		"helper = " + getOnlyStoreHelper(GitCredentialsStorePath(tmpDir)),
		"[url \"https://github.com/\"]",
		"insteadOf = git@github.com:",
		"insteadOf = ssh://git@github.com/",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("git config missing %q:\n%s", want, body)
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

	if _, err := InstallGitCredentials(tmpDir, home, "", []config.SubmoduleCredential{
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

	if _, err := InstallGitCredentials(tmpDir, home, "", []config.SubmoduleCredential{
		{Host: "github.com", Token: "ghs_live_token"},
	}); err != nil {
		t.Fatalf("install: %v", err)
	}
	if _, err := InstallGitCredentials(tmpDir, home, "", nil); err != nil {
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

	got, err := InstallGitCredentials(tmpDir, home, "", []config.SubmoduleCredential{
		{Host: "github.com/somalabs", Token: "ghs_live_token"},
	})
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if len(got.Hosts) != 0 {
		t.Fatalf("hosts = %v, want none", got.Hosts)
	}
	if len(got.InvalidHosts) != 1 || got.InvalidHosts[0] != "github.com/somalabs" {
		t.Fatalf("invalid = %v, want [github.com/somalabs]", got.InvalidHosts)
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

// Regression: a private `git:` dependency on the clone's own host used to need
// `gh auth setup-git`, whose first write is an empty `credential.<url>.helper`
// — which git reads as "discard every helper configured earlier", wiping this
// file's helper out of the very config it lands in. The floor is installed
// here instead so nothing has to run that command.
func TestInstallGitCredentialsFallsBackToTheCloneTokenSoGhAuthSetupGitIsUnnecessary(t *testing.T) {
	tmpDir, home := t.TempDir(), t.TempDir()
	t.Setenv("GIT_CONFIG_GLOBAL", "")

	got, err := InstallGitCredentials(
		tmpDir, home,
		"https://x-access-token:ghs_clone_token@github.com/acme/app.git",
		nil,
	)
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	// Reported apart from Hosts: the boot log has to be able to say this pod is
	// on the clone token, which reaches no other repository.
	if len(got.Hosts) != 0 {
		t.Fatalf("hosts = %v, want none configured", got.Hosts)
	}
	if got.Fallback != "github.com" {
		t.Fatalf("fallback = %q, want github.com", got.Fallback)
	}
	store, err := os.ReadFile(GitCredentialsStorePath(tmpDir))
	if err != nil {
		t.Fatalf("read store: %v", err)
	}
	if string(store) != "https://x-access-token:ghs_clone_token@github.com\n" {
		t.Fatalf("store file = %q", string(store))
	}
}

// `git-credential-store` answers with the FIRST line matching a host, so the
// order decides which token a shared host gets. The org's PAT is the one the
// clone token cannot stand in for.
func TestInstallGitCredentialsPrefersTheConfiguredCredentialOverTheCloneToken(t *testing.T) {
	tmpDir, home := t.TempDir(), t.TempDir()
	t.Setenv("GIT_CONFIG_GLOBAL", "")

	got, err := InstallGitCredentials(
		tmpDir, home,
		"https://x-access-token:ghs_clone_token@github.com/acme/app.git",
		[]config.SubmoduleCredential{{Host: "github.com", Token: "pat_configured"}},
	)
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if len(got.Hosts) != 1 || got.Hosts[0] != "github.com" {
		t.Fatalf("hosts = %v, want [github.com] once, not duplicated", got.Hosts)
	}
	if got.Fallback != "" {
		t.Fatalf("fallback = %q, want none — the host is configured", got.Fallback)
	}
	store, err := os.ReadFile(GitCredentialsStorePath(tmpDir))
	if err != nil {
		t.Fatalf("read store: %v", err)
	}
	if string(store) != "https://x-access-token:pat_configured@github.com\n" {
		t.Fatalf("store file = %q", string(store))
	}
}

// A different host keeps both: the PAT for its host, the clone token for its own.
func TestInstallGitCredentialsKeepsTheCloneTokenAlongsideAnotherHostsPat(t *testing.T) {
	tmpDir, home := t.TempDir(), t.TempDir()
	t.Setenv("GIT_CONFIG_GLOBAL", "")

	got, err := InstallGitCredentials(
		tmpDir, home,
		"https://x-access-token:ghs_clone_token@github.com/acme/app.git",
		[]config.SubmoduleCredential{{Host: "gitlab.com", Token: "pat_configured"}},
	)
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if len(got.Hosts) != 1 || got.Hosts[0] != "gitlab.com" {
		t.Fatalf("hosts = %v, want [gitlab.com]", got.Hosts)
	}
	if got.Fallback != "github.com" {
		t.Fatalf("fallback = %q, want github.com", got.Fallback)
	}
	store, err := os.ReadFile(GitCredentialsStorePath(tmpDir))
	if err != nil {
		t.Fatalf("read store: %v", err)
	}
	want := "https://x-access-token:pat_configured@gitlab.com\n" +
		"https://x-access-token:ghs_clone_token@github.com\n"
	if string(store) != want {
		t.Fatalf("store file = %q, want %q", string(store), want)
	}
}

// An anonymous public clone carries no userinfo — nothing to install, and the
// pair must not be left behind for it.
func TestInstallGitCredentialsIgnoresACloneUrlWithNoToken(t *testing.T) {
	tmpDir, home := t.TempDir(), t.TempDir()
	t.Setenv("GIT_CONFIG_GLOBAL", "")

	got, err := InstallGitCredentials(
		tmpDir, home, "https://github.com/acme/app.git", nil,
	)
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if len(got.Hosts) != 0 || got.Fallback != "" {
		t.Fatalf("installed %+v, want nothing", got)
	}
	if _, err := os.Stat(GitCredentialsStorePath(tmpDir)); !os.IsNotExist(err) {
		t.Fatalf("store file written for an anonymous clone (err=%v)", err)
	}
}

// The regression this file exists for: `git-credential-store`'s `store` REPLACES
// the entry matching protocol+host+username, and git runs it on every
// successful auth. The clone token rides `origin`'s URL under the same
// `x-access-token`@`github.com` key as the org PAT, so before the helper was
// made get-only the first fetch of origin silently overwrote the PAT and every
// later `flutter pub get` 404'd on the private dependency repositories.
//
// Drives real git against the real config, because the bug was entirely in what
// git does with a file whose bytes were already correct.
func TestInstallGitCredentialsSurvivesGitApprovingTheCloneTokenOverIt(t *testing.T) {
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not on PATH")
	}
	tmpDir, home := t.TempDir(), t.TempDir()
	t.Setenv("GIT_CONFIG_GLOBAL", "")

	if _, err := InstallGitCredentials(tmpDir, home, "", []config.SubmoduleCredential{
		{Host: "github.com", Token: "org_pat"},
	}); err != nil {
		t.Fatalf("install: %v", err)
	}

	approve := exec.Command(git, "credential", "approve")
	approve.Env = append(os.Environ(),
		"GIT_CONFIG_GLOBAL="+GitConfigPath(tmpDir),
		"GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_CONFIG_NOSYSTEM=1",
		"HOME="+home,
	)
	approve.Stdin = strings.NewReader(
		"protocol=https\nhost=github.com\nusername=x-access-token\npassword=clone_token\n\n")
	if out, err := approve.CombinedOutput(); err != nil {
		t.Fatalf("git credential approve: %v: %s", err, out)
	}

	store, err := os.ReadFile(GitCredentialsStorePath(tmpDir))
	if err != nil {
		t.Fatalf("read store: %v", err)
	}
	if string(store) != "https://x-access-token:org_pat@github.com\n" {
		t.Fatalf("git overwrote the PAT: store = %q", string(store))
	}

	// And the PAT is still what git hands a private dependency's clone.
	fill := exec.Command(git, "credential", "fill")
	fill.Env = approve.Env
	fill.Stdin = strings.NewReader(
		"protocol=https\nhost=github.com\npath=org/private-dep.git\n\n")
	out, err := fill.Output()
	if err != nil {
		t.Fatalf("git credential fill: %v", err)
	}
	if !strings.Contains(string(out), "password=org_pat") {
		t.Fatalf("git served the wrong credential: %s", out)
	}
}
