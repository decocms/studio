package docker

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
	"github.com/decocms/studio/packages/sandbox/controller-go/runtime"
)

var ctx = context.Background()

func codeOf(err error) protocol.ErrorCode {
	code, _ := runtime.CodeOf(err)
	return code
}

func TestNewRequiresADefaultImage(t *testing.T) {
	for _, images := range []map[string]string{nil, {"android": "a:1"}, {"default": "d:1", "android": " "}} {
		if _, err := New(Deps{}, Config{Images: images}); err == nil {
			t.Errorf("images %v accepted", images)
		}
	}
}

func TestProbe(t *testing.T) {
	h := newHarness(t, Config{})
	if ok, reason := h.runner.Probe(ctx); !ok || reason != "" {
		t.Fatalf("up: ok=%v reason=%q", ok, reason)
	}
	h.engine.down = true
	ok, reason := h.runner.Probe(ctx)
	if ok || !strings.HasPrefix(reason, "Cannot connect to the Docker daemon") || strings.Contains(reason, "\n") {
		t.Fatalf("down: ok=%v reason=%q", ok, reason)
	}
	h.runner.exec = func(context.Context, Command) (Result, error) {
		return Result{}, errors.New("docker CLI not found on PATH")
	}
	if ok, reason := h.runner.Probe(ctx); ok || reason != "docker CLI not found on PATH" {
		t.Fatalf("no CLI: ok=%v reason=%q", ok, reason)
	}
}

func TestEnsureProvisions(t *testing.T) {
	h := newHarness(t, Config{Memory: "2g", CPUs: "1", Labels: map[string]string{"sandbox.deco.cx/test": "1"}})
	opts := protocol.EnsureOptions{
		Repo:            &protocol.EnsureRepo{CloneURL: "https://x-access-token:tok@github.com/acme/site.git", UserName: "Ana", UserEmail: "ana@acme.dev"},
		Env:             map[string]string{"FOO": "bar", "DAEMON_TOKEN": "shadow"},
		OrgFsConfigJSON: `{"k":1}`,
	}
	sb, err := h.runner.Ensure(ctx, testID, "sb-1", opts)
	if err != nil {
		t.Fatal(err)
	}
	daemonURL := "http://127.0.0.1:" + h.engine.daemonPort
	if sb.Daemon.URL != daemonURL || sb.Daemon.Token != strings.Repeat("a", 64) || *sb.PreviewURL != daemonURL+"/" || sb.Workdir != "/app" {
		t.Fatalf("sandbox = %+v", sb)
	}
	if sb.Image != (protocol.Image{Requested: "default", Served: "default"}) {
		t.Fatalf("image = %+v", sb.Image)
	}

	runs := h.engine.runs()
	if len(runs) != 1 {
		t.Fatalf("runs = %d", len(runs))
	}
	args := strings.Join(runs[0].Args, " ")
	for _, want := range []string{
		"--name sb-1", "--publish 127.0.0.1::9000", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
		"--memory 2g --memory-swap 2g", "--cpus 1",
		"--label sandbox.deco.cx/runtime=docker", "--label sandbox.deco.cx/handle=sb-1", "--label sandbox.deco.cx/test=1",
		"--env DAEMON_TOKEN", "--env FOO",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("run args lack %q: %s", want, args)
		}
	}
	if runs[0].Args[len(runs[0].Args)-1] != "studio-sandbox:1" {
		t.Errorf("image = %s", runs[0].Args[len(runs[0].Args)-1])
	}
	if strings.Contains(args, "aaaa") {
		t.Errorf("the token is on argv: %s", args)
	}
	if runs[0].Env["DAEMON_TOKEN"] != strings.Repeat("a", 64) || runs[0].Env["FOO"] != "bar" || runs[0].Env["PROXY_PORT"] != "9000" || runs[0].Env["APP_ROOT"] != "/app" {
		t.Errorf("env = %v", runs[0].Env)
	}

	call := h.daemon.lastConfig(t)
	if call.bearer != strings.Repeat("a", 64) || !strings.Contains(call.body, `"cloneUrl":"https://x-access-token:tok@github.com/acme/site.git"`) {
		t.Errorf("config = %+v", call)
	}
	if len(h.daemon.orgFs) != 1 || h.daemon.orgFs[0] != `{"k":1}` {
		t.Errorf("org-fs relays = %v", h.daemon.orgFs)
	}
	st := h.persisted()
	if st.Token != strings.Repeat("a", 64) || st.EnsureOpts == nil || st.EnsureOpts.Repo == nil || st.DaemonBootID == "" {
		t.Errorf("row = %+v", st)
	}
	if _, armed := h.runner.deadline("sb-1"); !armed {
		t.Error("no idle timer")
	}
}

func TestEnsureImage(t *testing.T) {
	for _, tc := range []struct {
		requested, ref string
		want           protocol.Image
	}{
		{"", "studio-sandbox:1", protocol.Image{Requested: "default", Served: "default"}},
		{"android", "studio-sandbox-android:1", protocol.Image{Requested: "android", Served: "android"}},
		{"ios", "studio-sandbox:1", protocol.Image{Requested: "ios", Served: "default"}},
	} {
		t.Run(tc.requested, func(t *testing.T) {
			h := newHarness(t, Config{})
			sb, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{SandboxImage: tc.requested})
			if err != nil {
				t.Fatal(err)
			}
			args := h.engine.runs()[0].Args
			if sb.Image != tc.want || args[len(args)-1] != tc.ref || !slices.Contains(args, labelImage+"="+tc.want.Served) {
				t.Fatalf("image = %+v, ran %s", sb.Image, args[len(args)-1])
			}
		})
	}
}

func TestEnsureResumes(t *testing.T) {
	h := newHarness(t, Config{})
	first, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{})
	if err != nil {
		t.Fatal(err)
	}
	h.daemon.bootID = "boot-2"
	second, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{
		Repo: &protocol.EnsureRepo{CloneURL: "https://x-access-token:fresh@github.com/acme/site.git"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(h.engine.runs()) != 1 || second.Daemon != first.Daemon {
		t.Fatalf("runs=%d first=%+v second=%+v", len(h.engine.runs()), first.Daemon, second.Daemon)
	}
	if call := h.daemon.lastConfig(t); call.body != `{"git":{"repository":{"cloneUrl":"https://x-access-token:fresh@github.com/acme/site.git"}}}` {
		t.Errorf("credential refresh = %s", call.body)
	}
	if st := h.persisted(); st.DaemonBootID != "boot-2" {
		t.Errorf("boot id not refreshed: %+v", st)
	}
}

func TestEnsureReplacesADeadContainer(t *testing.T) {
	h := newHarness(t, Config{})
	if _, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{}); err != nil {
		t.Fatal(err)
	}
	c := h.engine.get("sb-1")
	h.engine.mu.Lock()
	c.State.Running, c.State.Status = false, "exited"
	h.engine.mu.Unlock()
	if _, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{}); err != nil {
		t.Fatal(err)
	}
	if len(h.engine.runs()) != 2 || h.engine.ran("container", "rm") != 1 {
		t.Fatalf("runs=%d rms=%d", len(h.engine.runs()), h.engine.ran("container", "rm"))
	}
}

func TestEnsureUnderANewHandleRemovesTheOldContainer(t *testing.T) {
	h := newHarness(t, Config{})
	if _, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.runner.Ensure(ctx, testID, "sb-2", protocol.EnsureOptions{}); err != nil {
		t.Fatal(err)
	}
	if h.engine.get("sb-1") != nil || h.engine.get("sb-2") == nil {
		t.Fatal("old container kept or new one missing")
	}
	if _, armed := h.runner.deadline("sb-1"); armed {
		t.Error("the old handle's timer is still armed")
	}
}

func TestEnsureAdoptsAnUnrecordedContainer(t *testing.T) {
	h := newHarness(t, Config{})
	h.engine.put("sb-1", h.ours("sb-1", strings.Repeat("e", 64)))
	sb, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(h.engine.runs()) != 0 || sb.Daemon.Token != strings.Repeat("e", 64) {
		t.Fatalf("runs=%d daemon=%+v", len(h.engine.runs()), sb.Daemon)
	}
	if st := h.persisted(); st.Token != strings.Repeat("e", 64) {
		t.Fatalf("row = %+v", st)
	}
}

func TestEnsureLeavesAForeignContainerAlone(t *testing.T) {
	h := newHarness(t, Config{})
	foreign := h.ours("sb-1", "t")
	foreign.Config.Labels = map[string]string{}
	h.engine.put("sb-1", foreign)
	_, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{})
	if codeOf(err) != protocol.ErrHandleConflict {
		t.Fatalf("err = %v", err)
	}
	if h.engine.get("sb-1") == nil || h.engine.ran("container", "stop") != 0 {
		t.Fatal("a container this runtime did not create was touched")
	}
}

func TestEnsureFailures(t *testing.T) {
	t.Run("a rejected bootstrap removes the container", func(t *testing.T) {
		h := newHarness(t, Config{})
		h.daemon.reject = true
		_, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{CloneOnly: true})
		var re *runtime.Error
		if !errors.As(err, &re) || re.Code != protocol.ErrBootstrapRejected || re.Status != 401 {
			t.Fatalf("err = %v", err)
		}
		if h.engine.get("sb-1") != nil {
			t.Fatal("container kept")
		}
		if rec, _ := h.store.Get(ctx, testID, Name); rec != nil {
			t.Fatal("row written")
		}
	})
	t.Run("a container that exits says how, and is removed", func(t *testing.T) {
		h := newHarness(t, Config{})
		exit := int32(2)
		h.engine.exitOnStart = &exit
		_, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{})
		if codeOf(err) != protocol.ErrClaimFailed || !strings.Contains(err.Error(), "(exit 2)") || !strings.Contains(err.Error(), "APP_ROOT not writable") {
			t.Fatalf("err = %v", err)
		}
		if h.engine.get("sb-1") != nil {
			t.Fatal("container kept")
		}
	})
	t.Run("a daemon that never answers is a stall", func(t *testing.T) {
		h := newHarness(t, Config{ReadyWait: 20 * time.Millisecond})
		h.engine.daemonPort = "1"
		_, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{})
		if codeOf(err) != protocol.ErrClaimStalled {
			t.Fatalf("err = %v", err)
		}
		if h.engine.get("sb-1") != nil {
			t.Fatal("container kept")
		}
	})
	t.Run("a failed run is a claim failure with docker's words", func(t *testing.T) {
		h := newHarness(t, Config{})
		h.runner.exec = func(ctx context.Context, cmd Command) (Result, error) {
			if cmd.Args[0] == "run" {
				return Result{Code: 125, Stderr: "Unable to find image 'studio-sandbox:1' locally\npull access denied"}, nil
			}
			return h.engine.exec(ctx, cmd)
		}
		_, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{})
		if codeOf(err) != protocol.ErrClaimFailed || !strings.Contains(err.Error(), "pull access denied") {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestDelete(t *testing.T) {
	h := newHarness(t, Config{StopGrace: 90 * time.Second})
	if _, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := h.runner.Delete(ctx, "sb-1"); err != nil {
		t.Fatal(err)
	}
	if h.engine.ran("container", "stop", "--time", "90", "sb-1") != 1 || h.engine.ran("container", "rm", "--force", "--volumes", "sb-1") != 1 {
		t.Fatalf("calls = %+v", h.engine.calls)
	}
	if rec, _ := h.store.Get(ctx, testID, Name); rec != nil {
		t.Fatal("row kept")
	}
	if _, armed := h.runner.deadline("sb-1"); armed {
		t.Fatal("timer kept")
	}
	if err := h.runner.Delete(ctx, "sb-1"); err != nil {
		t.Fatalf("deleting a gone sandbox: %v", err)
	}
}

func TestDeleteKeepsTheRowWhenTheStopRunsOut(t *testing.T) {
	h := newHarness(t, Config{})
	if _, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{}); err != nil {
		t.Fatal(err)
	}
	h.runner.exec = func(ctx context.Context, cmd Command) (Result, error) {
		if cmd.Args[1] == "stop" {
			return Result{}, context.DeadlineExceeded
		}
		return h.engine.exec(ctx, cmd)
	}
	if err := h.runner.Delete(ctx, "sb-1"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	if rec, _ := h.store.Get(ctx, testID, Name); rec == nil {
		t.Fatal("the row went first; a retry would not route here")
	}
}

func TestAliveAndTermination(t *testing.T) {
	h := newHarness(t, Config{})
	c := h.ours("sb-1", "t")
	c.HostConfig.Memory = 2 << 30
	h.engine.put("sb-1", c)
	alive, err := h.runner.Alive(ctx, "sb-1")
	if err != nil || !alive {
		t.Fatalf("alive=%v err=%v", alive, err)
	}
	if term, _ := h.runner.LastTermination(ctx, "sb-1"); term != nil {
		t.Fatalf("a running container has no termination: %+v", term)
	}
	for _, tc := range []struct {
		oom    bool
		exit   int32
		reason string
	}{{true, 137, "OOMKilled"}, {false, 1, "Error"}, {false, 0, "Completed"}} {
		h.engine.mu.Lock()
		c.State.Running, c.State.Status, c.State.OOMKilled, c.State.ExitCode = false, "exited", tc.oom, tc.exit
		h.engine.mu.Unlock()
		if alive, _ := h.runner.Alive(ctx, "sb-1"); alive {
			t.Fatal("an exited container is alive")
		}
		term, err := h.runner.LastTermination(ctx, "sb-1")
		if err != nil || term == nil || term.Reason != tc.reason || term.OOMKilled != tc.oom || *term.ExitCode != tc.exit || term.MemoryLimit != "2Gi" {
			t.Fatalf("termination = %+v err=%v", term, err)
		}
	}
	h.engine.mu.Lock()
	delete(h.engine.containers, "sb-1")
	h.engine.mu.Unlock()
	if alive, err := h.runner.Alive(ctx, "sb-1"); alive || err != nil {
		t.Fatalf("gone: alive=%v err=%v", alive, err)
	}
	if term, err := h.runner.LastTermination(ctx, "sb-1"); term != nil || err != nil {
		t.Fatalf("gone: termination=%+v err=%v", term, err)
	}
}

func TestQuantity(t *testing.T) {
	for bytes, want := range map[int64]string{2 << 30: "2Gi", 512 << 20: "512Mi", 1536 << 20: "1536Mi", 1000: "1000"} {
		if got := quantity(bytes); got != want {
			t.Errorf("quantity(%d) = %s, want %s", bytes, got, want)
		}
	}
}

func TestDescribe(t *testing.T) {
	h := newHarness(t, Config{})
	if d, err := h.runner.Describe(ctx, "sb-1"); err != nil || d.Daemon != nil {
		t.Fatalf("unrecorded: %+v %v", d, err)
	}
	if _, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{SandboxImage: "android"}); err != nil {
		t.Fatal(err)
	}
	d, err := h.runner.Describe(ctx, "sb-1")
	if err != nil || d.Daemon == nil || d.Daemon.URL != "http://127.0.0.1:"+h.engine.daemonPort || d.Image.Served != "android" || d.PreviewURL == nil {
		t.Fatalf("describe = %+v err=%v", d, err)
	}
	h.engine.mu.Lock()
	delete(h.engine.containers, "sb-1")
	h.engine.mu.Unlock()
	if d, err := h.runner.Describe(ctx, "sb-1"); err != nil || d.Daemon != nil || d.Image == nil {
		t.Fatalf("removed: %+v %v", d, err)
	}
}

func TestLifetime(t *testing.T) {
	h := newHarness(t, Config{IdleTTL: time.Hour})
	now := time.Now()
	h.runner.now = func() time.Time { return now }
	if _, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{}); err != nil {
		t.Fatal(err)
	}
	at := func() time.Time {
		d, ok := h.runner.deadline("sb-1")
		if !ok {
			t.Fatal("no timer")
		}
		return d
	}
	if !at().Equal(now.Add(time.Hour)) {
		t.Fatalf("ensure armed %v", at())
	}
	if err := h.runner.ReleaseAfter(ctx, "sb-1", time.Minute); err != nil || !at().Equal(now.Add(time.Minute)) {
		t.Fatalf("release: %v %v", at(), err)
	}
	if err := h.runner.ReleaseAfter(ctx, "sb-1", 2*time.Minute); err != nil || !at().Equal(now.Add(time.Minute)) {
		t.Fatalf("release moved shutdown later: %v", at())
	}
	if err := h.runner.RenewTTL(ctx, "sb-1"); err != nil || !at().Equal(now.Add(time.Hour)) {
		t.Fatalf("renew: %v %v", at(), err)
	}
	h.runner.now = func() time.Time { return now.Add(-time.Minute) }
	if err := h.runner.RenewTTL(ctx, "sb-1"); err != nil || !at().Equal(now.Add(time.Hour)) {
		t.Fatalf("renew moved shutdown earlier: %v", at())
	}
	h.runner.disarm("sb-1")
	h.engine.mu.Lock()
	delete(h.engine.containers, "sb-1")
	h.engine.mu.Unlock()
	if err := h.runner.RenewTTL(ctx, "sb-1"); err != nil {
		t.Fatal(err)
	}
	if _, armed := h.runner.deadline("sb-1"); armed {
		t.Fatal("renewal armed a gone container")
	}
}

func TestIdleExpiryRemovesTheContainerAndKeepsTheRow(t *testing.T) {
	h := newHarness(t, Config{IdleTTL: 20 * time.Millisecond})
	repo := &protocol.EnsureRepo{CloneURL: "https://x-access-token:old@github.com/acme/site.git", ConnectionID: "conn_1"}
	if _, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{Repo: repo}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for h.engine.get("sb-1") != nil {
		if time.Now().After(deadline) {
			t.Fatal("the idle container was not removed")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if rec, _ := h.store.Get(ctx, testID, Name); rec == nil {
		t.Fatal("the row went with the container; resurrect has nothing to replay")
	}

	h.runner.cfg.IdleTTL = time.Hour
	h.studio.cloneURL = "https://x-access-token:fresh@github.com/acme/site.git"
	revived, err := h.runner.Resurrect(ctx, "sb-1")
	if err != nil || !revived {
		t.Fatalf("resurrect: %v %v", revived, err)
	}
	if !strings.Contains(h.daemon.lastConfig(t).body, "fresh@github.com") {
		t.Fatalf("resurrect replayed the stale credential: %s", h.daemon.lastConfig(t).body)
	}
}

func TestExpiryYieldsToANewerDeadline(t *testing.T) {
	h := newHarness(t, Config{IdleTTL: time.Hour})
	if _, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{}); err != nil {
		t.Fatal(err)
	}
	h.runner.mu.Lock()
	stale := h.runner.idle["sb-1"].gen
	h.runner.mu.Unlock()
	h.runner.arm("sb-1", time.Now().Add(time.Hour))
	h.runner.expire("sb-1", stale)
	if h.engine.get("sb-1") == nil {
		t.Fatal("a superseded expiry removed the container")
	}
}

func TestResurrectWithoutOptions(t *testing.T) {
	h := newHarness(t, Config{})
	if _, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{}); err != nil {
		t.Fatal(err)
	}
	if st := h.persisted(); st.EnsureOpts != nil {
		t.Fatalf("empty options persisted: %+v", st.EnsureOpts)
	}
	if revived, err := h.runner.Resurrect(ctx, "sb-1"); revived || err != nil {
		t.Fatalf("revived=%v err=%v", revived, err)
	}
}

func TestRearmIdle(t *testing.T) {
	h := newHarness(t, Config{Labels: map[string]string{"sandbox.deco.cx/test": "1"}})
	mine := h.ours("sb-1", "t")
	mine.Config.Labels["sandbox.deco.cx/test"] = "1"
	h.engine.put("sb-1", mine)
	h.engine.put("sb-2", h.ours("sb-2", "t"))
	if err := h.runner.RearmIdle(ctx); err != nil {
		t.Fatal(err)
	}
	if _, armed := h.runner.deadline("sb-1"); !armed {
		t.Error("own container not re-armed")
	}
	if _, armed := h.runner.deadline("sb-2"); armed {
		t.Error("another controller's container was armed")
	}
}

func TestRotateCredential(t *testing.T) {
	h := newHarness(t, Config{})
	repo := &protocol.EnsureRepo{CloneURL: "https://x-access-token:old@github.com/acme/site.git"}
	if _, err := h.runner.Ensure(ctx, testID, "sb-1", protocol.EnsureOptions{Repo: repo}); err != nil {
		t.Fatal(err)
	}
	if err := h.runner.RotateCredential(ctx, "sb-1", "https://x-access-token:t@github.com/acme/other.git"); codeOf(err) != protocol.ErrBadRequest {
		t.Fatalf("another repository: %v", err)
	}
	if err := h.runner.RotateCredential(ctx, "sb-9", "https://x-access-token:t@github.com/acme/site.git"); codeOf(err) != protocol.ErrUnknownHandle {
		t.Fatalf("unknown handle: %v", err)
	}
	fresh := "https://x-access-token:new@github.com/acme/site.git"
	if err := h.runner.RotateCredential(ctx, "sb-1", fresh); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(h.daemon.lastConfig(t).body, "new@github.com") || h.persisted().EnsureOpts.Repo.CloneURL != fresh {
		t.Fatalf("not rotated: %s / %+v", h.daemon.lastConfig(t).body, h.persisted().EnsureOpts.Repo)
	}
}

func TestImagesAndWatch(t *testing.T) {
	h := newHarness(t, Config{Images: map[string]string{"default": "d:1", "flutter": "f:1", "android": "a:1"}})
	images, _ := h.runner.Images(ctx)
	if len(images) != 2 || images[0].Name != "android" || images[1].Name != "flutter" {
		t.Fatalf("images = %+v", images)
	}
	phases, _ := h.runner.Watch(ctx, "sb-1")
	var got []protocol.PhaseKind
	for p := range phases {
		got = append(got, p.Kind)
	}
	if !slices.Equal(got, []protocol.PhaseKind{protocol.PhaseReady}) {
		t.Fatalf("phases = %v", got)
	}
}
