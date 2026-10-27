package proxy

import (
	"net/http/httptest"
	"testing"
)

func TestAppSlugFromRequest(t *testing.T) {
	cases := []struct {
		host, header, want string
	}{
		{"thread-abc.style.dev", "", ""},
		{"thread-abc--apps-checkout.style.dev", "", "apps-checkout"},
		{"thread-abc--apps-checkout.preview.example.com:8443", "", "apps-checkout"},
		{"apps-checkout.localhost:9000", "", "apps-checkout"},
		{"apps-checkout.thread-abc.localhost", "", "apps-checkout"},
		{"localhost:9000", "", ""},
		{"127.0.0.1:9000", "", ""},
		{"thread-abc.style.dev", "Apps-Admin", "apps-admin"},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/", nil)
		r.Host = c.host
		if c.header != "" {
			r.Header.Set(AppSlugHeader, c.header)
		}
		if got := AppSlugFromRequest(r); got != c.want {
			t.Fatalf("AppSlugFromRequest(host=%q header=%q) = %q, want %q", c.host, c.header, got, c.want)
		}
	}
}
