package agentsandbox

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/decocms/studio/packages/sandbox/controller-go/api/v1alpha1"
	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
	"github.com/decocms/studio/packages/sandbox/controller-go/runtime"
	"github.com/decocms/studio/packages/sandbox/controller-go/store"
)

// Name is the runtime recorded in sandbox_provider_kind, the value Studio's
// in-process runner writes too.
const Name = "agent-sandbox"

// Writer marks rows this controller wrote, so the in-process runner can refuse
// a row it does not own during a mis-drained cutover.
const Writer = "sandbox-controller"

const (
	defaultWorkdir = "/app"
	defaultIdleTTL = 15 * time.Minute
	// The refresh must stay under the ~55min clone-token life, and a token
	// entering the buffer is re-minted within one interval.
	credentialRefreshInterval = 15 * time.Minute
	credentialRefreshBuffer   = 30 * time.Minute
)

// Capabilities are the optional SandboxProvider methods this runtime has.
var Capabilities = []protocol.Capability{
	protocol.CapPreview,
	protocol.CapLifecyclePhases,
	protocol.CapWarmPool,
	protocol.CapTerminationReason,
	protocol.CapTTLExtend,
	protocol.CapCapacity,
}

// Studio is the controller's callbacks into Studio, which owns the database
// and vault credentials are minted from. An empty result means Studio
// declined; the caller keeps what it has.
type Studio interface {
	MintCloneURL(ctx context.Context, repo protocol.EnsureRepo, bufferMs int64) (string, error)
	MintOrgFsConfig(ctx context.Context, tenant protocol.Tenant) (string, error)
}

type Gateway struct{ Name, Namespace string }

type Config struct {
	Namespace string
	// Base SandboxTemplate; derived names add `-<image>` and `-medium`.
	TemplateName string
	// Stamped as studio.decocms.com/env so the housekeeper scopes per env.
	EnvName string
	// Set means there is a preview gateway and Studio shares the cluster
	// network: the daemon is reached by Service DNS. It is the prod/dev
	// discriminator, not a runtime identity.
	PreviewURLPattern string
	// Per-claim HTTPRoutes attach here; only with PreviewURLPattern.
	PreviewGateway *Gateway
	// Shared bearer baked into the template's pod env. Set means warm-pool
	// mode: claims carry no env, and the per-claim token is rotated in at the
	// first /config.
	SentinelToken string
	IdleTTL       time.Duration
	// Tenant pools only take effect in warm-pool mode.
	TenantPools []TenantPool
	Studio      Studio
	// Variants lists the SandboxVariants for GET /images.
	Variants func(ctx context.Context) ([]v1alpha1.SandboxVariant, error)
}

type Deps struct {
	Dynamic dynamic.Interface
	Core    kubernetes.Interface
	// Rest is only needed to port-forward, i.e. without PreviewURLPattern.
	Rest  *rest.Config
	Store store.Store
	// DaemonTransport overrides the transport daemon calls use (tests).
	DaemonTransport http.RoundTripper
}

type timing struct {
	watchPoll, stall     time.Duration
	adoptWait, adoptPoll time.Duration
	goneWait, gonePoll   time.Duration
}

var defaultTiming = timing{
	watchPoll: time.Second, stall: stallTimeout,
	adoptWait: 60 * time.Second, adoptPoll: 200 * time.Millisecond,
	goneWait: 60 * time.Second, gonePoll: 500 * time.Millisecond,
}

// Runner is the agent-sandbox runtime.
type Runner struct {
	cfg       Config
	kube      *kube
	store     store.Store
	daemon    *daemonClient
	fwd       *forwarder
	templates *templateResolver
	pools     []TenantPool
	now       func() time.Time
	newToken  func() string
	timing    timing
}

var _ runtime.Provider = (*Runner)(nil)

func New(deps Deps, cfg Config) (*Runner, error) {
	if cfg.Namespace == "" {
		cfg.Namespace = "agent-sandbox-system"
	}
	if cfg.TemplateName == "" {
		cfg.TemplateName = "studio-sandbox"
	}
	if cfg.IdleTTL == 0 {
		cfg.IdleTTL = defaultIdleTTL
	}
	if !ValidEnvName(cfg.EnvName) {
		return nil, fmt.Errorf("envName %q is not a DNS-label-safe environment name", cfg.EnvName)
	}
	cfg.SentinelToken = strings.TrimSpace(cfg.SentinelToken)
	if cfg.PreviewGateway != nil && cfg.PreviewURLPattern == "" {
		// Hostname and parent together define a route; either alone is meaningless.
		cfg.PreviewGateway = nil
	}
	k := &kube{dyn: deps.Dynamic, core: deps.Core, namespace: cfg.Namespace}
	r := &Runner{
		cfg:    cfg,
		kube:   k,
		store:  deps.Store,
		daemon: newDaemonClient(deps.DaemonTransport),
		fwd:    &forwarder{rest: deps.Rest, core: deps.Core, namespace: cfg.Namespace, forward: map[string]*forward{}},
		now:    time.Now,
		timing: defaultTiming,
		newToken: func() string {
			// 32 bytes, as Studio generated them; the daemon wants 32..256 chars.
			b := make([]byte, 32)
			_, _ = rand.Read(b)
			return hex.EncodeToString(b)
		},
	}
	r.templates = &templateResolver{base: cfg.TemplateName, exists: k.templateExists, now: func() time.Time { return r.now() }, probes: map[string]templateProbe{}}
	if len(cfg.TenantPools) > 0 {
		if cfg.SentinelToken == "" {
			slog.Warn("tenant pools configured without a sentinel token; ignoring them (warm-pool mode is off)")
		} else {
			r.pools = cfg.TenantPools
			slog.Warn("tenant pools bind claims here, but this runtime does not warm their pods yet; the in-process reconciler still must", "pools", len(cfg.TenantPools))
		}
	}
	return r, nil
}

func (r *Runner) warm() bool { return r.cfg.SentinelToken != "" }

func (r *Runner) Close() { r.fwd.closeAll() }

// Probe: the API server answers and the claim CRD is served. Both, because
// credentials against a cluster without the operator place sandboxes that
// never bind.
func (r *Runner) Probe(ctx context.Context) (bool, string) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, err := r.kube.claims().List(ctx, metav1.ListOptions{Limit: 1}); err != nil {
		return false, err.Error()
	}
	return true, ""
}

// persisted is the state blob. Field names match the in-process runner's so a
// row written by either side reads on both.
type persisted struct {
	AdoptedSandboxName string `json:"adoptedSandboxName"`
	// Rows from before warm-pool support.
	PodName      string                  `json:"podName,omitempty"`
	Token        string                  `json:"token"`
	Workdir      string                  `json:"workdir"`
	Workload     *protocol.Workload      `json:"workload"`
	DaemonBootID string                  `json:"daemonBootId,omitempty"`
	Tenant       *protocol.Tenant        `json:"tenant"`
	EnsureOpts   *protocol.EnsureOptions `json:"ensureOpts,omitempty"`
	Image        *protocol.Image         `json:"image,omitempty"`
	Writer       string                  `json:"writer,omitempty"`
}

// record is a sandbox the runner is serving right now.
type record struct {
	id        protocol.SandboxID
	handle    string
	adopted   string
	token     string
	workdir   string
	daemonURL string
	workload  *protocol.Workload
	bootID    string
	tenant    *protocol.Tenant
	opts      *protocol.EnsureOptions
	image     protocol.Image
	// The claim bound a tenant-pool pod, which was warm already.
	poolBound bool
}

func (rec *record) state() persisted {
	img := rec.image
	return persisted{
		AdoptedSandboxName: rec.adopted, Token: rec.token, Workdir: rec.workdir,
		Workload: rec.workload, DaemonBootID: rec.bootID, Tenant: rec.tenant,
		EnsureOpts: rec.opts, Image: &img, Writer: Writer,
	}
}

func (r *Runner) Ensure(ctx context.Context, id protocol.SandboxID, handle string, opts protocol.EnsureOptions) (*runtime.Sandbox, error) {
	var out *runtime.Sandbox
	err := r.store.WithLock(ctx, id, Name, func(ctx context.Context) error {
		sb, err := r.ensureLocked(ctx, id, handle, opts)
		out = sb
		return err
	})
	return out, err
}

func (r *Runner) ensureLocked(ctx context.Context, id protocol.SandboxID, handle string, opts protocol.EnsureOptions) (*runtime.Sandbox, error) {
	// 1. Resume from the row.
	row, err := r.store.Get(ctx, id, Name)
	if err != nil {
		return nil, err
	}
	if row != nil {
		if rec := r.rehydrate(ctx, id, handle, row); rec != nil {
			// The pod's daemon still holds the clone credential from provision,
			// likely expired; forward the fresh one.
			r.refreshGitCredential(ctx, rec, opts)
			r.relayOrgFs(ctx, rec.daemonURL, rec.token, opts.OrgFsConfigJSON)
			// Stamp a row the in-process runner wrote, so its pods stop claiming it.
			return r.finish(ctx, rec, !writtenByUs(row), true)
		}
		if err := r.store.Delete(ctx, id, Name); err != nil {
			return nil, err
		}
	}

	// 2. A claim under our name with no usable row.
	claim, err := r.kube.getClaim(ctx, handle)
	if err != nil {
		slog.Warn("reading existing claim failed; provisioning", "handle", handle, "err", err)
		claim = nil
	}
	if claim != nil {
		switch {
		case claim.DeletionTimestamp != nil:
			// Finalizers still draining; creating now would 409.
			r.waitGoneLogged(ctx, handle)
		case !claim.ready():
			// Left mid-start by an ensure that never finished. Deleting it would
			// restart the node launch and image pull elsewhere, so finish it.
			rec, err := r.join(ctx, id, handle, opts, claim)
			if err == nil {
				return r.finish(ctx, rec, true, true)
			}
			slog.Warn("join of starting claim failed, recreating", "handle", handle, "err", err)
			r.deleteAndWait(ctx, handle)
		default:
			rec, err := r.adopt(ctx, id, handle, opts, claim)
			if err != nil {
				slog.Warn("adopt failed, recreating", "handle", handle, "err", err)
			}
			if rec != nil {
				r.refreshGitCredential(ctx, rec, opts)
				r.relayOrgFs(ctx, rec.daemonURL, rec.token, opts.OrgFsConfigJSON)
				return r.finish(ctx, rec, true, true)
			}
			r.deleteAndWait(ctx, handle)
		}
	}

	// 3. Fresh provision; the claim spec carries the shutdown time already.
	rec, err := r.provision(ctx, id, handle, opts)
	if err != nil {
		return nil, err
	}
	return r.finish(ctx, rec, true, false)
}

func (r *Runner) finish(ctx context.Context, rec *record, persist, patchTTL bool) (*runtime.Sandbox, error) {
	if persist {
		if err := r.store.Put(ctx, rec.id, Name, rec.handle, rec.state()); err != nil {
			return nil, err
		}
	}
	if patchTTL {
		if err := r.kube.patchShutdown(ctx, rec.handle, r.now().Add(r.cfg.IdleTTL)); err != nil {
			slog.Warn("TTL refresh failed", "handle", rec.handle, "err", err)
		}
	}
	return &runtime.Sandbox{
		Handle:          rec.handle,
		Workdir:         rec.workdir,
		PreviewURL:      r.previewURL(rec.handle, rec.daemonURL),
		Daemon:          protocol.Daemon{URL: rec.daemonURL, Token: rec.token},
		Image:           rec.image,
		WarmPoolAdopted: rec.poolBound,
	}, nil
}

// previewURL goes through the gateway hostname in production; locally it is
// the daemon's own port, never the dev server's: the daemon's proxy strips
// CSP/X-Frame and injects the HMR bootstrap the Studio iframe needs.
func (r *Runner) previewURL(handle, daemonURL string) *string {
	u := daemonURL + "/"
	if r.cfg.PreviewURLPattern != "" {
		u = applyPreviewPattern(r.cfg.PreviewURLPattern, handle)
	}
	return &u
}

// daemonURL is in-cluster Service DNS with a preview gateway (Studio shares
// the network), a port-forward otherwise.
func (r *Runner) daemonURL(ctx context.Context, handle, adopted string) (string, error) {
	if r.cfg.PreviewURLPattern != "" {
		return fmt.Sprintf("http://%s.%s.svc.cluster.local:%d", adopted, r.cfg.Namespace, daemonPort), nil
	}
	return r.fwd.url(ctx, handle, adopted)
}

func (r *Runner) tenantPool(opts protocol.EnsureOptions) *TenantPool {
	return resolveTenantPool(r.pools, opts)
}

func requestedImage(opts protocol.EnsureOptions) string {
	if isDefaultImage(opts.SandboxImage) {
		return "default"
	}
	return opts.SandboxImage
}

// imageOfTemplate reads the served image off a claim's template name, for a
// claim this call did not create.
func (r *Runner) imageOfTemplate(template, requested string) protocol.Image {
	served := "default"
	if requested != "default" && strings.HasPrefix(template, r.cfg.TemplateName+"-"+requested) {
		served = requested
	}
	return protocol.Image{Requested: requested, Served: served}
}

func (r *Runner) provision(ctx context.Context, id protocol.SandboxID, handle string, opts protocol.EnsureOptions) (*record, error) {
	// A pod this handle used to point at is being replaced; a forward to it
	// dials a corpse, and would be reused under the same handle.
	r.fwd.close(handle)
	boot := bootSecrets{token: r.newToken(), daemonBootID: newBootID(), workdir: defaultWorkdir}
	// Resolved before the template: a tenant-pool claim must name the template
	// the pool's pods were built from.
	pool := r.tenantPool(opts)
	tmpl, err := r.templates.resolve(ctx, opts.Purpose, pool, opts.SandboxImage)
	if err != nil {
		return nil, err
	}
	claim, dropped := buildClaim(claimInput{
		handle: handle, namespace: r.cfg.Namespace, envName: r.cfg.EnvName,
		opts: opts, boot: boot, template: tmpl.name,
		warmPool: claimWarmPool(pool, r.warm(), tmpl.name),
		warm:     r.warm(), shutdown: r.now().Add(r.cfg.IdleTTL),
	})
	if len(dropped) > 0 {
		slog.Warn("opts.env keys overlap reserved bootstrap names and were dropped", "keys", dropped)
	}
	if err := r.kube.createClaim(ctx, claim); err != nil {
		if !errors.Is(err, errClaimExists) {
			return nil, err
		}
		// A concurrent writer or an external delete finished after the check
		// above: wait it out and retry once.
		if err := r.waitGone(ctx, handle); err != nil {
			return nil, err
		}
		if err := r.kube.createClaim(ctx, claim); err != nil {
			return nil, err
		}
	}
	return r.bind(ctx, id, handle, opts, pool, boot, protocol.Image{Requested: requestedImage(opts), Served: tmpl.image})
}

// bind waits for an existing claim to come up, then routes and configures its
// daemon. It deletes the claim when any step fails: a stuck claim leaks a pod,
// and the next ensure would find it half-bound.
func (r *Runner) bind(ctx context.Context, id protocol.SandboxID, handle string, opts protocol.EnsureOptions, pool *TenantPool, boot bootSecrets, image protocol.Image) (*record, error) {
	cleanup := context.WithoutCancel(ctx)
	release := func(cause error) (*record, error) {
		r.fwd.close(handle)
		if r.cfg.PreviewGateway != nil {
			_ = r.kube.deleteHTTPRoute(cleanup, handle)
		}
		_ = r.kube.deleteClaim(cleanup, handle)
		return nil, cause
	}
	// status.sandbox.name, not the claim name: warm-pool adoption binds a pool
	// pod's generated name, and the operator's adoption race can leave a
	// same-named cold Sandbox beside it.
	adopted, err := r.waitAdopted(ctx, handle)
	if err != nil {
		return release(err)
	}
	if err := r.waitReady(ctx, handle); err != nil {
		return release(err)
	}
	// Port and route before the address reaches the caller, so the gateway
	// has a backend by the time anyone follows the preview link.
	if r.cfg.PreviewURLPattern != "" {
		if err := r.kube.ensureServicePort(ctx, adopted); err != nil {
			return release(err)
		}
	}
	if err := r.ensureRoute(ctx, handle, adopted, opts.Tenant); err != nil {
		return release(err)
	}
	daemonURL, err := r.daemonURL(ctx, handle, adopted)
	if err != nil {
		return release(err)
	}
	// Cold Sandboxes are named after the claim, adopted ones after their pool.
	poolBound := pool != nil && adopted != handle
	payload := workloadConfigPayload(&opts, poolBound)
	bootID := boot.daemonBootID
	if err := r.daemon.waitReady(ctx, daemonURL); err != nil {
		return release(err)
	}
	if r.warm() {
		// The pod booted on the shared sentinel: authenticate with it once and
		// rotate to the per-claim token with the workload. Afterwards only the
		// per-claim token is accepted, which is what stops a recycled pod
		// honouring the previous tenant.
		if h := r.daemon.probeHealth(ctx, daemonURL); h != nil {
			bootID = h.BootId
		}
		if _, err := r.daemon.postConfig(ctx, daemonURL, r.cfg.SentinelToken, payload, boot.token); err != nil {
			var cfgErr *ConfigRequestError
			if errors.As(err, &cfgErr) && cfgErr.Status == http.StatusUnauthorized {
				// The pod already rotated to another claim's token. No local
				// recovery: this token is new to it. Named so the pool reusing a
				// released pod is findable.
				slog.Warn("sentinel rejected by adopted pod: it belongs to another claim; releasing", "handle", handle, "sandbox", adopted)
			}
			return release(bootstrapError(err))
		}
	} else if payload != nil {
		if _, err := r.daemon.postConfig(ctx, daemonURL, boot.token, payload, ""); err != nil {
			return release(bootstrapError(err))
		}
	}
	// Post-bind on purpose: warm-pool claims carry no env.
	r.relayOrgFs(ctx, daemonURL, boot.token, opts.OrgFsConfigJSON)
	return &record{
		id: id, handle: handle, adopted: adopted, token: boot.token, workdir: boot.workdir,
		daemonURL: daemonURL, workload: opts.Workload, bootID: bootID, tenant: opts.Tenant,
		opts: stripEnsureOpts(opts), image: image, poolBound: poolBound,
	}, nil
}

// bootstrapError words a daemon's rejection of the handshake as a retryable
// provisioning failure: the claim is released, and a retry gets another pod.
func bootstrapError(err error) error {
	var cfgErr *ConfigRequestError
	if !errors.As(err, &cfgErr) {
		return err
	}
	return &runtime.Error{
		Code:    protocol.ErrBootstrapRejected,
		Message: fmt.Sprintf("sandbox provisioning failed: the sandbox pod rejected the bootstrap handshake (HTTP %d). The claim was released; retrying gets a different pod.", cfgErr.Status),
		Status:  cfgErr.Status,
		Err:     err,
	}
}

// join binds a claim another ensure created but never finished. A warm pod
// still holds the sentinel until bind rotates it, so a fresh token works; a
// cold pod accepts only the token and boot id in the claim's env.
func (r *Runner) join(ctx context.Context, id protocol.SandboxID, handle string, opts protocol.EnsureOptions, claim *Claim) (*record, error) {
	boot := bootSecrets{workdir: defaultWorkdir}
	if r.warm() {
		boot.token, boot.daemonBootID = r.newToken(), newBootID()
	} else {
		boot.token, boot.daemonBootID = claim.env("DAEMON_TOKEN"), claim.env("DAEMON_BOOT_ID")
	}
	if boot.token == "" || boot.daemonBootID == "" {
		return nil, fmt.Errorf("claim %s carries no daemon token", handle)
	}
	image := r.imageOfTemplate(claim.Spec.TemplateRef.Name, requestedImage(opts))
	return r.bind(ctx, id, handle, opts, r.tenantPool(opts), boot, image)
}

// adopt takes over a ready claim with no row. Only cold claims can be
// adopted: a warm-pool claim's per-claim token lives nowhere but the row, and
// nil sends the caller to delete and reprovision.
func (r *Runner) adopt(ctx context.Context, id protocol.SandboxID, handle string, opts protocol.EnsureOptions, claim *Claim) (*record, error) {
	if !claim.ready() || r.warm() {
		return nil, nil
	}
	token := claim.env("DAEMON_TOKEN")
	if token == "" {
		return nil, nil
	}
	adopted := claim.Status.Sandbox.Name
	if adopted == "" {
		adopted = handle
	}
	daemonURL, err := r.daemonURL(ctx, handle, adopted)
	if err != nil {
		return nil, err
	}
	health := r.daemon.probeHealth(ctx, daemonURL)
	if health == nil {
		r.fwd.close(handle)
		return nil, fmt.Errorf("daemon of %s did not answer /health", handle)
	}
	tenant := readClaimTenant(claim)
	// Backfill for claims provisioned before per-claim routing. Idempotent;
	// failures leave preview unrouted until the next ensure, nothing else.
	if r.cfg.PreviewURLPattern != "" {
		if err := r.kube.ensureServicePort(ctx, adopted); err != nil {
			slog.Warn("Service port backfill failed", "handle", handle, "err", err)
		}
	}
	if err := r.ensureRoute(ctx, handle, adopted, tenant); err != nil {
		slog.Warn("HTTPRoute backfill failed", "handle", handle, "err", err)
	}
	return &record{
		id: id, handle: handle, adopted: adopted, token: token, workdir: defaultWorkdir,
		daemonURL: daemonURL, workload: opts.Workload, bootID: health.BootId, tenant: tenant,
		opts: stripEnsureOpts(opts), image: r.imageOfTemplate(claim.Spec.TemplateRef.Name, requestedImage(opts)),
	}, nil
}

// rehydrate rebuilds a record from its row, or nil on any mismatch (the caller
// drops the row and falls through).
func writtenByUs(row *store.Record) bool {
	var st struct {
		Writer string `json:"writer"`
	}
	return json.Unmarshal(row.State, &st) == nil && st.Writer == Writer
}

func (r *Runner) rehydrate(ctx context.Context, id protocol.SandboxID, handle string, row *store.Record) *record {
	var st persisted
	if json.Unmarshal(row.State, &st) != nil || st.Token == "" || (st.AdoptedSandboxName == "" && st.PodName == "") {
		return nil
	}
	claim, err := r.kube.getClaim(ctx, handle)
	if err != nil || claim == nil || !claim.ready() {
		return nil
	}
	// The operator can rebind on pod recreation; routing follows the claim.
	adopted := claim.Status.Sandbox.Name
	for _, candidate := range []string{st.AdoptedSandboxName, st.PodName, handle} {
		if adopted == "" {
			adopted = candidate
		}
	}
	daemonURL, err := r.daemonURL(ctx, handle, adopted)
	if err != nil {
		return nil
	}
	health := r.daemon.probeHealth(ctx, daemonURL)
	if health == nil {
		r.fwd.close(handle)
		return nil
	}
	// A new boot id is a recreated pod. In warm-pool mode it booted back on the
	// sentinel with neither our token nor the workload, so re-run the handshake
	// with re-minted credentials. In cold mode the env token survives restarts
	// and the daemon resumes on its own.
	if st.DaemonBootID != "" && st.DaemonBootID != health.BootId {
		if r.warm() {
			var opts *protocol.EnsureOptions
			if st.EnsureOpts != nil {
				fresh := r.withFreshCredentials(ctx, *st.EnsureOpts)
				opts = &fresh
			}
			if !r.rebootstrap(ctx, daemonURL, st.Token, opts) {
				r.fwd.close(handle)
				return nil
			}
		} else {
			slog.Warn("daemon restart detected", "handle", handle, "storedBootId", st.DaemonBootID, "liveBootId", health.BootId)
		}
		// So a later rehydrate does not re-fire against a pod already healed.
		st.DaemonBootID = health.BootId
		if err := r.store.Put(ctx, id, Name, handle, st); err != nil {
			slog.Warn("bootId persist failed", "handle", handle, "err", err)
		}
	}
	image := protocol.Image{Requested: "default", Served: "default"}
	if st.Image != nil {
		image = *st.Image
	} else if st.EnsureOpts != nil {
		// Written by the in-process runner, which recorded no served image.
		image = r.imageOfTemplate(claim.Spec.TemplateRef.Name, requestedImage(*st.EnsureOpts))
	}
	workdir := st.Workdir
	if workdir == "" {
		workdir = defaultWorkdir
	}
	return &record{
		id: id, handle: handle, adopted: adopted, token: st.Token, workdir: workdir,
		daemonURL: daemonURL, workload: st.Workload, bootID: health.BootId, tenant: st.Tenant,
		opts: st.EnsureOpts, image: image,
	}
}

// rebootstrap re-runs the warm-pool handshake against a recreated pod: the
// sentinel, the workload, rotation back to the row's token. A sentinel 401
// means the pod already holds our token (a stale boot id sent us here); then
// re-assert the workload with our own token, and only if that fails too is the
// pod not ours.
func (r *Runner) rebootstrap(ctx context.Context, daemonURL, token string, opts *protocol.EnsureOptions) bool {
	if !r.warm() {
		return false
	}
	// A recreated pool pod is empty; nothing warm to preserve.
	payload := workloadConfigPayload(opts, false)
	orgFs := ""
	if opts != nil {
		orgFs = opts.OrgFsConfigJSON
	}
	_, err := r.daemon.postConfig(ctx, daemonURL, r.cfg.SentinelToken, payload, token)
	var cfgErr *ConfigRequestError
	if errors.As(err, &cfgErr) && cfgErr.Status == http.StatusUnauthorized {
		_, err = r.daemon.postConfig(ctx, daemonURL, token, payload, token)
	}
	if err != nil {
		slog.Warn("re-bootstrap failed", "err", err)
		return false
	}
	// The recreated pod's sidecar starts unmounted.
	r.relayOrgFs(ctx, daemonURL, token, orgFs)
	return true
}

func (r *Runner) refreshGitCredential(ctx context.Context, rec *record, opts protocol.EnsureOptions) {
	if opts.Repo == nil {
		return
	}
	patch := gitCredentialRefreshPatch(opts.Repo.CloneURL)
	if patch == nil {
		return
	}
	if _, err := r.daemon.postConfig(ctx, rec.daemonURL, rec.token, patch, ""); err != nil {
		slog.Warn("git credential refresh failed", "handle", rec.handle, "err", err)
	}
}

// relayOrgFs is best-effort: mounts are additive, and a relay failure must
// not fail provisioning or recovery.
func (r *Runner) relayOrgFs(ctx context.Context, daemonURL, token, configJSON string) {
	if configJSON == "" {
		return
	}
	if err := r.daemon.postOrgFsConfig(ctx, daemonURL, token, configJSON); err != nil {
		slog.Warn("org-fs sidecar config relay failed", "err", err)
	}
}

func (r *Runner) ensureRoute(ctx context.Context, handle, adopted string, tenant *protocol.Tenant) error {
	gw := r.cfg.PreviewGateway
	if gw == nil {
		return nil
	}
	host := previewHostname(r.cfg.PreviewURLPattern, handle)
	if host == "" {
		return fmt.Errorf("unable to derive preview hostname for %s from pattern %s", handle, r.cfg.PreviewURLPattern)
	}
	labels := tenantLabels(tenant, map[string]string{
		labelRole:                      "claimed",
		labelSandboxHandle:             handle,
		"app.kubernetes.io/name":       "studio-sandbox",
		"app.kubernetes.io/managed-by": "studio",
	})
	if r.cfg.EnvName != "" {
		labels[labelEnv] = r.cfg.EnvName
	}
	anyLabels := make(map[string]any, len(labels))
	for k, v := range labels {
		anyLabels[k] = v
	}
	// Name and hostname follow the handle so the preview URL survives pool
	// re-adoption; the backend follows the pod actually bound.
	return r.kube.applyHTTPRoute(ctx, map[string]any{
		"apiVersion": "gateway.networking.k8s.io/v1",
		"kind":       "HTTPRoute",
		"metadata":   map[string]any{"name": handle, "namespace": r.cfg.Namespace, "labels": anyLabels},
		"spec": map[string]any{
			"parentRefs": []any{map[string]any{
				"kind": "Gateway", "group": "gateway.networking.k8s.io", "name": gw.Name, "namespace": gw.Namespace,
			}},
			"hostnames": []any{host},
			"rules": []any{map[string]any{"backendRefs": []any{map[string]any{
				"group": "", "kind": "Service", "name": adopted, "port": int64(daemonPort),
			}}}},
		},
	})
}

// waitAdopted polls until the operator records the bound Sandbox. It flips
// once, shortly after creation; 60s tolerates an operator restart.
func (r *Runner) waitAdopted(ctx context.Context, handle string) (string, error) {
	deadline := r.now().Add(r.timing.adoptWait)
	for {
		if c, err := r.kube.getClaim(ctx, handle); err == nil && c != nil && c.Status.Sandbox.Name != "" {
			return c.Status.Sandbox.Name, nil
		}
		if !r.now().Before(deadline) {
			return "", &runtime.Error{Code: protocol.ErrClaimStalled,
				Message: fmt.Sprintf("SandboxClaim %s did not record an adopted Sandbox (status.sandbox.name) within %ds", handle, int(r.timing.adoptWait.Seconds()))}
		}
		if err := sleepCtx(ctx, r.timing.adoptPoll); err != nil {
			return "", err
		}
	}
}

// waitGone polls until the API server has collected the claim: the operator
// deletes it on idle TTL, but finalizers take seconds and recreating inside
// that window 409s.
func (r *Runner) waitGone(ctx context.Context, handle string) error {
	deadline := r.now().Add(r.timing.goneWait)
	for {
		c, err := r.kube.getClaim(ctx, handle)
		if err == nil && c == nil {
			return nil
		}
		if !r.now().Before(deadline) {
			if c != nil {
				// A stuck finalizer is the plausible cause; naming it tells a slow
				// operator from a broken one.
				return fmt.Errorf("SandboxClaim %s still terminating after %s (deletionTimestamp=%v finalizers=%v)", handle, r.timing.goneWait, c.DeletionTimestamp, c.Finalizers)
			}
			return fmt.Errorf("SandboxClaim %s: %w", handle, err)
		}
		if err := sleepCtx(ctx, r.timing.gonePoll); err != nil {
			return err
		}
	}
}

func (r *Runner) waitGoneLogged(ctx context.Context, handle string) {
	if err := r.waitGone(ctx, handle); err != nil {
		slog.Warn("wait for terminating claim failed", "handle", handle, "err", err)
	}
}

func (r *Runner) deleteAndWait(ctx context.Context, handle string) {
	if err := r.kube.deleteClaim(ctx, handle); err != nil {
		slog.Warn("delete claim failed", "handle", handle, "err", err)
	}
	r.waitGoneLogged(ctx, handle)
}

// stripEnsureOpts is what a persisted row keeps for resurrection. extraRepos
// included: without them a resurrected sandbox loses its secondary checkouts.
// The clone URL is kept on purpose (recovery re-mints from its connection),
// which makes the row as sensitive as the vault.
func stripEnsureOpts(opts protocol.EnsureOptions) *protocol.EnsureOptions {
	out := protocol.EnsureOptions{
		Purpose: opts.Purpose, SandboxImage: opts.SandboxImage, Branch: opts.Branch,
		Repo: opts.Repo, ExtraRepos: opts.ExtraRepos, Workload: opts.Workload,
		CloneOnly: opts.CloneOnly, Tenant: opts.Tenant, OrgFsConfigJSON: opts.OrgFsConfigJSON,
	}
	if len(opts.Env) > 0 {
		out.Env = opts.Env
	}
	if out.Purpose == "" && out.SandboxImage == "" && out.Branch == "" && out.Repo == nil && len(out.ExtraRepos) == 0 &&
		out.Workload == nil && !out.CloneOnly && out.Tenant == nil && out.OrgFsConfigJSON == "" && out.Env == nil {
		return nil
	}
	return &out
}

func newBootID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
