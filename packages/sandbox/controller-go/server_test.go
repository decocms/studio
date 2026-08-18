package main

import (
	"net/http"
	"testing"
)

// The insecure opt-out has to actually serve. It booted and then 401'd every
// request once, which made SANDBOX_CONTROLLER_INSECURE=1 useless for local dev
// while still logging that it was serving anonymously.
func TestAuthorized(t *testing.T) {
	req := func(header string) *http.Request {
		r, _ := http.NewRequest(http.MethodGet, "/runtimes", nil)
		if header != "" {
			r.Header.Set("authorization", header)
		}
		return r
	}
	for _, tc := range []struct {
		name   string
		srv    *server
		header string
		want   bool
	}{
		{"insecure serves anonymously", &server{}, "", true},
		{"mTLS trusts the handshake", &server{mTLS: true}, "", true},
		{"bearer accepts the match", &server{bearer: "s3cret"}, "Bearer s3cret", true},
		{"bearer rejects a wrong token", &server{bearer: "s3cret"}, "Bearer nope", false},
		{"bearer rejects a missing header", &server{bearer: "s3cret"}, "", false},
		{"bearer rejects a non-bearer scheme", &server{bearer: "s3cret"}, "Basic s3cret", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.srv.authorized(req(tc.header)); got != tc.want {
				t.Fatalf("authorized = %v, want %v", got, tc.want)
			}
		})
	}
}
