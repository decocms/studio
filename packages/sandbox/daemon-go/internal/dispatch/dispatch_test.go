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

	stop := startKeepalive(context.Background(), body, "claude-code", "run-1")
	time.Sleep(60 * time.Millisecond)
	stop()
	body.write(harnessFailure("harness_crashed", "boom"))

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

func TestRebaseWorkspaceCwd(t *testing.T) {
	if got := RebaseWorkspaceCwd("/repo", "/work"); got == nil || *got != "/work/repo" {
		t.Fatalf("got %v", got)
	}
	if got := RebaseWorkspaceCwd("/etc", "/work"); got != nil {
		t.Fatalf("non-/repo cwd must map to nil, got %v", *got)
	}
}

func TestOffloadAllowlistFailsClosed(t *testing.T) {
	if err := AssertAllowedRefUrl("https://s3.example.com/x", nil, false); err == nil {
		t.Fatal("empty allowlist must reject every host")
	}
	if err := AssertAllowedRefUrl("https://s3.example.com/x", []string{"s3.example.com"}, false); err != nil {
		t.Fatalf("allowlisted host rejected: %v", err)
	}
	if err := AssertAllowedRefUrl("http://s3.example.com/x", []string{"s3.example.com"}, false); err == nil {
		t.Fatal("plain http must be rejected outside dev loopback")
	}
	if err := AssertAllowedRefUrl("http://127.0.0.1:9000/x", []string{"127.0.0.1"}, true); err != nil {
		t.Fatalf("dev loopback rejected: %v", err)
	}
}
