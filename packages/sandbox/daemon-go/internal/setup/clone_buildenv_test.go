package setup

import (
	"reflect"
	"strings"
	"testing"
)

func TestGitStepEnv(t *testing.T) {
	got := GitStepEnv(map[string]string{
		"GIT_CONFIG_COUNT":    "1",
		"GIT_TERMINAL_PROMPT": "1",
		"GIT_ASKPASS":         "/tmp/evil",
	})
	want := map[string]string{
		"GIT_CONFIG_COUNT":    "1",
		"GIT_TERMINAL_PROMPT": "0",
		"GIT_ASKPASS":         "true",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("env = %v, want %v (build env must not re-enable prompts)", got, want)
	}
	if len(gitStepEnv) != 2 {
		t.Fatalf("GitStepEnv mutated the shared base: %v", gitStepEnv)
	}
}

func TestConfiguresGit(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want bool
	}{
		{"no build env", nil, false},
		{"an install-only var does not start a submodule fetch", map[string]string{"NPM_TOKEN": "x"}, false},
		{"a lookalike prefix does not count", map[string]string{"GITHUB_TOKEN": "x", "MY_GIT_VAR": "x"}, false},
		{"git config through env opts in", map[string]string{"NPM_TOKEN": "x", "GIT_CONFIG_COUNT": "1"}, true},
	}
	for _, c := range cases {
		if got := configuresGit(c.env); got != c.want {
			t.Errorf("%s: configuresGit = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestRunPlainSubmoduleUpdate(t *testing.T) {
	t.Run("fetches submodules with no credential helper", func(t *testing.T) {
		var argv []string
		runPlainSubmoduleUpdate(repoWithGitmodules(t), func(string) {},
			func(a []string) int { argv = a; return 0 })
		want := []string{"submodule", "update", "--init", "--recursive", "--depth", "1"}
		if len(argv) < len(want) || !reflect.DeepEqual(argv[len(argv)-len(want):], want) {
			t.Fatalf("argv = %v, want it to end with %v", argv, want)
		}
		if strings.Contains(strings.Join(argv, " "), "credential.helper=store") {
			t.Fatalf("argv names a credentials file that does not exist: %v", argv)
		}
	})

	t.Run("no-ops when the repo declares no submodules", func(t *testing.T) {
		ran := false
		runPlainSubmoduleUpdate(t.TempDir(), func(string) {}, func([]string) int { ran = true; return 0 })
		if ran {
			t.Fatal("ran a submodule fetch without .gitmodules")
		}
	})

	t.Run("a failure warns and does not fail the clone", func(t *testing.T) {
		var out strings.Builder
		runPlainSubmoduleUpdate(repoWithGitmodules(t), sink(&out), func([]string) int { return 128 })
		if !strings.Contains(out.String(), "continuing without submodules") {
			t.Fatalf("output = %q", out.String())
		}
	})
}

func TestSpawnStepArgvEnvReachesTheProcess(t *testing.T) {
	var out strings.Builder
	code := SpawnStepArgv([]string{"sh", "-c", `printf %s "$BUILD_ONLY"`}, sink(&out),
		GitStepEnv(map[string]string{"BUILD_ONLY": "from-build-env"}))
	if code != 0 || out.String() != "from-build-env" {
		t.Fatalf("code = %d, output = %q", code, out.String())
	}
}
