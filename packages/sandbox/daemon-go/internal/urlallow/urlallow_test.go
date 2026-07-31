package urlallow

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestAssertFailsClosed(t *testing.T) {
	allowed := []string{"s3.example.com"}
	cases := []struct {
		name             string
		raw              string
		hosts            []string
		allowSameHostDev bool
		ok               bool
	}{
		{"empty allowlist denies everything", "https://s3.example.com/x", nil, false, false},
		{"listed host over https", "https://s3.example.com/x", allowed, false, true},
		{"host casing is normalized", "https://S3.EXAMPLE.COM/x", allowed, false, true},
		{"unlisted host", "https://evil.example.com/x", allowed, false, false},
		{"suffix of a listed host", "https://s3.example.com.evil.net/x", allowed, false, false},
		{"userinfo cannot spoof the host", "https://s3.example.com@evil.net/x", allowed, false, false},
		{"plain http outside dev", "http://s3.example.com/x", allowed, false, false},
		{"malformed url", "http://[::1", allowed, false, false},
		{"missing host", "https:///x", allowed, false, false},
		{"not a url at all", "just some text", allowed, false, false},
		{"ip-literal loopback unlisted", "https://127.0.0.1/x", allowed, false, false},
		{"ipv6 loopback unlisted", "https://[::1]/x", allowed, false, false},
		{"cloud metadata ip", "https://169.254.169.254/latest/meta-data/", allowed, false, false},
		{"dev loopback still needs the allowlist", "http://127.0.0.1:9000/x", allowed, true, false},
		{"dev loopback when listed", "http://127.0.0.1:9000/x", []string{"127.0.0.1"}, true, true},
		{"dev ipv6 loopback when listed", "http://[::1]:9000/x", []string{"::1"}, true, true},
		{"dev flag does not open https rule for others", "http://evil.net/x", []string{"evil.net"}, true, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := Assert(c.raw, c.hosts, c.allowSameHostDev)
			if (err == nil) != c.ok {
				t.Fatalf("Assert(%q) err=%v, want ok=%v", c.raw, err, c.ok)
			}
		})
	}
}

// A listed host must not be able to bounce the daemon onto an unlisted one.
func TestClientRefusesRedirectToUnlistedHost(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data/", http.StatusFound)
	}))
	defer target.Close()

	host := mustHost(t, target.URL)
	client := Client(5*time.Second, []string{host}, true)
	_, err := client.Get(target.URL)
	if err == nil {
		t.Fatal("redirect to an unlisted host must fail")
	}
}

func TestClientFollowsRedirectToListedHost(t *testing.T) {
	final := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok"))
	}))
	defer final.Close()
	hop := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, final.URL, http.StatusFound)
	}))
	defer hop.Close()

	client := Client(5*time.Second, []string{mustHost(t, hop.URL), mustHost(t, final.URL)}, true)
	res, err := client.Get(hop.URL)
	if err != nil {
		t.Fatalf("redirect to a listed host must succeed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func mustHost(t *testing.T, raw string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u.Hostname()
}
