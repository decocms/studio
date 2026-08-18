package agentsandbox

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/transport/spdy"

	daemon "github.com/decocms/studio/sandbox-daemon/pkg/protocol"

	"github.com/decocms/studio/sandbox-controller/protocol"
)

const (
	daemonPort = 9000
	// defaultDevPort and defaultWorkdir mirror the daemon's own defaults.
	defaultDevPort = 3000
	defaultWorkdir = "/app"
)

// daemonURL is where studio should talk to this sandbox's daemon.
//
// In a cluster with a preview gateway (production) that is in-cluster Service
// DNS: studio shares the network, so nothing has to tunnel and the controller
// is the only process holding pods/portforward.
//
// Without one (kind, colima, a laptop), studio is outside the sandbox network,
// so the controller opens a port-forward and hands back 127.0.0.1 — correct
// only when controller and studio share a host, which is exactly that case.
func (r *Runner) daemonURL(ctx context.Context, handle, adoptedSandboxName string) (string, error) {
	if r.previewURLPattern != "" {
		return fmt.Sprintf("http://%s.%s.svc.cluster.local:%d", adoptedSandboxName, r.namespace, daemonPort), nil
	}
	fwd, err := r.forward(ctx, handle, adoptedSandboxName)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("http://127.0.0.1:%d", fwd.port), nil
}

type forwarder struct {
	port    uint16
	stop    chan struct{}
	sandbox string
}

// forward opens (or reuses) a port-forward to the sandbox's pod. Keyed by
// handle so a re-ensure on the same sandbox does not leak listeners.
func (r *Runner) forward(ctx context.Context, handle, adoptedSandboxName string) (*forwarder, error) {
	r.mu.Lock()
	if existing, ok := r.forwards[handle]; ok && existing.sandbox == adoptedSandboxName {
		r.mu.Unlock()
		return existing, nil
	}
	r.mu.Unlock()
	r.closeForward(handle)

	podName, err := r.podNameFor(ctx, adoptedSandboxName)
	if err != nil {
		return nil, err
	}

	req := r.core.CoreV1().RESTClient().Post().
		Resource("pods").Namespace(r.namespace).Name(podName).SubResource("portforward")
	transport, upgrader, err := spdy.RoundTripperFor(r.restConfig)
	if err != nil {
		return nil, err
	}
	dialer := spdy.NewDialer(upgrader, &http.Client{Transport: transport}, "POST", req.URL())

	stop := make(chan struct{})
	ready := make(chan struct{})
	// Port 0 lets the kernel choose; ports come back from GetPorts.
	pf, err := portforward.New(dialer, []string{fmt.Sprintf("0:%d", daemonPort)}, stop, ready, io.Discard, io.Discard)
	if err != nil {
		return nil, err
	}
	errc := make(chan error, 1)
	go func() { errc <- pf.ForwardPorts() }()
	select {
	case <-ready:
	case err := <-errc:
		return nil, fmt.Errorf("port-forward to %s failed: %w", podName, err)
	case <-time.After(20 * time.Second):
		close(stop)
		return nil, fmt.Errorf("port-forward to %s did not become ready", podName)
	}
	ports, err := pf.GetPorts()
	if err != nil || len(ports) == 0 {
		close(stop)
		return nil, fmt.Errorf("port-forward to %s exposed no local port: %w", podName, err)
	}

	f := &forwarder{port: ports[0].Local, stop: stop, sandbox: adoptedSandboxName}
	r.mu.Lock()
	r.forwards[handle] = f
	r.mu.Unlock()
	return f, nil
}

func (r *Runner) closeForward(handle string) {
	r.mu.Lock()
	f, ok := r.forwards[handle]
	delete(r.forwards, handle)
	r.mu.Unlock()
	if ok {
		close(f.stop)
	}
}

// podNameFor reads the operator's pod-name annotation off the Sandbox, falling
// back to the sandbox name (the operator names cold-path pods after it).
func (r *Runner) podNameFor(ctx context.Context, sandboxName string) (string, error) {
	sb, err := r.sandboxes().Get(ctx, sandboxName, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	if name := sb.Annotations[podNameAnnotation]; name != "" {
		return name, nil
	}
	return sandboxName, nil
}

// ---- daemon HTTP ------------------------------------------------------------

var daemonHTTP = &http.Client{
	Timeout: 30 * time.Second,
	Transport: &http.Transport{
		DialContext:         (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
		MaxIdleConnsPerHost: 4,
	},
}

// probeHealth reads /health, the daemon's one unauthenticated endpoint — which
// is what lets the controller poll it before it holds a per-claim token.
func probeHealth(ctx context.Context, daemonURL string) (*daemon.Health, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, daemonURL+"/health", nil)
	if err != nil {
		return nil, err
	}
	res, err := daemonHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("daemon /health returned %d", res.StatusCode)
	}
	var h daemon.Health
	if err := json.NewDecoder(res.Body).Decode(&h); err != nil {
		return nil, err
	}
	if h.BootId == "" {
		return nil, fmt.Errorf("daemon /health returned no bootId")
	}
	return &h, nil
}

func waitForDaemon(ctx context.Context, daemonURL string, timeout time.Duration) (*daemon.Health, error) {
	deadline := time.Now().Add(timeout)
	var last error
	for {
		probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		h, err := probeHealth(probeCtx, daemonURL)
		cancel()
		if err == nil {
			return h, nil
		}
		last = err
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("sandbox daemon at %s did not respond on /health within %s: %w", daemonURL, timeout, last)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// postConfig sets the daemon's tenant config. rotateToken, when set, replaces
// the daemon's bearer and is applied BEFORE the config patch — that is how a
// warm-pool pod's shared sentinel becomes a per-claim secret.
func postConfig(ctx context.Context, daemonURL, token string, cfg *daemon.TenantConfig, rotateToken string) error {
	body := daemon.ConfigRequest{}
	if cfg != nil {
		body.TenantConfig = *cfg
	}
	if rotateToken != "" {
		body.Auth = &daemon.ConfigAuth{RotateToken: rotateToken}
	}
	blob, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, daemonURL+"/_sandbox/config", bytes.NewReader(blob))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+token)
	res, err := daemonHTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return fmt.Errorf("daemon /_sandbox/config returned %d: %s", res.StatusCode, detail)
	}
	return nil
}

// postOrgFsConfig relays mount config to the pod's privileged sidecar. A
// separate endpoint on purpose: an orgFs-only tenant patch classifies as a
// no-op and would be dropped by the daemon's config store.
func postOrgFsConfig(ctx context.Context, daemonURL, token, configJSON string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, daemonURL+"/_sandbox/orgfs-config", bytes.NewReader([]byte(configJSON)))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+token)
	res, err := daemonHTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("daemon /_sandbox/orgfs-config returned %d", res.StatusCode)
	}
	return nil
}

// buildConfigPayload collapses caller intent into the daemon's TenantConfig.
// The daemon auto-starts the dev server when a runnable script is present, so
// nothing here says "please start".
func buildConfigPayload(opts *protocol.EnsureOptions) *daemon.TenantConfig {
	if opts == nil {
		return nil
	}
	cfg := &daemon.TenantConfig{}
	touched := false

	if repo := opts.Repo; repo != nil {
		converted := make([]daemon.SubmoduleCredential, 0, len(repo.SubmoduleCredentials))
		for _, c := range repo.SubmoduleCredentials {
			converted = append(converted, daemon.SubmoduleCredential{Host: c.Host, Token: c.Token})
		}
		repository := &daemon.GitRepository{
			CloneUrl: daemon.Str(repo.CloneURL),
			RepoName: daemon.Str(repoLabel(repo)),
			// Always sent, empty included: the daemon reads an absent field as
			// "keep current", so omitting it leaves a revoked PAT live in the
			// pod for its whole lifetime.
			SubmoduleCredentials: converted,
		}
		if repo.Branch != "" {
			repository.Branch = daemon.Str(repo.Branch)
		}
		git := &daemon.GitConfig{Repository: repository}
		// Omitted when there is no user: a warm-pool pod bootstraps with a repo
		// and no author, and the daemon rejects a blank identity outright.
		if repo.UserName != "" || repo.UserEmail != "" {
			git.Identity = &daemon.GitIdentity{
				UserName:  daemon.Str(repo.UserName),
				UserEmail: daemon.Str(repo.UserEmail),
			}
		}
		cfg.Git = git
		touched = true
	}

	if t := opts.Tenant; t != nil {
		if t.UserName != "" || t.UserEmail != "" {
			cfg.Operator = &daemon.Operator{
				UserName:  daemon.Str(t.UserName),
				UserEmail: daemon.Str(t.UserEmail),
			}
			touched = true
		}
		// Provenance for artifacts that outlive the pod: the golden dependency
		// cache keys by org, because a repo hash alone does not isolate two
		// orgs cloning the same public template.
		if t.OrgID != "" {
			cfg.OrgId = t.OrgID
			touched = true
		}
	}

	if w := opts.Workload; w != nil && w.PackageManager != "" {
		pm := &daemon.PackageManagerConfig{Name: daemon.Str(w.PackageManager)}
		if w.PackageManagerPath != "" {
			pm.Path = daemon.Str(w.PackageManagerPath)
		}
		port := float64(defaultDevPort)
		if w.DevPort != 0 {
			port = float64(w.DevPort)
		}
		runtime := w.Runtime
		if runtime == "" {
			runtime = "node"
		}
		cfg.Application = &daemon.Application{
			PackageManager: pm,
			Runtime:        daemon.Str(runtime),
			Port:           &port,
		}
		touched = true
	}

	// Always sent, never absent-means-false: a pod reused from a warm pool
	// carries the previous claim's config, so the flag has to turn itself off
	// on a normal provision.
	cloneOnly := opts.CloneOnly
	cfg.CloneOnly = &cloneOnly
	touched = true

	if !touched {
		return nil
	}
	return cfg
}

func repoLabel(repo *protocol.Repo) string {
	if repo.DisplayName != "" {
		return repo.DisplayName
	}
	u, err := url.Parse(repo.CloneURL)
	if err != nil {
		return repo.CloneURL
	}
	trimmed := u.Path
	for len(trimmed) > 0 && trimmed[0] == '/' {
		trimmed = trimmed[1:]
	}
	if len(trimmed) > 4 && trimmed[len(trimmed)-4:] == ".git" {
		trimmed = trimmed[:len(trimmed)-4]
	}
	if trimmed == "" {
		return u.Host
	}
	return trimmed
}
