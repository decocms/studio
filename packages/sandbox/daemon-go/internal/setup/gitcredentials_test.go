package setup

import (
	"os"
	"strings"
	"testing"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

func TestInstallGitCredentialsWritesAConfigEveryGitInThePodReads(t *testing.T) {
	home := t.TempDir()

	hosts, invalid, err := InstallGitCredentials(home, []config.SubmoduleCredential{
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

	cfg, err := os.ReadFile(GitConfigPath(home))
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	// Assert on the bytes git will read, not on the struct that produced them.
	got := string(cfg)
	if strings.Contains(got, "ghs_live_token") {
		t.Fatal("git config carries the token; it belongs only in the store file")
	}
	for _, want := range []string{
		"helper = store --file=" + GitCredentialsStorePath(home),
		"[url \"https://github.com/\"]",
		"insteadOf = git@github.com:",
		"insteadOf = ssh://git@github.com/",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("git config missing %q:\n%s", want, got)
		}
	}

	store, err := os.ReadFile(GitCredentialsStorePath(home))
	if err != nil {
		t.Fatalf("read store: %v", err)
	}
	if string(store) != "https://x-access-token:ghs_live_token@github.com\n" {
		t.Fatalf("store file = %q", string(store))
	}
	info, err := os.Stat(GitCredentialsStorePath(home))
	if err != nil {
		t.Fatalf("stat store: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("store mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestInstallGitCredentialsClearsBothFilesWhenTheLastCredentialIsRemoved(t *testing.T) {
	home := t.TempDir()

	if _, _, err := InstallGitCredentials(home, []config.SubmoduleCredential{
		{Host: "github.com", Token: "ghs_live_token"},
	}); err != nil {
		t.Fatalf("install: %v", err)
	}
	if _, _, err := InstallGitCredentials(home, nil); err != nil {
		t.Fatalf("uninstall: %v", err)
	}

	for _, path := range []string{GitConfigPath(home), GitCredentialsStorePath(home)} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("%s survived the removal (err=%v)", path, err)
		}
	}
}

func TestInstallGitCredentialsRejectsAMalformedHostWithoutWritingIt(t *testing.T) {
	home := t.TempDir()

	hosts, invalid, err := InstallGitCredentials(home, []config.SubmoduleCredential{
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
	if _, err := os.Stat(GitCredentialsStorePath(home)); !os.IsNotExist(err) {
		t.Fatalf("store file written for a rejected host (err=%v)", err)
	}
}
