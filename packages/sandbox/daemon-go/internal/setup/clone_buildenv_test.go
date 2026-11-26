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

func TestSpawnStepArgvEnvReachesTheProcess(t *testing.T) {
	var out strings.Builder
	code := SpawnStepArgv([]string{"sh", "-c", `printf %s "$BUILD_ONLY"`}, sink(&out),
		GitStepEnv(map[string]string{"BUILD_ONLY": "from-build-env"}))
	if code != 0 || out.String() != "from-build-env" {
		t.Fatalf("code = %d, output = %q", code, out.String())
	}
}
