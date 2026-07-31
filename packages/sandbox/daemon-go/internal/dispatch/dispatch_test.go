package dispatch

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

// Once the consumer is gone, further writes must be swallowed — never a panic,
// never a bogus harness_crashed.
func TestSseWriterGuardsWriteAfterClose(t *testing.T) {
	rec := httptest.NewRecorder()
	sse := newSseWriter(rec)
	if !sse.WriteEvent(map[string]any{"type": "ui-message-chunk", "chunk": 1}) {
		t.Fatal("first write must succeed")
	}
	sse.Close()
	for i := 0; i < 100; i++ {
		if sse.WriteEvent(map[string]any{"type": "ui-message-chunk", "chunk": i}) {
			t.Fatal("write after close must report failure, not succeed")
		}
	}
}

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
