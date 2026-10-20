package dispatch

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// A harness that takes live messages: it answers the envelope with one frame,
// then acks each message and echoes its id as a frame. A message whose text is
// "finish" is refused, and the harness exits — a turn that already decided to
// end.
const fakeRunnerLive = "live"

func runLiveFakeHarness() {
	in := bufio.NewReader(os.Stdin)
	if _, err := in.ReadBytes('\n'); err != nil {
		fmt.Println(`{"chunks":[],"error":{"code":"bad_input","message":"no envelope line"}}`)
		return
	}
	fmt.Println(`{"chunks":[{"started":true}]}`)
	for {
		line, err := in.ReadBytes('\n')
		if err != nil {
			return
		}
		var msg struct {
			Live struct {
				ID   string `json:"id"`
				Text string `json:"text"`
			} `json:"liveMessage"`
		}
		if json.Unmarshal(line, &msg) != nil || msg.Live.ID == "" {
			continue
		}
		if msg.Live.Text == "finish" {
			fmt.Printf(`{"liveMessageAck":{"id":%q,"accepted":false}}`+"\n", msg.Live.ID)
			fmt.Println(`{"chunks":[{"finished":true}]}`)
			return
		}
		fmt.Printf(`{"liveMessageAck":{"id":%q,"accepted":true}}`+"\n", msg.Live.ID)
		fmt.Printf(`{"chunks":[{"live":%q}]}`+"\n", msg.Live.ID)
	}
}

// The kept-runner shape of the same: any other line opens a turn, and the
// "finish" message ends it with `turnEnd` instead of exiting.
const fakeRunnerLivePersistent = "live-persistent"

func runLivePersistentFakeHarness() {
	in := bufio.NewReader(os.Stdin)
	for {
		line, err := in.ReadBytes('\n')
		if err != nil {
			return
		}
		var msg struct {
			Live struct {
				ID   string `json:"id"`
				Text string `json:"text"`
			} `json:"liveMessage"`
		}
		if json.Unmarshal(line, &msg) != nil || msg.Live.ID == "" {
			fmt.Printf(`{"chunks":[{"pid":%d}]}`+"\n", os.Getpid())
			continue
		}
		if msg.Live.Text == "finish" {
			fmt.Printf(`{"liveMessageAck":{"id":%q,"accepted":false}}`+"\n", msg.Live.ID)
			fmt.Println(`{"chunks":[],"turnEnd":true}`)
			continue
		}
		fmt.Printf(`{"liveMessageAck":{"id":%q,"accepted":true}}`+"\n", msg.Live.ID)
		fmt.Printf(`{"chunks":[{"live":%q}]}`+"\n", msg.Live.ID)
	}
}

// liveRun starts the live fake harness and returns once its first frame is in.
func liveRun(t *testing.T) (*liveMessages, func() []string, <-chan error) {
	t.Helper()
	t.Setenv(fakeRunnerEnv, fakeRunnerLive)
	live := newLiveMessages()
	var mu sync.Mutex
	var frames []string
	started := make(chan struct{})
	var once sync.Once
	done := make(chan error, 1)
	go func() {
		_, err := RunHarness(context.Background(), fakeHarnessArgv(), "claude-code",
			json.RawMessage(`{"threadId":"t-1","liveMessages":true}`), nil,
			func(frame []byte) bool {
				mu.Lock()
				frames = append(frames, string(frame))
				mu.Unlock()
				once.Do(func() { close(started) })
				return true
			}, live)
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("the harness never started")
	}
	return live, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), frames...)
	}, done
}

func TestLiveMessageReachesTheRunningHarness(t *testing.T) {
	live, frames, done := liveRun(t)
	if got := live.deliver(context.Background(), "m1", "also check the tests"); got != deliveryAccepted {
		t.Fatalf("deliver = %d, want accepted", got)
	}
	// A retried POST is answered from memory, not written to the runner again.
	if got := live.deliver(context.Background(), "m1", "also check the tests"); got != deliveryDuplicate {
		t.Fatalf("redeliver = %d, want duplicate", got)
	}
	if got := live.deliver(context.Background(), "m2", "finish"); got != deliveryRefused {
		t.Fatalf("deliver to a finishing turn = %d, want refused", got)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	// The run is over: nothing reads its messages any more.
	if got := live.deliver(context.Background(), "m3", "too late"); got != deliveryNoSession {
		t.Fatalf("deliver after the run = %d, want no session", got)
	}
	got := strings.Join(frames(), "\n")
	if strings.Count(got, `"live":"m1"`) != 1 {
		t.Fatalf("m1 did not reach the harness exactly once:\n%s", got)
	}
	if strings.Contains(got, "liveMessageAck") {
		t.Fatalf("an ack was forwarded as a frame:\n%s", got)
	}
}

func TestRunWithoutLiveMessagesStillClosesStdin(t *testing.T) {
	// The default path: the harness reads stdin to EOF, so it must be closed.
	frames, err := runFake(t, fakeRunnerOK, context.Background(), nil)
	if err != nil || len(frames) != 1 {
		t.Fatalf("frames=%d err=%v", len(frames), err)
	}
}

func TestLiveMessageAckIsRecognizedOnlyAtTopLevel(t *testing.T) {
	if id, accepted, ok := liveMessageAck([]byte(`{"liveMessageAck":{"id":"m","accepted":true}}` + "\n")); !ok || id != "m" || !accepted {
		t.Fatalf("ack not recognized: %q %v %v", id, accepted, ok)
	}
	// Tool output that merely mentions the key is a frame, not an ack.
	if _, _, ok := liveMessageAck([]byte(`{"chunks":[{"text":"\"liveMessageAck\""}]}`)); ok {
		t.Fatal("a frame mentioning the key was taken for an ack")
	}
}

func TestLiveMessageRouteRefusesWhatItCannotDeliver(t *testing.T) {
	reg := NewRegistry()
	token := func() string { return "tok" }
	post := func(runId, auth, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/_sandbox/runs/"+runId+"/messages", strings.NewReader(body))
		req.SetPathValue("runId", runId)
		if auth != "" {
			req.Header.Set("Authorization", "Bearer "+auth)
		}
		rec := httptest.NewRecorder()
		reg.HandleLiveMessage(rec, req, token)
		return rec
	}
	body := `{"id":"m1","text":"hi"}`

	if rec := post("r1", "", body); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no bearer: %d", rec.Code)
	}
	if rec := post("r1", "tok", `{"id":"m1","text":"  "}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("blank text: %d", rec.Code)
	}
	if rec := post("r1", "tok", `{"id":"m1","text":"`+strings.Repeat("x", maxLiveMessageBytes)+`"}`); rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized: %d", rec.Code)
	}
	if rec := post("r1", "tok", body); rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "no_live_run") {
		t.Fatalf("unknown run: %d %s", rec.Code, rec.Body)
	}

	reg.mu.Lock()
	reg.activeRuns["plain"] = &activeRun{done: make(chan struct{}), harness: "claude-code"}
	reg.activeRuns["starting"] = &activeRun{done: make(chan struct{}), harness: "claude-code", live: newLiveMessages()}
	reg.mu.Unlock()
	if rec := post("plain", "tok", body); rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "live_messages_off") {
		t.Fatalf("run without live messages: %d %s", rec.Code, rec.Body)
	}
	// Claimed, but no runner reads its stdin yet.
	if rec := post("starting", "tok", body); rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "no_live_session") {
		t.Fatalf("run with no runner: %d %s", rec.Code, rec.Body)
	}
}

func TestLiveMessagesFollowTheTurnOnAKeptRunner(t *testing.T) {
	t.Setenv(fakeRunnerEnv, fakeRunnerLivePersistent)
	p := &sessionPool{}
	info := RunInfo{ThreadId: "thrd_live", McpExpiresAt: time.Now().Add(time.Hour).UnixMilli(), LiveMessages: true}
	turn := func(live *liveMessages, messages func()) []string {
		var mu sync.Mutex
		var frames []string
		started := make(chan struct{})
		var once sync.Once
		done := make(chan error, 1)
		go func() {
			_, err := p.runSession(context.Background(), fakeHarnessArgv(), "claude-code",
				json.RawMessage(`{}`), map[string]string{}, "", info, "key",
				func(frame []byte) bool {
					mu.Lock()
					frames = append(frames, string(frame))
					mu.Unlock()
					once.Do(func() { close(started) })
					return true
				}, live)
			done <- err
		}()
		<-started
		messages()
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		mu.Lock()
		defer mu.Unlock()
		return frames
	}

	first := newLiveMessages()
	frames := turn(first, func() {
		if got := first.deliver(context.Background(), "m1", "hi"); got != deliveryAccepted {
			t.Fatalf("deliver = %d", got)
		}
		if got := first.deliver(context.Background(), "end1", "finish"); got != deliveryRefused {
			t.Fatalf("finish = %d", got)
		}
	})
	if !strings.Contains(strings.Join(frames, ""), `"live":"m1"`) {
		t.Fatalf("m1 missing from turn 1: %v", frames)
	}
	// Turn 1 is over; its channel must not write into the runner turn 2 owns.
	if got := first.deliver(context.Background(), "m2", "late"); got != deliveryNoSession {
		t.Fatalf("deliver after the turn = %d, want no session", got)
	}

	second := newLiveMessages()
	frames = turn(second, func() {
		if got := second.deliver(context.Background(), "end2", "finish"); got != deliveryRefused {
			t.Fatalf("finish = %d", got)
		}
	})
	if strings.Contains(strings.Join(frames, ""), `"live"`) {
		t.Fatalf("turn 2 received a message it was never sent: %v", frames)
	}
}
