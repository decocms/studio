package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Without a cap, ToolsSync's json.Decoder would stream an unbounded request
// body into memory and could crash the daemon, tearing down the sandbox pod
// on the next missed health probe.
func TestToolsSyncRejectsOversizedBody(t *testing.T) {
	oversized := `{"url":"https://example.com","headers":{"pad":"` +
		strings.Repeat("a", maxToolsSyncBodyBytes) + `"}}`
	req := httptest.NewRequest(http.MethodPost, "/_sandbox/tools/sync", strings.NewReader(oversized))
	rec := httptest.NewRecorder()

	ToolsSync(ToolsDeps{})(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
}

func TestToolsSyncRejectsMissingURL(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/_sandbox/tools/sync", strings.NewReader(`{"headers":{}}`))
	rec := httptest.NewRecorder()

	ToolsSync(ToolsDeps{})(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
}
