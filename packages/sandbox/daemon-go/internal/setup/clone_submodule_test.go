package setup

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

func creds(pairs ...string) []config.SubmoduleCredential {
	out := []config.SubmoduleCredential{}
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, config.SubmoduleCredential{Host: pairs[i], Token: pairs[i+1]})
	}
	return out
}

func TestPrepareSubmoduleCredentials(t *testing.T) {
	t.Run("one store-file line per host with a percent-encoded token", func(t *testing.T) {
		lines, hosts, invalid := prepareSubmoduleCredentials(creds("github.com", "ghp_abc"))
		if !reflect.DeepEqual(hosts, []string{"github.com"}) {
			t.Fatalf("hosts = %v", hosts)
		}
		if !reflect.DeepEqual(lines, []string{"https://x-access-token:ghp_abc@github.com"}) {
			t.Fatalf("lines = %v", lines)
		}
		if len(invalid) != 0 {
			t.Fatalf("invalidHosts = %v", invalid)
		}
	})

	t.Run("percent-encodes tokens with URL-unsafe characters", func(t *testing.T) {
		lines, _, _ := prepareSubmoduleCredentials(creds("github.com", "a/b@c:d e"))
		want := "https://x-access-token:a%2Fb%40c%3Ad%20e@github.com"
		if !reflect.DeepEqual(lines, []string{want}) {
			t.Fatalf("lines = %v, want %v", lines, want)
		}
	})

	t.Run("dedupes by host, last token wins", func(t *testing.T) {
		lines, hosts, _ := prepareSubmoduleCredentials(
			creds("github.com", "first", "github.com", "second"),
		)
		if !reflect.DeepEqual(hosts, []string{"github.com"}) {
			t.Fatalf("hosts = %v", hosts)
		}
		if !reflect.DeepEqual(lines, []string{"https://x-access-token:second@github.com"}) {
			t.Fatalf("lines = %v", lines)
		}
	})

	t.Run("rejects hosts with a scheme, path, userinfo, or whitespace", func(t *testing.T) {
		_, hosts, invalid := prepareSubmoduleCredentials(creds(
			"https://github.com", "t",
			"github.com/foo", "t",
			"evil@github.com", "t",
			"git hub.com", "t",
			"github.com:443", "ok",
		))
		// Only the bare host (optionally with a port) survives.
		if !reflect.DeepEqual(hosts, []string{"github.com:443"}) {
			t.Fatalf("hosts = %v", hosts)
		}
		want := []string{"https://github.com", "github.com/foo", "evil@github.com", "git hub.com"}
		if !reflect.DeepEqual(invalid, want) {
			t.Fatalf("invalidHosts = %v, want %v", invalid, want)
		}
	})
}

func TestSubmoduleUpdateArgs(t *testing.T) {
	t.Run("SSH→HTTPS insteadOf rewrites (no token) then the store helper", func(t *testing.T) {
		args := submoduleUpdateArgs([]string{"github.com"}, "/data/submodule-git-credentials")
		want := []string{
			"-c", "url.https://github.com/.insteadOf=git@github.com:",
			"-c", "url.https://github.com/.insteadOf=ssh://git@github.com/",
			"-c", "credential.helper=store --file=/data/submodule-git-credentials",
			"submodule", "update", "--init", "--recursive", "--depth", "1",
		}
		if !reflect.DeepEqual(args, want) {
			t.Fatalf("args = %v, want %v", args, want)
		}
		// The token must never appear in argv — only the credentials file holds it.
		if strings.Contains(strings.Join(args, " "), "x-access-token") {
			t.Fatal("argv leaked the credential username/token")
		}
	})

	t.Run("emits rewrites for every host before the shared helper", func(t *testing.T) {
		args := submoduleUpdateArgs([]string{"github.com", "gitlab.example.com"}, "/data/creds")
		rewrites := 0
		for _, a := range args {
			if strings.HasPrefix(a, "url.") {
				rewrites++
			}
		}
		if rewrites != 4 {
			t.Fatalf("rewrites = %d, want 4", rewrites)
		}
		want := []string{
			"-c", "credential.helper=store --file=/data/creds",
			"submodule", "update", "--init", "--recursive", "--depth", "1",
		}
		if got := args[len(args)-len(want):]; !reflect.DeepEqual(got, want) {
			t.Fatalf("tail = %v, want %v", got, want)
		}
	})
}

func sink(out *strings.Builder) func(string) {
	return func(s string) { out.WriteString(s) }
}

// repoWithGitmodules makes a directory that looks like a checkout declaring
// submodules, without needing git or a network.
func repoWithGitmodules(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".gitmodules"), []byte(
		"[submodule \"vendor/bff\"]\n\tpath = vendor/bff\n\turl = git@github.com:acme/bff.git\n",
	), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestRunSubmoduleUpdate(t *testing.T) {
	t.Run("no-ops when no credentials are configured", func(t *testing.T) {
		ran := false
		var out strings.Builder
		runSubmoduleUpdate(repoWithGitmodules(t), nil, sink(&out),
			func([]string) int { ran = true; return 0 })
		if ran {
			t.Fatal("ran the submodule fetch without credentials")
		}
		if out.String() != "" {
			t.Fatalf("emitted output: %q", out.String())
		}
	})

	t.Run("no-ops when the repo declares no submodules", func(t *testing.T) {
		ran := false
		var out strings.Builder
		runSubmoduleUpdate(t.TempDir(), creds("github.com", "ghp_x"), sink(&out),
			func([]string) int { ran = true; return 0 })
		if ran {
			t.Fatal("ran the submodule fetch without a .gitmodules")
		}
		if strings.Contains(out.String(), "submodule") {
			t.Fatalf("emitted output: %q", out.String())
		}
	})

	t.Run("warns and skips an invalid host without running the fetch", func(t *testing.T) {
		ran := false
		var out strings.Builder
		runSubmoduleUpdate(repoWithGitmodules(t), creds("https://evil.com", "ghp_x"),
			sink(&out), func([]string) int { ran = true; return 0 })
		if ran {
			t.Fatal("ran the submodule fetch with no valid host")
		}
		if !strings.Contains(out.String(), "invalid host") {
			t.Fatalf("missing warning, got %q", out.String())
		}
	})

	t.Run("writes a 0600 credentials file outside the repo and deletes it after", func(t *testing.T) {
		dir := repoWithGitmodules(t)
		credFile := ""
		var out strings.Builder
		runSubmoduleUpdate(dir, creds("github.com", "ghp_secret"), sink(&out),
			func(argv []string) int {
				for _, a := range argv {
					if strings.HasPrefix(a, "credential.helper=store --file=") {
						credFile = strings.TrimPrefix(a, "credential.helper=store --file=")
					}
				}
				if credFile == "" {
					t.Fatal("no store-helper pointer in argv")
				}
				if strings.HasPrefix(credFile, dir) {
					t.Fatalf("credentials file lives inside the repo: %s", credFile)
				}
				info, err := os.Stat(credFile)
				if err != nil {
					t.Fatalf("credentials file missing during the fetch: %v", err)
				}
				if perm := info.Mode().Perm(); perm != 0o600 {
					t.Fatalf("credentials file mode = %o, want 600", perm)
				}
				body, err := os.ReadFile(credFile)
				if err != nil {
					t.Fatal(err)
				}
				if want := "https://x-access-token:ghp_secret@github.com\n"; string(body) != want {
					t.Fatalf("credentials file = %q, want %q", body, want)
				}
				return 0
			})
		if _, err := os.Stat(credFile); !os.IsNotExist(err) {
			t.Fatalf("credentials file survived the run: %v", err)
		}
		if out.String() != "" {
			t.Fatalf("emitted output on success: %q", out.String())
		}
	})

	t.Run("runs against the repo dir and never puts the token in argv", func(t *testing.T) {
		dir := repoWithGitmodules(t)
		var got []string
		runSubmoduleUpdate(dir, creds("github.com", "ghp_secret"), func(string) {},
			func(argv []string) int { got = argv; return 0 })
		joined := strings.Join(got, " ")
		if strings.Contains(joined, "ghp_secret") {
			t.Fatalf("argv leaked the token: %s", joined)
		}
		if !strings.Contains(joined, "-C "+dir) {
			t.Fatalf("argv does not target the repo dir: %s", joined)
		}
		// gitBaseArgv's `-c credential.helper=` must still lead, so the store
		// helper added here is the only one in effect.
		if got[0] != "git" {
			t.Fatalf("argv[0] = %q, want git", got[0])
		}
		if !strings.Contains(joined, "credential.helper= ") {
			t.Fatalf("argv lost the helper reset: %s", joined)
		}
	})

	t.Run("is best-effort: a failing fetch warns instead of propagating", func(t *testing.T) {
		var out strings.Builder
		runSubmoduleUpdate(repoWithGitmodules(t), creds("github.com", "ghp_x"),
			sink(&out), func([]string) int { return 128 })
		if !strings.Contains(out.String(), "submodule update failed (exit 128)") {
			t.Fatalf("missing warning, got %q", out.String())
		}
		if !strings.Contains(out.String(), "continuing without submodules") {
			t.Fatalf("missing best-effort note, got %q", out.String())
		}
	})
}
