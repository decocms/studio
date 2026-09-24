package docker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
	"github.com/decocms/studio/packages/sandbox/controller-go/store/storetest"
)

const testLabel = "sandbox.deco.cx/test"

// TestIntegration runs a real container on the local engine through ensure,
// alive and delete. Opt-in: SANDBOX_DOCKER_IT=1. It builds a throwaway image
// around testdata/fakedaemon, or runs SANDBOX_DOCKER_IT_IMAGE (a sandbox
// image) when set. It removes only what it created, by a label value unique
// to the run and the image tag it built.
func TestIntegration(t *testing.T) {
	if os.Getenv("SANDBOX_DOCKER_IT") != "1" {
		t.Skip("set SANDBOX_DOCKER_IT=1 to run against the local docker engine")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	docker := func(args ...string) string {
		t.Helper()
		out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("docker %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	suffix := make([]byte, 4)
	_, _ = rand.Read(suffix)
	tag := os.Getenv("SANDBOX_DOCKER_IT_IMAGE")
	built := tag == ""
	if built {
		tag = "sandbox-controller-it:" + hex.EncodeToString(suffix)
	}
	handle := "it-" + hex.EncodeToString(suffix)
	// Unique to this run: cleanup must never match anyone else's containers.
	runLabel := "docker-runtime-agent-" + hex.EncodeToString(suffix)
	t.Cleanup(func() {
		ctx := context.Background()
		out, _ := exec.CommandContext(ctx, "docker", "container", "ls", "--all", "--quiet", "--filter", "label="+testLabel+"="+runLabel).Output()
		if ids := strings.Fields(string(out)); len(ids) > 0 {
			_ = exec.CommandContext(ctx, "docker", append([]string{"container", "rm", "--force", "--volumes"}, ids...)...).Run()
		}
		if built {
			_ = exec.CommandContext(ctx, "docker", "image", "rm", "--force", tag).Run()
		}
	})
	if built {
		buildFakeDaemonImage(ctx, t, tag, runLabel)
	}

	st := storetest.NewMemory()
	r, err := New(Deps{Store: st}, Config{
		Images:    map[string]string{"default": tag},
		IdleTTL:   10 * time.Minute,
		StopGrace: 5 * time.Second,
		ReadyWait: 30 * time.Second,
		Memory:    "256m",
		CPUs:      "1",
		Labels:    map[string]string{testLabel: runLabel},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	if ok, reason := r.Probe(ctx); !ok {
		t.Fatalf("probe: %s", reason)
	}
	sb, err := r.Ensure(ctx, testID, handle, protocol.EnsureOptions{CloneOnly: true, Env: map[string]string{"FOO": "bar"}})
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if !strings.HasPrefix(sb.Daemon.URL, "http://127.0.0.1:") {
		t.Fatalf("daemon url = %s", sb.Daemon.URL)
	}
	if binding := docker("container", "port", handle, "9000/tcp"); !strings.HasPrefix(binding, "127.0.0.1:") || strings.Contains(binding, "0.0.0.0") {
		t.Fatalf("daemon port published beyond loopback: %s", binding)
	}
	res, err := http.Get(sb.Daemon.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	var health struct{ Configured bool }
	_ = json.NewDecoder(res.Body).Decode(&health)
	res.Body.Close()
	// The real daemon reports configured only once it has a repository.
	if built && !health.Configured {
		t.Fatal("the daemon never took the /_sandbox/config bootstrap")
	}
	if env := docker("container", "inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", handle); !strings.Contains(env, "FOO=bar") || !strings.Contains(env, "DAEMON_TOKEN="+sb.Daemon.Token) {
		t.Fatalf("container env lacks the boot env:\n%s", env)
	}

	if alive, err := r.Alive(ctx, handle); err != nil || !alive {
		t.Fatalf("alive=%v err=%v", alive, err)
	}
	if term, err := r.LastTermination(ctx, handle); term != nil || err != nil {
		t.Fatalf("termination of a running container: %+v %v", term, err)
	}
	again, err := r.Ensure(ctx, testID, handle, protocol.EnsureOptions{})
	if err != nil || again.Daemon != sb.Daemon {
		t.Fatalf("resume: %+v %v", again, err)
	}

	if err := r.Delete(ctx, handle); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if alive, err := r.Alive(ctx, handle); err != nil || alive {
		t.Fatalf("after delete: alive=%v err=%v", alive, err)
	}
	if c, err := r.inspect(ctx, handle); c != nil || err != nil {
		t.Fatalf("container survived delete: %+v %v", c, err)
	}
	if rec, _ := st.Get(ctx, testID, Name); rec != nil {
		t.Fatal("row survived delete")
	}
}

func buildFakeDaemonImage(ctx context.Context, t *testing.T, tag, runLabel string) {
	run := func(args ...string) string {
		t.Helper()
		out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("docker %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	arch := run("version", "--format", "{{.Server.Arch}}")
	dir := t.TempDir()
	build := exec.CommandContext(ctx, "go", "build", "-o", filepath.Join(dir, "fakedaemon"), "./testdata/fakedaemon")
	build.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS=linux", "GOARCH="+arch)
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fakedaemon: %v\n%s", err, out)
	}
	for _, d := range []string{"app", "tmp", "home/sandbox"} {
		if err := os.MkdirAll(filepath.Join(dir, "root", d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	dockerfile := "FROM scratch\nCOPY --chown=65532:65532 root/ /\nCOPY fakedaemon /fakedaemon\nUSER 65532:65532\nCMD [\"/fakedaemon\"]\n"
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte(dockerfile), 0o644); err != nil {
		t.Fatal(err)
	}
	run("build", "--quiet", "--label", testLabel+"="+runLabel, "--tag", tag, dir)

}
