package proxy

import (
	"bufio"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestDevServerOrigin(t *testing.T) {
	cases := []struct {
		name, host, origin, want string
		ok                       bool
	}{
		{"same origin becomes localhost", "sbx.style.dev", "https://sbx.style.dev", "http://localhost:3000", true},
		{"host compare ignores case", "SBX.style.dev", "https://sbx.STYLE.dev", "http://localhost:3000", true},
		{"other site keeps its origin", "sbx.style.dev", "https://evil.example", "https://evil.example", true},
		{"sibling preview keeps its origin", "sbx.style.dev", "https://other.style.dev", "https://other.style.dev", true},
		{"port mismatch keeps its origin", "sbx.style.dev", "https://sbx.style.dev:8443", "https://sbx.style.dev:8443", true},
		{"opaque origin is passed through", "sbx.style.dev", "null", "null", true},
		{"no origin sends none", "sbx.style.dev", "", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/_next/webpack-hmr", nil)
			r.Host = c.host
			if c.origin != "" {
				r.Header.Set("Origin", c.origin)
			}
			got, ok := DevServerOrigin(r, 3000)
			if got != c.want || ok != c.ok {
				t.Fatalf("got (%q, %v), want (%q, %v)", got, ok, c.want, c.ok)
			}
		})
	}
}

// The upgrade is forwarded as raw bytes, so assert on what the dev server
// actually receives: exactly one Origin line, rewritten for a same-origin
// upgrade.
func TestWriteUpgradeRequestRewritesSameOriginOrigin(t *testing.T) {
	r := httptest.NewRequest("GET", "/_next/webpack-hmr?id=1", nil)
	r.Host = "sbx.style.dev"
	r.Header.Set("Origin", "https://sbx.style.dev")
	r.Header.Set("Upgrade", "websocket")

	client, server := net.Pipe()
	defer server.Close()
	go func() {
		writeUpgradeRequest(client, r, 3000)
		client.Close()
	}()
	req, err := http.ReadRequest(bufio.NewReader(server))
	if err != nil {
		t.Fatal(err)
	}
	if got := req.Header.Values("Origin"); len(got) != 1 || got[0] != "http://localhost:3000" {
		t.Fatalf("Origin = %q, want exactly [http://localhost:3000]", got)
	}
	if req.Host != "sbx.style.dev" || req.Header.Get("Upgrade") != "websocket" {
		t.Fatalf("host/upgrade not preserved: host=%q upgrade=%q", req.Host, req.Header.Get("Upgrade"))
	}
}

// Dev-overlay calls such as a POST to /__nextjs_original-stack-frames carry an
// Origin too, so the HTTP path applies the same rewrite.
func TestServeHTTPRewritesSameOriginOrigin(t *testing.T) {
	ln, err := net.Listen("tcp", "[::1]:0")
	if err != nil {
		t.Skip("no IPv6 loopback:", err)
	}
	seen := make(chan string, 1)
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Get("Origin")
	}))
	upstream.Listener = ln
	upstream.Start()
	defer upstream.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	h := New(Deps{GetDevPort: func(*http.Request) int { return port }})
	r := httptest.NewRequest("POST", "/__nextjs_original-stack-frames", nil)
	r.Host = "sbx.style.dev"
	r.Header.Set("Origin", "https://sbx.style.dev")
	h.ServeHTTP(httptest.NewRecorder(), r)

	want := "http://localhost:" + strconv.Itoa(port)
	if got := <-seen; got != want {
		t.Fatalf("upstream saw Origin %q, want %q", got, want)
	}
}
