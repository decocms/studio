package routes

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

// PUT /_sandbox/config used io.ReadAll with no size limit: an oversized body
// (e.g. an env map with many large values) would be streamed entirely into
// memory before validation ever rejects it.
func TestConfigUpdateRejectsOversizedBody(t *testing.T) {
	oversized := strings.Repeat("a", maxConfigUpdateBodyBytes+1)
	body := `{"env":{"K":"` + oversized + `"}}`

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/_sandbox/config", strings.NewReader(body))
	store := config.NewStore()
	ConfigUpdate(ConfigDeps{Store: store})(rec, req)

	if rec.Code != 400 {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
	if store.Read() != nil {
		t.Fatal("oversized body must not reach the store")
	}
}
