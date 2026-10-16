package dispatch

// Live messages: a person's message delivered into the turn that is running,
// instead of queued behind it (POST /_sandbox/runs/{runId}/messages).
//
// Wire, on top of runner.go's: a run whose input sets `liveMessages` keeps the
// runner's stdin open after the envelope, which is then newline-terminated, and
// each message is one `{"liveMessage":{"id","text"}}` line. The runner answers
// each with a `{"liveMessageAck":{"id","accepted"}}` stdout line, which is not
// forwarded. The HTTP answer waits for that ack: `accepted:false` means the turn
// had already decided to finish, and Studio queues the message as the next turn
// instead. Answering before the ack would let a message reach a runner that is
// exiting and be lost after Studio was told it arrived.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/activity"
	"github.com/decocms/studio/sandbox-daemon/internal/auth"
)

// Cap on one message's request body. A chat message, not a file upload.
const maxLiveMessageBytes = 256 * 1024

// Cap on message ids one run remembers, delivered or waiting. The set is what
// makes a retried POST a no-op, and it lives in the pod for the run's length.
const maxLiveMessagesPerRun = 256

const maxLiveMessageIdLen = 200

// How long a POST waits for the runner's ack. The runner answers from its stdin
// reader, independent of the turn, so this only expires on a wedged runner.
// Variable only so the test can shorten it.
var liveMessageAckTimeout = 30 * time.Second

type liveDelivery struct {
	done     chan struct{}
	accepted bool
}

// liveMessages is one run's channel into its runner.
type liveMessages struct {
	// writeMu serializes writes into the runner's stdin and is held by close,
	// so no write lands after it: a kept runner's stdin carries the next turn's
	// envelope next.
	writeMu   sync.Mutex
	mu        sync.Mutex
	w         io.Writer
	pending   map[string]*liveDelivery
	delivered map[string]bool
}

func newLiveMessages() *liveMessages {
	return &liveMessages{pending: map[string]*liveDelivery{}, delivered: map[string]bool{}}
}

// open points the channel at the stdin of the runner now running this turn.
func (l *liveMessages) open(w io.Writer) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.w = w
}

// close ends delivery: the runner is done with this turn. Every message still
// waiting for its ack is refused.
func (l *liveMessages) close() {
	l.writeMu.Lock()
	defer l.writeMu.Unlock()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.w = nil
	for id, d := range l.pending {
		delete(l.pending, id)
		close(d.done)
	}
}

func (l *liveMessages) ack(id string, accepted bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	d := l.pending[id]
	if d == nil {
		return
	}
	delete(l.pending, id)
	d.accepted = accepted
	if accepted {
		l.delivered[id] = true
	}
	close(d.done)
}

type deliveryResult int

const (
	deliveryAccepted deliveryResult = iota
	deliveryDuplicate
	// The runner refused: its turn is finishing.
	deliveryRefused
	// No runner is reading this run's messages.
	deliveryNoSession
	deliveryFull
	deliveryTimeout
)

func (r deliveryResult) String() string {
	return [...]string{"accepted", "duplicate", "refused", "no_session", "full", "timeout"}[r]
}

var errChannelClosed = errors.New("live message channel closed")

// deliver writes the message to the runner and waits for its ack. A message
// already accepted is not written again; one still waiting shares the wait.
func (l *liveMessages) deliver(ctx context.Context, id, text string) deliveryResult {
	l.mu.Lock()
	if l.delivered[id] {
		l.mu.Unlock()
		return deliveryDuplicate
	}
	d := l.pending[id]
	fresh := d == nil
	if fresh {
		if l.w == nil {
			l.mu.Unlock()
			return deliveryNoSession
		}
		if len(l.delivered)+len(l.pending) >= maxLiveMessagesPerRun {
			l.mu.Unlock()
			return deliveryFull
		}
		d = &liveDelivery{done: make(chan struct{})}
		l.pending[id] = d
	}
	l.mu.Unlock()

	if fresh {
		line, _ := json.Marshal(map[string]any{
			"liveMessage": map[string]string{"id": id, "text": text},
		})
		if err := l.write(append(line, '\n')); err != nil {
			l.ack(id, false)
			return deliveryNoSession
		}
	}

	timer := time.NewTimer(liveMessageAckTimeout)
	defer timer.Stop()
	select {
	case <-d.done:
		if d.accepted {
			return deliveryAccepted
		}
		return deliveryRefused
	case <-timer.C:
		return deliveryTimeout
	case <-ctx.Done():
		return deliveryTimeout
	}
}

// write sends one line to the runner, unless the channel closed meanwhile.
func (l *liveMessages) write(line []byte) error {
	l.writeMu.Lock()
	defer l.writeMu.Unlock()
	l.mu.Lock()
	w := l.w
	l.mu.Unlock()
	if w == nil {
		return errChannelClosed
	}
	_, err := w.Write(line)
	return err
}

// liveMessageAck recognizes the runner's ack line. The substring check keeps a
// second JSON parse off every frame, some of which are megabytes of tool output.
func liveMessageAck(line []byte) (id string, accepted bool, ok bool) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 || line[0] != '{' || !bytes.Contains(line, []byte(`"liveMessageAck"`)) {
		return "", false, false
	}
	var probe struct {
		Ack *struct {
			ID       string `json:"id"`
			Accepted bool   `json:"accepted"`
		} `json:"liveMessageAck"`
	}
	if json.Unmarshal(line, &probe) != nil || probe.Ack == nil || probe.Ack.ID == "" {
		return "", false, false
	}
	return probe.Ack.ID, probe.Ack.Accepted, true
}

// HandleLiveMessage delivers a user message into the run's live turn.
//
//	200 {"delivered":true}            the runner accepted it
//	200 {"delivered":true,"duplicate":true}  accepted earlier under this id
//	409 {"error":"no_live_run"}       no run under this id in this pod
//	409 {"error":"live_messages_off"} the run was dispatched without them
//	409 {"error":"no_live_session"}   no runner is reading (starting or ended)
//	409 {"error":"turn_finishing"}    the runner refused: its turn is ending
//	429 {"error":"too_many_messages"}
//	504 {"error":"ack_timeout"}
func (reg *Registry) HandleLiveMessage(w http.ResponseWriter, r *http.Request, tokenFn func() string) {
	if !auth.TokenOK(r, tokenFn()) {
		jsonError(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	runId := r.PathValue("runId")
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxLiveMessageBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			jsonError(w, 413, map[string]string{"error": "body_too_large"})
			return
		}
		jsonError(w, 400, map[string]string{"error": "bad_json"})
		return
	}
	var msg struct {
		ID   string `json:"id"`
		Text string `json:"text"`
	}
	if json.Unmarshal(body, &msg) != nil {
		jsonError(w, 400, map[string]string{"error": "bad_json"})
		return
	}
	if msg.ID == "" || len(msg.ID) > maxLiveMessageIdLen || strings.TrimSpace(msg.Text) == "" {
		jsonError(w, 400, map[string]string{"error": "bad_message"})
		return
	}

	reg.mu.Lock()
	entry := reg.activeRuns[runId]
	reg.mu.Unlock()
	if entry == nil {
		jsonError(w, 409, map[string]string{"error": "no_live_run"})
		return
	}
	if entry.live == nil {
		jsonError(w, 409, map[string]string{"error": "live_messages_off"})
		return
	}
	activity.Bump()
	result := entry.live.deliver(r.Context(), msg.ID, msg.Text)
	slog.Info("dispatch live message", "harness", entry.harness, "run_id", runId,
		"result", result.String(), "bytes", len(msg.Text))
	switch result {
	case deliveryAccepted:
		writeJSON(w, 200, map[string]any{"delivered": true})
	case deliveryDuplicate:
		writeJSON(w, 200, map[string]any{"delivered": true, "duplicate": true})
	case deliveryRefused:
		jsonError(w, 409, map[string]string{"error": "turn_finishing"})
	case deliveryNoSession:
		jsonError(w, 409, map[string]string{"error": "no_live_session"})
	case deliveryFull:
		jsonError(w, 429, map[string]string{"error": "too_many_messages"})
	default:
		jsonError(w, 504, map[string]string{"error": "ack_timeout"})
	}
}

func writeJSON(w http.ResponseWriter, status int, body map[string]any) {
	data, _ := json.Marshal(body)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)
	w.Write(data)
}
