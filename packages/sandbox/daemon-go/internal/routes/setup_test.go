package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// call posts `body` to a Setup handler and returns the status and the `force`
// the resumer saw.
func call(t *testing.T, body string) (int, bool, bool) {
	t.Helper()
	got, called := false, false
	h := Setup("install", func(force bool) {
		got, called = force, true
	})
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest("POST", "/_sandbox/setup/install", nil)
	} else {
		req = httptest.NewRequest("POST", "/_sandbox/setup/install", strings.NewReader(body))
	}
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec.Code, got, called
}

func TestSetupForce(t *testing.T) {
	for _, tc := range []struct {
		name  string
		body  string
		code  int
		force bool
		ran   bool
	}{
		// The pre-force callers send no body at all; they must keep working.
		{"no body", "", 200, false, true},
		{"empty object", `{}`, 200, false, true},
		{"force false", `{"force":false}`, 200, false, true},
		{"force true", `{"force":true}`, 200, true, true},
		// A step that cannot be parsed must not enqueue under a guessed force:
		// resuming install without clearing the fingerprint is the silent
		// no-op this flag exists to avoid.
		{"malformed", `{"force":`, 400, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, force, ran := call(t, tc.body)
			if code != tc.code {
				t.Fatalf("status = %d, want %d", code, tc.code)
			}
			if force != tc.force {
				t.Fatalf("force = %v, want %v", force, tc.force)
			}
			if ran != tc.ran {
				t.Fatalf("resumer called = %v, want %v", ran, tc.ran)
			}
		})
	}
}

func TestSetupRejectsOversizedBody(t *testing.T) {
	big := `{"force":true,"pad":"` + strings.Repeat("x", maxSetupBodyBytes) + `"}`
	code, _, ran := call(t, big)
	if code != 400 {
		t.Fatalf("status = %d, want 400", code)
	}
	if ran {
		t.Fatal("resumer ran on an oversized body")
	}
}
