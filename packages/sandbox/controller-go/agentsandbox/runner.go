// Package agentsandbox is the Kubernetes runtime: SandboxClaims against the
// agent-sandbox operator, on the upstream generated clientsets.
package agentsandbox

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	sandboxclient "sigs.k8s.io/agent-sandbox/clients/k8s/clientset/versioned"
	sandboxtyped "sigs.k8s.io/agent-sandbox/clients/k8s/clientset/versioned/typed/api/v1alpha1"
	extclient "sigs.k8s.io/agent-sandbox/clients/k8s/extensions/clientset/versioned"
	exttyped "sigs.k8s.io/agent-sandbox/clients/k8s/extensions/clientset/versioned/typed/api/v1alpha1"

	"github.com/decocms/studio/sandbox-controller/protocol"
	"github.com/decocms/studio/sandbox-controller/runtime"
	"github.com/decocms/studio/sandbox-controller/store"
)

// Name is what studio records on the row and routes every later call by.
const Name = "agent-sandbox"

const (
	bindTimeout   = 120 * time.Second
	readyTimeout  = 180 * time.Second
	daemonTimeout = 120 * time.Second
	// credentialRefreshInterval must stay under the ~55min GitHub App token
	// life, or a pod alive past expiry pushes with a dead credential on
	// shutdown and loses the user's work.
	credentialRefreshInterval = 20 * time.Minute
	credentialBufferMs        = int64(20 * time.Minute / time.Millisecond)
)

// Config is everything the runtime reads from the deployment.
type Config struct {
	Namespace string
	// PreviewURLPattern is this deployment's prod/dev discriminator: set means
	// there is a preview gateway and studio shares the cluster network. It is
	// NOT a runtime identity — "am I in a cluster with a gateway" and "which
	// runtime am I" are separate questions.
	PreviewURLPattern string
	TemplateName      string
	EnvName           string
	// SentinelToken is the shared bearer baked into the SandboxTemplate's pod
	// env. Its presence flips the runtime into warm-pool mode.
	SentinelToken  string
	PreviewGateway *Gateway
	IdleTTL        time.Duration
	// MintCloneURL calls studio back for a fresh clone credential; minting
	// needs studio's DB and vault so it cannot live here.
	MintCloneURL func(ctx context.Context, connectionID, cloneURL string, bufferMs int64) (string, error)
}

type Gateway struct{ Name, Namespace string }

// persisted is the state blob on sandbox_runner_state. Field names match the
// TypeScript runner's so a row written by either side is readable by both.
type persisted struct {
	AdoptedSandboxName string                  `json:"adoptedSandboxName"`
	Token              string                  `json:"token"`
	Workdir            string                  `json:"workdir"`
	Workload           *protocol.Workload      `json:"workload,omitempty"`
	DaemonBootID       string                  `json:"daemonBootId,omitempty"`
	Tenant             *protocol.Tenant        `json:"tenant,omitempty"`
	EnsureOpts         *protocol.EnsureOptions `json:"ensureOpts,omitempty"`
}

type bootSecrets struct {
	token        string
	daemonBootID string
	workdir      string
}

// Runner implements runtime.Provider against the agent-sandbox operator.
type Runner struct {
	cfg               Config
	namespace         string
	previewURLPattern string
	templateName      string
	envName           string
	sentinelToken     string
	idleTTL           time.Duration

	restConfig *rest.Config
	core       *kubernetes.Clientset
	ext        *extclient.Clientset
	sbx        *sandboxclient.Clientset
	store      *store.Store

	mu       sync.Mutex
	forwards map[string]*forwarder

	cancelBackground context.CancelFunc
}

func New(restConfig *rest.Config, st *store.Store, cfg Config) (*Runner, error) {
	core, err := kubernetes.NewForConfig(restConfig)
	if err != nil {
		return nil, err
	}
	ext, err := extclient.NewForConfig(restConfig)
	if err != nil {
		return nil, err
	}
	sbx, err := sandboxclient.NewForConfig(restConfig)
	if err != nil {
		return nil, err
	}
	if cfg.Namespace == "" {
		cfg.Namespace = "agent-sandbox-system"
	}
	if cfg.TemplateName == "" {
		cfg.TemplateName = "studio-sandbox"
	}
	if cfg.IdleTTL == 0 {
		cfg.IdleTTL = 15 * time.Minute
	}
	r := &Runner{
		cfg:               cfg,
		namespace:         cfg.Namespace,
		previewURLPattern: cfg.PreviewURLPattern,
		templateName:      cfg.TemplateName,
		envName:           cfg.EnvName,
		sentinelToken:     strings.TrimSpace(cfg.SentinelToken),
		idleTTL:           cfg.IdleTTL,
		restConfig:        restConfig,
		core:              core,
		ext:               ext,
		sbx:               sbx,
		store:             st,
		forwards:          map[string]*forwarder{},
	}
	ctx, cancel := context.WithCancel(context.Background())
	r.cancelBackground = cancel
	go r.refreshCredentials(ctx)
	return r, nil
}

func (r *Runner) claims() exttyped.SandboxClaimInterface {
	return r.ext.ExtensionsV1alpha1().SandboxClaims(r.namespace)
}

func (r *Runner) sandboxes() sandboxtyped.SandboxInterface {
	return r.sbx.AgentsV1alpha1().Sandboxes(r.namespace)
}

func (r *Runner) Close() {
	if r.cancelBackground != nil {
		r.cancelBackground()
	}
	r.mu.Lock()
	for _, f := range r.forwards {
		close(f.stop)
	}
	r.forwards = map[string]*forwarder{}
	r.mu.Unlock()
}

// Probe: can we reach the API server and is the CRD served? Both, because
// credentials that resolve against a cluster with no operator would place a
// sandbox that can never bind.
func (r *Runner) Probe(ctx context.Context) (bool, string) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, err := r.claims().List(ctx, metav1.ListOptions{Limit: 1}); err != nil {
		return false, err.Error()
	}
	return true, ""
}

func (r *Runner) envMap(opts *protocol.EnsureOptions, boot bootSecrets) map[string]string {
	reserved := map[string]bool{
		"DAEMON_TOKEN": true, "DAEMON_BOOT_ID": true, "APP_ROOT": true, "PROXY_PORT": true,
	}
	out := map[string]string{}
	var dropped []string
	if opts != nil {
		for k, v := range opts.Env {
			if reserved[k] {
				dropped = append(dropped, k)
				continue
			}
			out[k] = v
		}
	}
	if len(dropped) > 0 {
		slog.Warn("opts.env keys overlap reserved bootstrap names and were dropped", "keys", dropped)
	}
	out["DAEMON_TOKEN"] = boot.token
	out["DAEMON_BOOT_ID"] = boot.daemonBootID
	out["APP_ROOT"] = boot.workdir
	out["PROXY_PORT"] = fmt.Sprint(daemonPort)
	return out
}

// resolveTemplateName picks the per-purpose SandboxTemplate, degrading to the
// default when the chart predates the `-medium` one rather than parking every
// dispatch at TemplateNotFound.
func (r *Runner) resolveTemplateName(ctx context.Context, purpose string) string {
	if purpose != "harness-run" {
		return r.templateName
	}
	medium := r.templateName + "-medium"
	_, err := r.ext.ExtensionsV1alpha1().SandboxTemplates(r.namespace).Get(ctx, medium, metav1.GetOptions{})
	if err != nil {
		slog.Warn("SandboxTemplate not found — harness-run claims fall back",
			"template", medium, "fallback", r.templateName)
		return r.templateName
	}
	return medium
}

// Ensure is idempotent by handle and returns only once the daemon is healthy
// and configured — same contract the in-process runner has today, and the
// reason the config POST lives here rather than in studio.
func (r *Runner) Ensure(ctx context.Context, id protocol.SandboxID, handle string, opts *protocol.EnsureOptions) (*runtime.Sandbox, error) {
	var out *runtime.Sandbox
	err := r.store.WithLock(ctx, id, Name, func(ctx context.Context) error {
		sandbox, err := r.ensureLocked(ctx, id, handle, opts)
		out = sandbox
		return err
	})
	return out, err
}

func (r *Runner) ensureLocked(ctx context.Context, id protocol.SandboxID, handle string, opts *protocol.EnsureOptions) (*runtime.Sandbox, error) {
	if opts == nil {
		opts = &protocol.EnsureOptions{}
	}
	// Resume: a live claim with a persisted row is the common case. Re-mint the
	// clone credential and push it to the running daemon rather than paying a
	// cold clone.
	if rec, err := r.store.Get(ctx, id, Name); err == nil && rec != nil && rec.Handle == handle {
		var state persisted
		if json.Unmarshal(rec.State, &state) == nil && state.AdoptedSandboxName != "" {
			if claim, err := r.getClaim(ctx, handle); err == nil && claim != nil {
				if sandbox, err := r.resume(ctx, handle, state, opts); err == nil {
					return sandbox, nil
				} else {
					slog.Warn("resume failed, reprovisioning", "handle", handle, "err", err)
				}
			}
		}
		// The row outlived its claim: drop it so the create below is clean.
		_ = r.store.DeleteByHandle(ctx, Name, handle)
	}
	return r.provision(ctx, id, handle, opts)
}

func (r *Runner) resume(ctx context.Context, handle string, state persisted, opts *protocol.EnsureOptions) (*runtime.Sandbox, error) {
	url, err := r.daemonURL(ctx, handle, state.AdoptedSandboxName)
	if err != nil {
		return nil, err
	}
	if _, err := waitForDaemon(ctx, url, 20*time.Second); err != nil {
		return nil, err
	}
	// Forward a freshly minted credential so authenticated git survives the
	// ~1h expiry of the token baked in at provision. Best-effort: the sandbox
	// is otherwise healthy, and worst case git stays stale until next start.
	if opts.Repo != nil {
		fresh := r.withFreshCloneURL(ctx, opts.Repo, 0)
		cfg := buildConfigPayload(&protocol.EnsureOptions{Repo: fresh, Tenant: opts.Tenant, Workload: opts.Workload, CloneOnly: opts.CloneOnly})
		if err := postConfig(ctx, url, state.Token, cfg, ""); err != nil {
			slog.Warn("resume config push failed", "handle", handle, "err", err)
		}
	}
	// Renew on resume: the claim TTL is a wall clock and someone is clearly here.
	_ = r.RenewTTL(ctx, handle)
	return r.sandboxFor(handle, state, url), nil
}

func (r *Runner) provision(ctx context.Context, id protocol.SandboxID, handle string, opts *protocol.EnsureOptions) (*runtime.Sandbox, error) {
	// Whatever pod this handle pointed at is being replaced. Any port-forward
	// held for it now dials a corpse — and it would be REUSED, because a
	// rebuilt Sandbox keeps the claim's name, so the cache key still matches.
	// Dropping it here is the difference between a resurrect that works and
	// one that burns the full daemon timeout on connection-refused.
	r.closeForward(handle)
	boot := bootSecrets{
		token:        uuid.NewString(),
		daemonBootID: uuid.NewString(),
		workdir:      defaultWorkdir,
	}
	if opts.Repo != nil {
		opts.Repo = r.withFreshCloneURL(ctx, opts.Repo, 0)
	}
	claim := r.buildClaim(handle, opts, boot, r.resolveTemplateName(ctx, opts.Purpose))

	if _, err := r.claims().Create(ctx, claim, metav1.CreateOptions{}); err != nil {
		if !apierrors.IsAlreadyExists(err) {
			return nil, fmt.Errorf("failed to create SandboxClaim %s: %w", handle, err)
		}
		// The canonical race: the operator's idle TTL just reaped a claim and
		// this ensure landed before the resource was GC'd. Wait it out and
		// retry exactly once.
		if err := r.waitForClaimGone(ctx, handle, 60*time.Second); err != nil {
			return nil, err
		}
		if _, err := r.claims().Create(ctx, claim, metav1.CreateOptions{}); err != nil {
			return nil, fmt.Errorf("failed to create SandboxClaim %s: %w", handle, err)
		}
	}

	// Either bind step can time out. On failure the orphan claim must go: it
	// leaks a pod, and the caller's next ensure would adopt a stuck half-bound
	// claim.
	rollback := func(cause error) (*runtime.Sandbox, error) {
		_ = r.deleteClaim(context.WithoutCancel(ctx), handle)
		r.closeForward(handle)
		return nil, cause
	}

	adopted, err := r.waitForAdoptedSandbox(ctx, handle, bindTimeout)
	if err != nil {
		return rollback(err)
	}
	if err := r.waitForSandboxReady(ctx, adopted, readyTimeout); err != nil {
		return rollback(err)
	}

	// Service port then HTTPRoute, in that order and both before the daemon
	// URL reaches the caller, so the gateway has a route AND a registered
	// backend by the time anyone follows the preview link.
	if err := r.ensureServicePort(ctx, adopted); err != nil {
		return rollback(err)
	}
	if err := r.ensureHTTPRoute(ctx, handle, adopted, opts); err != nil {
		return rollback(err)
	}

	url, err := r.daemonURL(ctx, handle, adopted)
	if err != nil {
		return rollback(err)
	}
	health, err := waitForDaemon(ctx, url, daemonTimeout)
	if err != nil {
		return rollback(err)
	}
	bootID := boot.daemonBootID
	if health.BootId != "" {
		bootID = health.BootId
	}

	cfg := buildConfigPayload(opts)
	if r.sentinelToken != "" {
		// Warm-pool path: the pod booted on the shared sentinel. Authenticate
		// with it once and rotate to the per-claim token atomically with the
		// workload patch — after this returns only boot.token is accepted,
		// which is what stops a recycled pod honouring the previous tenant.
		if err := postConfig(ctx, url, r.sentinelToken, cfg, boot.token); err != nil {
			return rollback(err)
		}
	} else if cfg != nil {
		// Cold path: the per-claim token went in via spec.env already.
		if err := postConfig(ctx, url, boot.token, cfg, ""); err != nil {
			return rollback(err)
		}
	}
	// Mounts are additive, so a relay failure must not fail provisioning.
	if opts.OrgFsConfigJSON != "" {
		if err := postOrgFsConfig(ctx, url, boot.token, opts.OrgFsConfigJSON); err != nil {
			slog.Warn("org-fs sidecar config relay failed", "handle", handle, "err", err)
		}
	}

	state := persisted{
		AdoptedSandboxName: adopted,
		Token:              boot.token,
		Workdir:            boot.workdir,
		Workload:           opts.Workload,
		DaemonBootID:       bootID,
		Tenant:             opts.Tenant,
		EnsureOpts:         stripEnsureOpts(opts),
	}
	if err := r.store.Put(ctx, id, Name, handle, state); err != nil {
		return rollback(err)
	}
	return r.sandboxFor(handle, state, url), nil
}

// stripEnsureOpts drops what must not be replayed from a persisted row. The
// clone credential is deliberately kept — recovery re-mints from it — but it
// is the reason a row is as sensitive as the vault.
func stripEnsureOpts(opts *protocol.EnsureOptions) *protocol.EnsureOptions {
	if opts == nil {
		return nil
	}
	clone := *opts
	clone.Env = nil
	if clone.Repo != nil {
		repo := *clone.Repo
		// Submodule PATs are re-resolved on every ensure; persisting them just
		// stores extra credentials that go stale.
		repo.SubmoduleCredentials = nil
		clone.Repo = &repo
	}
	return &clone
}

func (r *Runner) sandboxFor(handle string, state persisted, daemonURL string) *runtime.Sandbox {
	workdir := state.Workdir
	if workdir == "" {
		workdir = defaultWorkdir
	}
	return &runtime.Sandbox{
		Handle:     handle,
		Workdir:    workdir,
		PreviewURL: r.previewURLFor(handle, daemonURL),
		Daemon:     protocol.Daemon{URL: daemonURL, Token: state.Token},
	}
}

// previewURLFor: production goes through the gateway hostname; locally it is
// the daemon's own port, never the dev server's — the daemon reverse-proxies
// with CSP/X-Frame stripping and the HMR bootstrap vite needs inside the
// studio iframe.
func (r *Runner) previewURLFor(handle, daemonURL string) *string {
	if r.previewURLPattern != "" {
		u := applyPreviewPattern(r.previewURLPattern, handle)
		return &u
	}
	u := daemonURL + "/"
	return &u
}

func applyPreviewPattern(pattern, handle string) string {
	base := strings.TrimRight(pattern, "/")
	if strings.Contains(base, "{handle}") {
		return strings.Replace(base, "{handle}", handle, 1) + "/"
	}
	if i := strings.Index(base, "://"); i >= 0 {
		return base[:i+3] + handle + "." + base[i+3:] + "/"
	}
	return base + "/" + handle + "/"
}

func (r *Runner) load(ctx context.Context, handle string) (*store.Record, *persisted, error) {
	rec, err := r.store.ByHandle(ctx, handle)
	if err != nil || rec == nil {
		return nil, nil, err
	}
	var state persisted
	if err := json.Unmarshal(rec.State, &state); err != nil {
		return rec, nil, err
	}
	return rec, &state, nil
}

func (r *Runner) Alive(ctx context.Context, handle string) (bool, error) {
	claim, err := r.getClaim(ctx, handle)
	return claim != nil, err
}

func (r *Runner) Daemon(ctx context.Context, handle string) (*protocol.Daemon, error) {
	_, state, err := r.load(ctx, handle)
	if err != nil || state == nil {
		return nil, err
	}
	url, err := r.daemonURL(ctx, handle, state.AdoptedSandboxName)
	if err != nil {
		return nil, err
	}
	return &protocol.Daemon{URL: url, Token: state.Token}, nil
}

// Resurrect re-provisions a sandbox the operator's idle TTL reaped, replaying
// the persisted EnsureOptions so it returns with its repo rather than empty.
// False (not an error) when there is nothing to replay, so the caller 404s;
// a real provisioning failure returns its error rather than a false 404.
func (r *Runner) Resurrect(ctx context.Context, handle string) (bool, error) {
	rec, state, err := r.load(ctx, handle)
	if err != nil || rec == nil || state == nil || state.EnsureOpts == nil {
		return false, nil
	}
	if claim, err := r.getClaim(ctx, handle); err == nil && claim != nil {
		return true, nil // never died; nothing to do
	}
	slog.Info("resurrecting evicted sandbox", "handle", handle)
	if _, err := r.Ensure(ctx, rec.ID, handle, state.EnsureOpts); err != nil {
		return false, err
	}
	return true, nil
}

func (r *Runner) PreviewURL(ctx context.Context, handle string) (*string, error) {
	if r.previewURLPattern != "" {
		u := applyPreviewPattern(r.previewURLPattern, handle)
		return &u, nil
	}
	d, err := r.Daemon(ctx, handle)
	if err != nil || d == nil {
		return nil, err
	}
	u := d.URL + "/"
	return &u, nil
}

// Delete returns once the claim is collected, or ctx expires — the caller
// answers 202 on the latter, which means retry, not success.
func (r *Runner) Delete(ctx context.Context, handle string) error {
	// HTTPRoute first so traffic stops resolving immediately: the operator's
	// claim teardown takes seconds and we do not want browsers landing on a
	// half-deleted Service. A stale route just 502s; the sweep collects it.
	if err := r.deleteHTTPRoute(ctx, handle); err != nil {
		slog.Warn("HTTPRoute delete failed", "handle", handle, "err", err)
	}
	if err := r.deleteClaim(ctx, handle); err != nil {
		return err
	}
	r.closeForward(handle)
	if err := r.store.DeleteByHandle(ctx, Name, handle); err != nil {
		return err
	}
	return r.waitForClaimGone(ctx, handle, timeUntilDeadline(ctx))
}

func timeUntilDeadline(ctx context.Context) time.Duration {
	if deadline, ok := ctx.Deadline(); ok {
		return time.Until(deadline)
	}
	return 60 * time.Second
}

// Adopt repopulates the row from a claim that already exists in the cluster —
// preview traffic and studio restarts both outlive the state a provision left.
func (r *Runner) Adopt(ctx context.Context, id protocol.SandboxID, handle string) (bool, error) {
	claim, err := r.getClaim(ctx, handle)
	if err != nil || claim == nil {
		return false, err
	}
	adopted := claim.Status.SandboxStatus.Name
	if adopted == "" {
		return false, nil
	}
	if _, state, _ := r.load(ctx, handle); state != nil && state.AdoptedSandboxName == adopted {
		return true, nil
	}
	// A claim carries no per-claim daemon token — that is exactly why this
	// controller is not stateless-and-reconstruct-from-k8s. Rotate to a fresh
	// one through the sentinel, which is the only credential a recycled pod
	// still honours.
	if r.sentinelToken == "" {
		return false, nil
	}
	url, err := r.daemonURL(ctx, handle, adopted)
	if err != nil {
		return false, err
	}
	if _, err := waitForDaemon(ctx, url, 20*time.Second); err != nil {
		return false, err
	}
	token := uuid.NewString()
	if err := postConfig(ctx, url, r.sentinelToken, nil, token); err != nil {
		return false, err
	}
	state := persisted{AdoptedSandboxName: adopted, Token: token, Workdir: defaultWorkdir}
	if err := r.store.Put(ctx, id, Name, handle, state); err != nil {
		return false, err
	}
	return true, nil
}

// RenewTTL pushes shutdown out to a full idle window because someone is still
// watching. Never brings it earlier. Best-effort: a missed renewal costs one
// reprovision, and the next heartbeat retries well inside the TTL.
func (r *Runner) RenewTTL(ctx context.Context, handle string) error {
	claim, err := r.getClaim(ctx, handle)
	if err != nil || claim == nil {
		// Do NOT recreate it — a claim resurrected from here would carry none
		// of the env a working sandbox needs.
		return nil
	}
	next := time.Now().Add(r.idleTTL)
	if cur := claim.Spec.Lifecycle; cur != nil && cur.ShutdownTime != nil && cur.ShutdownTime.Time.After(next) {
		return nil
	}
	return r.patchShutdown(ctx, handle, next)
}

// ReleaseAfter brings shutdown forward because the work is done. Never later.
// A patch, not a delete: the operator stays the only thing that tears a claim
// down, and the grace window lets an immediate follow-up turn adopt the still
// running pod instead of paying a cold clone.
func (r *Runner) ReleaseAfter(ctx context.Context, handle string, grace time.Duration) error {
	claim, err := r.getClaim(ctx, handle)
	if err != nil || claim == nil {
		return nil
	}
	next := time.Now().Add(grace)
	if cur := claim.Spec.Lifecycle; cur != nil && cur.ShutdownTime != nil && cur.ShutdownTime.Time.Before(next) {
		return nil
	}
	return r.patchShutdown(ctx, handle, next)
}

// withFreshCloneURL re-mints the clone credential, falling back to the
// persisted URL: a mint failure must not block provisioning or recovery.
func (r *Runner) withFreshCloneURL(ctx context.Context, repo *protocol.Repo, bufferMs int64) *protocol.Repo {
	if repo == nil || repo.ConnectionID == "" || r.cfg.MintCloneURL == nil {
		return repo
	}
	fresh, err := r.cfg.MintCloneURL(ctx, repo.ConnectionID, repo.CloneURL, bufferMs)
	if err != nil || fresh == "" {
		if err != nil {
			slog.Warn("clone credential re-mint failed", "err", err)
		}
		return repo
	}
	clone := *repo
	clone.CloneURL = fresh
	return &clone
}

// refreshCredentials keeps git alive in long-lived sandboxes. A pod past the
// clone token's expiry with no recovery event would push a dead credential on
// shutdown and lose the user's work; recovery only re-mints on a claim event,
// so a continuously-editing pod is otherwise never refreshed.
func (r *Runner) refreshCredentials(ctx context.Context) {
	if r.cfg.MintCloneURL == nil {
		return
	}
	ticker := time.NewTicker(credentialRefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			records, err := r.store.ListByRuntime(ctx, Name)
			if err != nil {
				slog.Warn("credential refresh: cannot list sandboxes", "err", err)
				continue
			}
			for _, rec := range records {
				var state persisted
				if json.Unmarshal(rec.State, &state) != nil {
					continue
				}
				if state.EnsureOpts == nil || state.EnsureOpts.Repo == nil || state.EnsureOpts.Repo.ConnectionID == "" {
					continue
				}
				fresh := r.withFreshCloneURL(ctx, state.EnsureOpts.Repo, credentialBufferMs)
				if fresh.CloneURL == state.EnsureOpts.Repo.CloneURL {
					continue
				}
				url, err := r.daemonURL(ctx, rec.Handle, state.AdoptedSandboxName)
				if err != nil {
					continue
				}
				cfg := buildConfigPayload(&protocol.EnsureOptions{
					Repo: fresh, Tenant: state.Tenant, Workload: state.Workload,
					CloneOnly: state.EnsureOpts.CloneOnly,
				})
				if err := postConfig(ctx, url, state.Token, cfg, ""); err != nil {
					slog.Warn("credential refresh push failed", "handle", rec.Handle, "err", err)
					continue
				}
				state.EnsureOpts.Repo = fresh
				_ = r.store.Put(ctx, rec.ID, Name, rec.Handle, state)
			}
		}
	}
}

var _ runtime.Provider = (*Runner)(nil)
