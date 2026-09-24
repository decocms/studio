// Package daemonclient is what every runtime does to bring a sandbox daemon up
// and keep it configured: the daemon's control endpoints, the /_sandbox/config
// payload built from a claim's options, and credential re-minting.
package daemonclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"time"

	daemon "github.com/decocms/studio/sandbox-daemon/pkg/protocol"
)

const (
	healthProbeTimeout = 500 * time.Millisecond
	// A config post can run a cold clone + install on a heavy sandbox.
	configTimeout = 30 * time.Second
	readyAttempts = 25
	readyInterval = 200 * time.Millisecond
	readyJitter   = 50 * time.Millisecond
	// Each attempt gets its own timeout; one built once and shared would have
	// fired already for every attempt after the first that timed out.
	requestAttempts = 3
	retryMin        = 50 * time.Millisecond
	retryMax        = 500 * time.Millisecond
)

// ConfigRequestError is a non-2xx answer from /_sandbox/config. A 401 on the
// sentinel means the pod already rotated to another claim's token.
type ConfigRequestError struct {
	Status int
	Body   string
}

func (e *ConfigRequestError) Error() string {
	return fmt.Sprintf("sandbox daemon /_sandbox/config returned %d: %s", e.Status, e.Body)
}

// Client calls one daemon at a time; it is safe for concurrent use.
type Client struct {
	http *http.Client
	// Replaced in tests.
	Sleep         func(context.Context, time.Duration) error
	ConfigTimeout time.Duration
}

// New builds a Client; nil transport is a default one.
func New(transport http.RoundTripper) *Client {
	if transport == nil {
		transport = &http.Transport{
			DialContext:         (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
			MaxIdleConnsPerHost: 4,
		}
	}
	return &Client{http: &http.Client{Transport: transport}, Sleep: Sleep, ConfigTimeout: configTimeout}
}

// Sleep waits d or until ctx ends.
func Sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

type daemonResponse struct {
	status int
	body   []byte
}

func (r daemonResponse) ok() bool { return r.status >= 200 && r.status < 300 }

// neverSent: the connection was never established, so the request cannot
// have reached the daemon.
func neverSent(err error) bool {
	var op *net.OpError
	return errors.As(err, &op) && op.Op == "dial"
}

// request calls one daemon endpoint and reads the whole body inside the
// attempt, so a daemon that sends headers and then stalls is a labelled
// failure too. Transport failures retry with backoff, except when the request
// may have been applied and replaying it is not safe: a POST carrying
// auth.rotateToken rotates the bearer before anything else, so a retry after a
// timeout would present a token the daemon no longer accepts.
func (c *Client) request(ctx context.Context, method, url, token string, body []byte, endpoint string, timeout time.Duration, replayable bool) (daemonResponse, error) {
	var last error
	backoff := retryMin
	for attempt := 0; attempt < requestAttempts; attempt++ {
		if attempt > 0 {
			jitter := time.Duration((rand.Float64() - 0.5) * float64(backoff))
			if err := c.Sleep(ctx, backoff+jitter); err != nil {
				break
			}
			backoff = min(backoff*2, retryMax)
		}
		res, err := c.once(ctx, method, url, token, body, timeout)
		if err == nil {
			return res, nil
		}
		last = err
		if ctx.Err() != nil || (!replayable && !neverSent(err)) {
			break
		}
	}
	return daemonResponse{}, fmt.Errorf("[SANDBOX_UNREACHABLE] sandbox daemon %s request failed: %w", endpoint, last)
}

func (c *Client) once(ctx context.Context, method, url, token string, body []byte, timeout time.Duration) (daemonResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return daemonResponse{}, err
	}
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	if token != "" {
		req.Header.Set("authorization", "Bearer "+token)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return daemonResponse{}, err
	}
	defer res.Body.Close()
	blob, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return daemonResponse{}, err
	}
	return daemonResponse{status: res.StatusCode, body: blob}, nil
}

// ProbeHealth reads /health, the one unauthenticated endpoint, once. Nil when
// unreachable or not a daemon's answer.
func (c *Client) ProbeHealth(ctx context.Context, daemonURL string) *daemon.Health {
	ctx, cancel := context.WithTimeout(ctx, healthProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, daemonURL+"/health", nil)
	if err != nil {
		return nil
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	blob, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	// Non-2xx still drained above, so the connection is reusable.
	if err != nil || res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil
	}
	var h struct {
		Ready  *bool  `json:"ready"`
		BootID string `json:"bootId"`
		Setup  *struct {
			Running *bool `json:"running"`
			Done    *bool `json:"done"`
		} `json:"setup"`
		Configured bool `json:"configured"`
	}
	if json.Unmarshal(blob, &h) != nil || h.BootID == "" || h.Ready == nil || h.Setup == nil || h.Setup.Running == nil || h.Setup.Done == nil {
		return nil
	}
	return &daemon.Health{
		Ready: *h.Ready, BootId: h.BootID, Configured: h.Configured,
		Setup: daemon.SetupState{Running: *h.Setup.Running, Done: *h.Setup.Done},
	}
}

// WaitReady polls /health until it answers (setup may still be running).
func (c *Client) WaitReady(ctx context.Context, daemonURL string) error {
	for i := 0; i < readyAttempts; i++ {
		if c.ProbeHealth(ctx, daemonURL) != nil {
			return nil
		}
		jitter := time.Duration((rand.Float64()*2 - 1) * float64(readyJitter))
		if err := c.Sleep(ctx, readyInterval+jitter); err != nil {
			return err
		}
	}
	return fmt.Errorf("sandbox daemon at %s did not respond on /health within %s", daemonURL, readyAttempts*readyInterval)
}

// PostConfig sets the daemon's tenant config. rotateToken, when set, replaces
// the daemon's bearer before the patch applies.
func (c *Client) PostConfig(ctx context.Context, daemonURL, token string, cfg *daemon.TenantConfig, rotateToken string) (*daemon.ConfigResponse, error) {
	req := daemon.ConfigRequest{}
	if cfg != nil {
		req.TenantConfig = *cfg
	}
	if rotateToken != "" {
		req.Auth = &daemon.ConfigAuth{RotateToken: rotateToken}
	}
	blob, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	res, err := c.request(ctx, http.MethodPost, daemonURL+"/_sandbox/config", token, blob, "/_sandbox/config", c.ConfigTimeout, rotateToken == "")
	if err != nil {
		return nil, err
	}
	if !res.ok() {
		return nil, &ConfigRequestError{Status: res.status, Body: string(res.body)}
	}
	var out daemon.ConfigResponse
	if err := parseJSON(res.body, "/_sandbox/config", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// PostOrgFsConfig relays the org-fs mount config to the pod's sidecar. A
// separate endpoint: an orgFs-only /config patch classifies as a no-op.
func (c *Client) PostOrgFsConfig(ctx context.Context, daemonURL, token, configJSON string) error {
	res, err := c.request(ctx, http.MethodPost, daemonURL+"/_sandbox/orgfs-config", token, []byte(configJSON), "/_sandbox/orgfs-config", c.ConfigTimeout, true)
	if err != nil {
		return err
	}
	if !res.ok() {
		return fmt.Errorf("sandbox daemon /_sandbox/orgfs-config returned %d: %s", res.status, res.body)
	}
	var out struct {
		Written bool `json:"written"`
	}
	return parseJSON(res.body, "/_sandbox/orgfs-config", &out)
}

// parseJSON labels a malformed 2xx body (a truncated response, a proxy's HTML
// error page) with its endpoint instead of a bare syntax error.
func parseJSON(body []byte, endpoint string, into any) error {
	if err := json.Unmarshal(body, into); err != nil {
		preview := body
		if len(preview) > 200 {
			preview = preview[:200]
		}
		return fmt.Errorf("sandbox daemon %s returned a malformed JSON body: %s: %w", endpoint, preview, err)
	}
	return nil
}
