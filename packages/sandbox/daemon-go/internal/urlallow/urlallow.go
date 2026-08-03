// Package urlallow is the SSRF gate for every daemon route that fetches or
// pushes to a caller-supplied URL. The allowlist comes from boot env
// (OFFLOAD_ALLOWED_HOSTS), never from the request, and an empty list denies
// everything.
package urlallow

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Assert reports whether raw may be fetched: https only (http loopback when
// allowSameHostDev), and the host must appear verbatim in allowedHosts.
func Assert(raw string, allowedHosts []string, allowSameHostDev bool) error {
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("url: malformed URL")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return errors.New("url: missing host")
	}
	isLoopback := host == "127.0.0.1" || host == "localhost" || host == "::1"
	devLoopback := allowSameHostDev && u.Scheme == "http" && isLoopback
	if !devLoopback && u.Scheme != "https" {
		return errors.New("url: only https is allowed")
	}
	for _, h := range allowedHosts {
		if strings.ToLower(strings.TrimSpace(h)) == host {
			return nil
		}
	}
	return fmt.Errorf("url: host not allowed (%s)", host)
}

// Client returns an HTTP client that re-checks every redirect hop against the
// same allowlist. Without this a listed host could 302 the daemon onto cloud
// metadata or a cluster-internal service.
func Client(timeout time.Duration, allowedHosts []string, allowSameHostDev bool) *http.Client {
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("url: too many redirects")
			}
			return Assert(req.URL.String(), allowedHosts, allowSameHostDev)
		},
	}
}
