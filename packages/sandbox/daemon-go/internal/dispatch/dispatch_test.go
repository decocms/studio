package dispatch

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/activity"
)

// A run that produces nothing must still put bytes on the wire — that silence is
// what kills Studio's fetch mid-run. Whitespace, so the result stays parseable
// JSON without the client needing any framing to skip it.
func TestKeepaliveWritesWhitespaceWhileQuiet(t *testing.T) {
	rec := httptest.NewRecorder()
	body := newBodyWriter(rec)

	restore := dispatchHeartbeat
	dispatchHeartbeat = 5 * time.Millisecond
	defer func() { dispatchHeartbeat = restore }()

	ka := &activeRun{done: make(chan struct{})}
	ka.attach(body)
	stop := startKeepalive(context.Background(), ka, "run-1")
	time.Sleep(60 * time.Millisecond)
	stop()
	body.write(terminalFrame("harness_crashed", "boom"))

	// Whatever the keepalive wrote, the whole body still has to parse as one
	// result — that is the entire contract with the client.
	var result struct {
		Chunks []json.RawMessage `json:"chunks"`
		Error  *struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatalf("keepalive broke the JSON body: %v (%q)", err, rec.Body.String())
	}
	if result.Error == nil || result.Error.Code != "harness_crashed" {
		t.Fatalf("error lost: %q", rec.Body.String())
	}
	if !strings.HasPrefix(rec.Body.String(), "\n") {
		t.Fatalf("expected keepalive bytes before the result, got %q", rec.Body.String())
	}
}

// Once the consumer is gone, further writes must be swallowed — never a panic.
func TestBodyWriterSwallowsWritesAfterAFailure(t *testing.T) {
	body := newBodyWriter(&failingWriter{})
	if body.write([]byte("x")) {
		t.Fatal("a failed write must report failure")
	}
	for i := 0; i < 100; i++ {
		if body.write([]byte("x")) {
			t.Fatal("write after failure must report failure, not succeed")
		}
	}
}

// A ResponseWriter whose body write always fails (a hung-up client).
type failingWriter struct{ header http.Header }

func (f *failingWriter) Header() http.Header {
	if f.header == nil {
		f.header = http.Header{}
	}
	return f.header
}
func (f *failingWriter) Write([]byte) (int, error) { return 0, errors.New("client gone") }
func (f *failingWriter) WriteHeader(int)           {}

func TestValidateHarnessInputRejectsEmpty(t *testing.T) {
	if reason := ValidateHarnessInput(json.RawMessage(`{}`)); reason == "" {
		t.Fatal("empty input must be rejected")
	}
	if reason := ValidateHarnessInput(json.RawMessage(`null`)); reason == "" {
		t.Fatal("null input must be rejected")
	}
}

func TestValidateHarnessInputAcceptsMinimalFrame(t *testing.T) {
	input := `{
		"threadId": "t1",
		"userMessage": {"role": "user"},
		"harness": {},
		"workspace": {"cwd": null},
		"models": {"thinking": {"id": "m", "title": "M", "credentialId": "c"}},
		"mcp": {"url": "https://example.com/mcp", "headers": {}, "expiresAt": 123},
		"mode": "default",
		"temperature": 0.5,
		"toolApprovalLevel": "auto",
		"user": {"id": "u", "email": "u@example.com"},
		"organizationId": "org",
		"agent": {"id": "a"}
	}`
	if reason := ValidateHarnessInput(json.RawMessage(input)); reason != "" {
		t.Fatalf("minimal frame rejected: %s", reason)
	}
}

// A task run on the bare `thread:<id>` key mounts /repo with no repo behind it
// yet — it clones one mid-run with TASK_ADD_REPO.
func TestValidateHarnessInputAcceptsRepolessRepoCwd(t *testing.T) {
	frame := func(ws string) json.RawMessage {
		return json.RawMessage(`{
			"threadId": "t1",
			"userMessage": {"role": "user"},
			"harness": {},
			"workspace": ` + ws + `,
			"models": {"thinking": {"id": "m", "title": "M", "credentialId": "c"}},
			"mcp": {"url": "https://example.com/mcp", "headers": {}, "expiresAt": 123},
			"mode": "default",
			"temperature": 0.5,
			"toolApprovalLevel": "auto",
			"user": {"id": "u", "email": "u@example.com"},
			"organizationId": "org",
			"agent": {"id": "a"}
		}`)
	}
	if reason := ValidateHarnessInput(frame(`{"cwd": "/repo", "branch": "b"}`)); reason != "" {
		t.Fatalf("repo-less /repo workspace rejected: %s", reason)
	}
	if reason := ValidateHarnessInput(frame(`{"cwd": "/repo", "branch": "b", "repo": {"owner": "o"}}`)); reason == "" {
		t.Fatal("partial repo must be rejected")
	}
	if reason := ValidateHarnessInput(frame(`{"cwd": "/repo"}`)); reason == "" {
		t.Fatal("missing branch must be rejected")
	}
}

func TestRebaseWorkspaceCwd(t *testing.T) {
	if got := RebaseWorkspaceCwd("/repo", "/work"); got == nil || *got != "/work/repo" {
		t.Fatalf("got %v", got)
	}
	if got := RebaseWorkspaceCwd("/etc", "/work"); got != nil {
		t.Fatalf("non-/repo cwd must map to nil, got %v", *got)
	}
}

// A dispatch for a run that is ALREADY in flight is what Studio sends when the
// pod that owned the run died and another one picked the work up. It must stop
// the run it displaces and wait for it to exit — two harnesses editing one
// checkout is the failure this prevents.
func TestClaimTakesOverAnInFlightRun(t *testing.T) {
	shortSupersedeGrace(t)
	reg := NewRegistry()
	cancelled := make(chan struct{})
	first, waitFirst := claimForTest(reg, "run-1", func() { close(cancelled) })
	waitFirst() // nothing displaced, so this returns immediately

	second, waitSecond := claimForTest(reg, "run-1", func() {})
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("claiming a live run must cancel the run it displaces")
	}

	// The harness must not start while the displaced one may still be writing.
	returned := make(chan struct{})
	go func() { waitSecond(); close(returned) }()
	select {
	case <-returned:
		t.Fatal("takeover returned before the displaced run exited")
	case <-time.After(50 * time.Millisecond):
	}

	reg.release("run-1", first)
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("takeover never proceeded after the displaced run exited")
	}

	// The displaced run must not retire its successor's claim on the way out:
	// a stale delete would leave the live run uncancellable.
	reg.mu.Lock()
	held := reg.activeRuns["run-1"]
	reg.mu.Unlock()
	if held != second {
		t.Fatal("the displaced run cleared the new claim")
	}
}

// Who owns the run decides whose cancel counts. A displaced attempt's
// cancellation is not the RUN's outcome — the successor's is — so the displaced
// handler must be able to tell the two apart and stay silent. Writing a
// "cancelled" terminal from the loser is what settled a live thread as
// `Error: cancelled: run cancelled` in prod on 2026-08-07.
func TestDisplacedReportsOnlyTheLoserOfATakeover(t *testing.T) {
	shortSupersedeGrace(t)
	reg := NewRegistry()
	first, _ := claimForTest(reg, "run-1", func() {})
	if reg.displaced("run-1", first) {
		t.Fatal("the only claimant must not report as displaced")
	}

	second, _ := claimForTest(reg, "run-1", func() {})
	if !reg.displaced("run-1", first) {
		t.Fatal("the run that lost the claim must report as displaced")
	}
	if reg.displaced("run-1", second) {
		t.Fatal("the run that HOLDS the claim must not report as displaced")
	}

	// A cancel with nothing replacing the run (client hangup, DELETE) is the
	// run's real outcome, so it must still write its terminal.
	reg.release("run-1", second)
	solo, _ := claimForTest(reg, "run-2", func() {})
	if reg.displaced("run-2", solo) {
		t.Fatal("an uncontested run must not report as displaced")
	}
}

// The takeover wait is bounded: a displaced run whose process refuses to die
// must not wedge the thread forever.
func TestClaimTakeoverGivesUpAfterTheTimeout(t *testing.T) {
	shortSupersedeGrace(t)
	restore := takeoverTimeout
	takeoverTimeout = 10 * time.Millisecond
	defer func() { takeoverTimeout = restore }()

	reg := NewRegistry()
	claimForTest(reg, "run-1", func() {}) // never released
	_, wait := claimForTest(reg, "run-1", func() {})

	returned := make(chan struct{})
	go func() { wait(); close(returned) }()
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("takeover must give up after takeoverTimeout")
	}
}

// Every run ends with a `done` frame, whatever ended it. That flag is how the
// consumer tells a finished run from a dropped connection — and only the second
// case may be continued somewhere else.
func TestTerminalFrameAlwaysMarksDone(t *testing.T) {
	for _, tc := range []struct {
		name string
		code string
	}{
		{"clean", ""},
		{"crash", "harness_crashed"},
		{"cancelled", "cancelled"},
		{"sandbox gone", sandboxGoneCode},
	} {
		var frame struct {
			Chunks []json.RawMessage `json:"chunks"`
			Done   bool              `json:"done"`
			Error  *struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(terminalFrame(tc.code, "why"), &frame); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if !frame.Done {
			t.Fatalf("%s: terminal frame must be flagged done", tc.name)
		}
		if tc.code == "" && frame.Error != nil {
			t.Fatalf("%s: a clean finish must carry no error", tc.name)
		}
		if tc.code != "" && (frame.Error == nil || frame.Error.Code != tc.code) {
			t.Fatalf("%s: terminal frame lost its reason", tc.name)
		}
	}
}

// A run that is streaming — or quietly keeping the connection alive — is a run
// in use. Without this the operator's idle reaper sees a pod whose last request
// arrived when the dispatch did, and evicts it out from under a live turn.
func TestKeepaliveCountsAsActivity(t *testing.T) {
	restore := dispatchHeartbeat
	dispatchHeartbeat = 5 * time.Millisecond
	defer func() { dispatchHeartbeat = restore }()

	activity.Bump()
	ka := &activeRun{done: make(chan struct{})}
	ka.attach(newBodyWriter(httptest.NewRecorder()))
	stop := startKeepalive(context.Background(), ka, "run-1")
	time.Sleep(200 * time.Millisecond)
	stop()

	if idle := activity.Idle().IdleMs; idle > 100 {
		t.Fatalf("a keepalive tick must count as activity; idle reported %dms", idle)
	}
}

// The discriminator between "a human said stop" and "this pod could not
// finish". Both cancel the run's ctx, and for a long time both reported
// `cancelled` — which Studio reads as a deliberate act and never retries. A pod
// evicted mid-turn therefore killed the turn permanently, with the work sitting
// committed on the branch.
func TestTombstoneMarksOnlyAskedForCancels(t *testing.T) {
	const token = "tkn"
	reg := NewRegistry()
	entry, _ := claimForTest(reg, "run-1", func() {})

	// Shutdown (`CancelAll`) and a dropped connection leave no tombstone: the
	// run is continuable, so it must NOT be reported as cancelled.
	reg.CancelAll()
	if reg.tombstoned("run-1") {
		t.Fatal("a shutdown cancel must not look like an asked-for cancel")
	}
	if reg.displaced("run-1", entry) {
		t.Fatal("nothing took the run over, so it is not superseded either")
	}

	// A DELETE is the asked-for one, and it says so on the registry.
	req := httptest.NewRequest("DELETE", "/runs/run-1", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	reg.HandleCancel(rec, req, func() string { return token })
	if rec.Code != 204 {
		t.Fatalf("cancel returned %d", rec.Code)
	}
	if !reg.tombstoned("run-1") {
		t.Fatal("a DELETE must mark the run as deliberately cancelled")
	}

	// Scoped to the run it named — a sibling run on the same pod is untouched.
	if reg.tombstoned("run-2") {
		t.Fatal("a cancel must not tombstone another run")
	}
}

// An unauthorized DELETE must not be able to turn a continuable failure into a
// permanent one.
func TestUnauthorizedCancelLeavesNoTombstone(t *testing.T) {
	reg := NewRegistry()
	claimForTest(reg, "run-1", func() {})
	rec := httptest.NewRecorder()
	reg.HandleCancel(rec, httptest.NewRequest("DELETE", "/runs/run-1", nil),
		func() string { return "tkn" })
	if rec.Code != 401 {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
	if reg.tombstoned("run-1") {
		t.Fatal("a rejected cancel must not tombstone the run")
	}
}

// An oversized dispatch body must be rejected before it is buffered in full.
func TestDispatchRejectsOversizedBody(t *testing.T) {
	const token = "tkn"
	body := strings.NewReader(strings.Repeat("a", maxDispatchBodyBytes+1))
	req := httptest.NewRequest("POST", "/dispatch", body)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	NewRegistry().HandleDispatch(rec, req, Deps{DaemonToken: func() string { return token }})
	if rec.Code != 413 {
		t.Fatalf("dispatch with oversized body returned %d, want 413", rec.Code)
	}
}

// shortSupersedeGrace keeps the suite fast: every takeover path now waits out
// `supersedeGrace` for the incumbent to hang up first.
func shortSupersedeGrace(t *testing.T) {
	restore := supersedeGrace
	supersedeGrace = 20 * time.Millisecond
	t.Cleanup(func() { supersedeGrace = restore })
}

// claimForTest keeps the pre-reattach ergonomics the takeover tests are written
// against: one call, one fresh run, its cancel.
func claimForTest(reg *Registry, runId string, cancel func()) (*activeRun, func()) {
	entry, _, wait := reg.claimOrAttach(runId, func() (*activeRun, context.CancelFunc) {
		return &activeRun{done: make(chan struct{})}, context.CancelFunc(cancel)
	})
	return entry, wait
}

// attachedRun is a run with a live client, which is what makes a second
// dispatch a takeover rather than a reattach.
func attachedRun(reg *Registry, runId string, cancel func()) (*activeRun, *bodyWriter) {
	entry, _ := claimForTest(reg, runId, cancel)
	sink := newBodyWriter(httptest.NewRecorder())
	entry.attach(sink)
	return entry, sink
}

// The fix this file exists for. A Studio replica is disposable — a rollout or a
// scale-in aborts the request a run streams into — but the run is executing on a
// sandbox pod that is perfectly healthy. Killing it there re-ran whole turns
// from the top (prod, 2026-09-04: a run at seq 52 restarted at seq 23 when
// deco-studio rolled). A lost client must detach, not end the run.
func TestLostClientDetachesInsteadOfEndingTheRun(t *testing.T) {
	reg := NewRegistry()
	cancelled := make(chan struct{})
	entry, sink := attachedRun(reg, "run-1", func() { close(cancelled) })

	entry.detach(sink)
	select {
	case <-cancelled:
		t.Fatal("a client going away must not cancel the run")
	case <-time.After(50 * time.Millisecond):
	}

	// Work produced while nobody is reading has to survive for the successor.
	if !entry.emit([]byte("{\"chunks\":[1]}\n")) {
		t.Fatal("a detached run must keep accepting frames")
	}

	next, fresh, _ := reg.claimOrAttach("run-1", func() (*activeRun, context.CancelFunc) {
		t.Fatal("a detached run must be reattached, not replaced")
		return nil, func() {}
	})
	if fresh || next != entry {
		t.Fatal("the re-dispatch must adopt the running harness")
	}

	rec := httptest.NewRecorder()
	if !next.attach(newBodyWriter(rec)) {
		t.Fatal("attaching to a live run must keep the connection open")
	}
	if got := rec.Body.String(); got != "{\"chunks\":[1]}\n" {
		t.Fatalf("frames buffered while detached must replay; got %q", got)
	}
}

// Reattach must not weaken the guarantee it sits next to: two dispatches BOTH
// holding live connections for one runId is a real double-dispatch, and letting
// both harnesses write one checkout is two agents in one worktree.
func TestALiveClientIsStillTakenOverNotAdopted(t *testing.T) {
	shortSupersedeGrace(t)
	reg := NewRegistry()
	cancelled := make(chan struct{})
	first, _ := attachedRun(reg, "run-1", func() { close(cancelled) })

	second, fresh, _ := reg.claimOrAttach("run-1", func() (*activeRun, context.CancelFunc) {
		return &activeRun{done: make(chan struct{})}, func() {}
	})
	if !fresh || second == first {
		t.Fatal("a run with a live client must be displaced, not adopted")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("the displaced run must be cancelled")
	}
}

// A run can finish in the gap between one client leaving and the next arriving.
// Dropping it there tells the successor the run never existed, and the turn is
// re-executed even though its result was already computed and paid for.
func TestRunFinishedWhileDetachedIsRetainedForTheSuccessor(t *testing.T) {
	reg := NewRegistry()
	entry, sink := attachedRun(reg, "run-1", func() {})
	entry.detach(sink)
	entry.emit(terminalFrame("", ""))
	reg.release("run-1", entry)

	got, fresh, _ := reg.claimOrAttach("run-1", func() (*activeRun, context.CancelFunc) {
		t.Fatal("a finished-but-undelivered run must be replayed, not re-run")
		return nil, func() {}
	})
	if fresh || got != entry {
		t.Fatal("the successor must find the finished run")
	}

	rec := httptest.NewRecorder()
	if got.attach(newBodyWriter(rec)) {
		t.Fatal("attaching to a finished run must report that it is over")
	}
	var frame struct {
		Done bool `json:"done"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(rec.Body.String())), &frame); err != nil {
		t.Fatalf("replayed terminal must parse: %v", err)
	}
	if !frame.Done {
		t.Fatal("the successor must receive the run's terminal frame")
	}
}

// Detaching cannot mean "runs forever with nobody listening": if no replacement
// client arrives, the run is abandoned and must be stopped, which is what keeps
// a detached harness from outliving its consumer.
func TestAbandonedDetachedRunIsCancelledAfterTheGrace(t *testing.T) {
	restore := detachGrace
	detachGrace = 10 * time.Millisecond
	defer func() { detachGrace = restore }()

	reg := NewRegistry()
	cancelled := make(chan struct{})
	entry, sink := attachedRun(reg, "run-1", func() { close(cancelled) })
	entry.detach(sink)

	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("a detached run nobody reattached to must be cancelled")
	}
}

// The case that kept losing work in prod. KEDA scales in the worker holding a
// run; DBOS recovers the workflow and re-dispatches within a second or two —
// faster than the dying pod's TCP close is observed here. The daemon has no
// attach verb, so that reconnect arrives as the same `POST /dispatch` a
// competing turn would, and the only thing separating them was whether the
// previous connection looked open. It did, so a healthy harness was SIGKILLed
// and the turn re-run. There was never a second writer, only a slow-closing
// one.
func TestIncumbentHangingUpDuringTheGraceIsReattachedNotSuperseded(t *testing.T) {
	restore := supersedeGrace
	supersedeGrace = time.Second
	defer func() { supersedeGrace = restore }()

	reg := NewRegistry()
	cancelled := make(chan struct{})
	first, sink := attachedRun(reg, "run-1", func() { close(cancelled) })

	// The incumbent's connection dies just after the re-dispatch arrives.
	go func() {
		time.Sleep(30 * time.Millisecond)
		first.detach(sink)
	}()

	entry, fresh, _ := reg.claimOrAttach("run-1", func() (*activeRun, context.CancelFunc) {
		t.Fatal("a re-dispatch must not displace a run whose client is hanging up")
		return nil, func() {}
	})
	if fresh || entry != first {
		t.Fatal("the reconnect must adopt the running harness")
	}
	select {
	case <-cancelled:
		t.Fatal("the running harness must not be killed for a reconnect")
	case <-time.After(50 * time.Millisecond):
	}
}

// The grace must not become a way for two live writers to share a checkout: an
// incumbent that is genuinely still streaming is still displaced, just later.
func TestIncumbentThatStaysAttachedIsStillSuperseded(t *testing.T) {
	shortSupersedeGrace(t)

	reg := NewRegistry()
	cancelled := make(chan struct{})
	first, _ := attachedRun(reg, "run-1", func() { close(cancelled) })

	entry, fresh, _ := reg.claimOrAttach("run-1", func() (*activeRun, context.CancelFunc) {
		return &activeRun{done: make(chan struct{})}, func() {}
	})
	if !fresh || entry == first {
		t.Fatal("a live incumbent must still be displaced after the grace")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("the displaced run must be cancelled")
	}
}

// A run that finishes inside the grace has nothing left to displace: the
// re-dispatch collects its buffered frames and terminal instead of re-running a
// turn that already completed.
func TestRunFinishingDuringTheGraceIsCollectedNotRestarted(t *testing.T) {
	restore := supersedeGrace
	supersedeGrace = time.Second
	defer func() { supersedeGrace = restore }()

	reg := NewRegistry()
	first, sink := attachedRun(reg, "run-1", func() {})
	go func() {
		time.Sleep(30 * time.Millisecond)
		first.detach(sink)
		first.emit(terminalFrame("", ""))
		reg.release("run-1", first)
	}()

	entry, fresh, _ := reg.claimOrAttach("run-1", func() (*activeRun, context.CancelFunc) {
		t.Fatal("a finished run must be collected, not re-run")
		return nil, func() {}
	})
	if fresh || entry != first {
		t.Fatal("the re-dispatch must find the finished run")
	}
}
