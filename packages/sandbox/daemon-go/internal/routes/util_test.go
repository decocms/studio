package routes

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Without a cap, ConfigUpdate/OrgFsConfig's former io.ReadAll(r.Body) would
// buffer an unbounded request body into memory and could crash the daemon,
// tearing down the sandbox pod on the next missed health probe.
func TestReadLimitedBodyRejectsOversizedRequest(t *testing.T) {
	req := httptest.NewRequest(http.MethodPut, "/_sandbox/config", io.NopCloser(infiniteReader{}))
	_, err := readLimitedBody(req, maxConfigBytes)
	if err == nil {
		t.Fatal("expected readLimitedBody to reject an oversized body, got nil error")
	}
	if !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("expected a size-limit error, got: %v", err)
	}
}
