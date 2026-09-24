package agentsandbox

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"

	daemon "github.com/decocms/studio/sandbox-daemon/pkg/protocol"

	"github.com/decocms/studio/packages/sandbox/controller-go/daemonclient"
	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
)

const (
	// Fast enough that a replaced pod re-warms promptly, slow enough that a
	// steady-state pool costs one list.
	tenantPoolTick = 60 * time.Second
	// Under the ~1h clone-token lifetime: the refresh IS the credential refresh.
	tenantPoolRefresh     = 30 * time.Minute
	tenantPoolMaxFailures = 3
	// A pod at the failure cap is left alone this long, then tried once more:
	// the counter also catches transient failures, and this bookkeeping is
	// in-memory, so nothing else would ever un-stick the pod.
	tenantPoolGiveUpCooldown = 30 * time.Minute
)

var WarmPoolGVR = schema.GroupVersionResource{Group: "extensions.agents.x-k8s.io", Version: "v1alpha1", Resource: "sandboxwarmpools"}

// PoolPodsMetric is pool depth by state. `ready` counts pods whose config post
// succeeded, not pods serving a dev server: a pool too small for its claim
// rate reads full while every claim starts cold. Alert on sustained ready=0;
// RBAC and a bootstrap that never completes both produce it silently.
var PoolPodsMetric = prometheus.NewGaugeVec(prometheus.GaugeOpts{
	Name: "studio_sandbox_pool_pods",
	Help: "Tenant warm-pool pods by state (ready, bound, pending, failed).",
}, []string{"pool", "org", "state"})

type warmPoolPod struct {
	name   string
	uid    types.UID
	ip     string
	labels map[string]string
}

type poolPodState struct {
	lastConfigAt  time.Time
	lastFailureAt time.Time
	failures      int
}

// poolWarmer is per-pool, per-pod bookkeeping: "when did I last touch this
// pod". Losing it costs one redundant, idempotent config post per pod.
type poolWarmer struct {
	refresh time.Duration
	// Keyed by pool, then pod UID.
	pods map[string]map[types.UID]poolPodState

	mu    sync.Mutex
	dirty map[string]bool
}

func newPoolWarmer() *poolWarmer {
	return &poolWarmer{refresh: tenantPoolRefresh, pods: map[string]map[types.UID]poolPodState{}, dirty: map[string]bool{}}
}

// poolsMatchingPush are the pools a GitHub push makes stale. The branch match
// is case-sensitive (git refs are); the repo match is not (GitHub's names
// aren't). A tag push is not refs/heads/ and matches nothing.
func poolsMatchingPush(pools []TenantPool, repoFullName, ref string) []TenantPool {
	branch := strings.TrimPrefix(ref, "refs/heads/")
	var out []TenantPool
	for _, p := range pools {
		if strings.EqualFold(p.Repo, repoFullName) && p.Branch == branch {
			out = append(out, p)
		}
	}
	return out
}

// poolCloneURL is anonymous; the credential is minted per bootstrap.
func poolCloneURL(pool *TenantPool) string {
	return "https://github.com/" + pool.Repo + ".git"
}

// MarkTenantPoolsDirty refreshes a pushed-to pool's unbound pods on the next
// tick; a burst of pushes collapses into one refresh. An accelerator only:
// without it the periodic refresh picks the commits up anyway. The mark is in
// this replica's memory and only the leader warms, so a mark on a follower is
// lost to that periodic refresh.
func (r *Runner) MarkTenantPoolsDirty(repoFullName, ref string) []string {
	matched := poolsMatchingPush(r.pools, repoFullName, ref)
	names := make([]string, 0, len(matched))
	r.poolWarmer.mu.Lock()
	for _, p := range matched {
		r.poolWarmer.dirty[p.Name] = true
		names = append(names, p.Name)
	}
	r.poolWarmer.mu.Unlock()
	return names
}

func (w *poolWarmer) takeDirty(pool string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	dirty := w.dirty[pool]
	delete(w.dirty, pool)
	return dirty
}

// RunTenantPools keeps every tenant pool's unbound pods cloned, installed and
// running the pool's branch until ctx ends. The pool objects are the chart's;
// this only warms their pods, because the clone credential is a ~1h token that
// cannot live in the template's env, and a pod holding only the shared
// sentinel must never be able to ask for a tenant's credential. Run it on one
// replica: every warm mints a credential.
func (r *Runner) RunTenantPools(ctx context.Context) error {
	if len(r.pools) == 0 {
		<-ctx.Done()
		return nil
	}
	for {
		if err := r.reconcileTenantPools(ctx); err != nil && ctx.Err() == nil {
			slog.Warn("tenant pool reconcile failed", "err", err)
		}
		if daemonclient.Sleep(ctx, tenantPoolTick) != nil {
			return nil
		}
	}
}

func (r *Runner) reconcileTenantPools(ctx context.Context) error {
	for i := range r.pools {
		pool := &r.pools[i]
		pods, err := r.kube.warmPoolPods(ctx, pool.Name)
		if err != nil {
			return err
		}
		if pods == nil {
			slog.Warn("tenant pool has no SandboxWarmPool (or no selector yet)", "pool", pool.Name, "namespace", r.cfg.Namespace)
			continue
		}
		dirty := r.poolWarmer.takeDirty(pool.Name)
		// A bound pod carries the claim's handle label. Never touch one: the
		// user has a working tree on it, and a hard reset is data loss.
		var unbound []warmPoolPod
		live := map[types.UID]bool{}
		for _, pod := range pods {
			live[pod.uid] = true
			if pod.labels[labelSandboxHandle] == "" {
				unbound = append(unbound, pod)
			}
		}
		states := r.poolWarmer.pods[pool.Name]
		if states == nil {
			states = map[types.UID]poolPodState{}
			r.poolWarmer.pods[pool.Name] = states
		}
		for uid := range states {
			if !live[uid] {
				delete(states, uid)
			}
		}
		// Sequential: a whole pool reinstalling at once is a thundering herd on
		// the registry and the node.
		for _, pod := range unbound {
			if ctx.Err() != nil {
				return nil
			}
			r.warmPoolPod(ctx, pool, pod, dirty, states)
		}
		recordPoolDepth(pool, len(pods), unbound, states)
	}
	return nil
}

func recordPoolDepth(pool *TenantPool, total int, unbound []warmPoolPod, states map[types.UID]poolPodState) {
	ready, failed := 0, 0
	for _, pod := range unbound {
		seen, ok := states[pod.uid]
		switch {
		case !ok:
		case seen.failures >= tenantPoolMaxFailures:
			failed++
		case !seen.lastConfigAt.IsZero():
			ready++
		}
	}
	set := func(state string, n int) {
		PoolPodsMetric.WithLabelValues(pool.Name, pool.OrgID, state).Set(float64(n))
	}
	set("ready", ready)
	set("bound", total-len(unbound))
	set("pending", len(unbound)-ready-failed)
	set("failed", failed)
}

func (r *Runner) warmPoolPod(ctx context.Context, pool *TenantPool, pod warmPoolPod, dirty bool, states map[types.UID]poolPodState) {
	seen, known := states[pod.uid]
	// A pod that fails repeatedly (bad lockfile, private submodule, no `dev`
	// script) would be retried forever while the pool looks full.
	if known && seen.failures >= tenantPoolMaxFailures {
		if r.now().Sub(seen.lastFailureAt) < tenantPoolGiveUpCooldown {
			return
		}
		reset := seen
		reset.failures = 0
		states[pod.uid] = reset
	}
	// A refresh re-fetches the branch and restarts dev. A first sight does
	// not: this replica may have just restarted under a pool already warm, and
	// bouncing every dev server on boot is a self-inflicted outage. The config
	// post still happens, rotating a stale credential.
	refresh := dirty || (known && r.now().Sub(seen.lastConfigAt) >= r.poolWarmer.refresh)
	if known && !refresh {
		return
	}
	fail := func(reason string) { r.recordPoolFailure(pool, pod, reason, states) }

	// No user: the daemon leaves `claimed` false for an identity-less config,
	// which keeps the housekeeper's idle sweep off an unbound pod.
	repo := &protocol.EnsureRepo{CloneURL: poolCloneURL(pool), ConnectionID: pool.ConnectionID, Branch: pool.Branch}
	fresh := daemonclient.FreshCloneURL(ctx, r.cfg.Studio, repo, 0)
	if pool.ConnectionID != "" && fresh.CloneURL == repo.CloneURL {
		// The anonymous URL would clone a private repo without credentials, or
		// leave the pod on a remote the user cannot push to. The next tick retries.
		fail("clone credential mint failed")
		return
	}
	daemonURL, closeURL, err := r.poolDaemonURL(ctx, pod)
	if err != nil {
		fail("daemon unreachable: " + err.Error())
		return
	}
	defer closeURL()
	if err := r.daemon.WaitReady(ctx, daemonURL); err != nil {
		fail(err.Error())
		return
	}
	// Re-checked before each step that touches the tree: the listing is a
	// snapshot, and a claim binding this pod meanwhile would otherwise get
	// its working tree hard-reset. Worst case the user gets one extra restart.
	if !r.kube.podUnbound(ctx, pod.name) {
		return
	}
	// The daemon classifies this itself: bootstrap on a fresh pod (clone,
	// install, dev), a credential refresh on one already warm.
	res, err := r.daemon.PostConfig(ctx, daemonURL, r.cfg.SentinelToken, poolConfigPayload(pool, fresh), "")
	if err != nil {
		fail(err.Error())
		return
	}
	// A bootstrap clones already. Anything else only updated stored config,
	// so a refresh asks for the fetch, reset and restart itself.
	if refresh && res.Transition != "bootstrap" && r.kube.podUnbound(ctx, pod.name) {
		if err := r.daemon.PostSetupStep(ctx, daemonURL, r.cfg.SentinelToken, "clone"); err != nil {
			fail(err.Error())
			return
		}
	}
	states[pod.uid] = poolPodState{lastConfigAt: r.now()}
	slog.Info("tenant pool pod warmed", "pool", pool.Name, "pod", pod.name, "transition", res.Transition)
}

func (r *Runner) recordPoolFailure(pool *TenantPool, pod warmPoolPod, reason string, states map[types.UID]poolPodState) {
	prev := states[pod.uid]
	failures := prev.failures + 1
	states[pod.uid] = poolPodState{lastConfigAt: prev.lastConfigAt, lastFailureAt: r.now(), failures: failures}
	attrs := []any{"pool", pool.Name, "pod", pod.name, "failures", strconv.Itoa(failures) + "/" + strconv.Itoa(tenantPoolMaxFailures), "reason", reason}
	if failures >= tenantPoolMaxFailures {
		attrs = append(attrs, "backoff", tenantPoolGiveUpCooldown)
	}
	slog.Warn("warming tenant pool pod failed", attrs...)
}

// poolDaemonURL reaches an unbound pool pod by its IP where the controller
// shares the sandbox network: its Sandbox's Service only gets the daemon port
// when a claim binds it. Elsewhere, a port-forward closed after the warm.
func (r *Runner) poolDaemonURL(ctx context.Context, pod warmPoolPod) (string, func(), error) {
	if r.cfg.PreviewURLPattern != "" {
		if pod.ip == "" {
			return "", nil, errors.New("pod has no IP yet")
		}
		return "http://" + net.JoinHostPort(pod.ip, strconv.Itoa(daemonPort)), func() {}, nil
	}
	// Handles carry no "/", so this key never collides with a claim's forward.
	key := "pool/" + pod.name
	u, err := r.fwd.url(ctx, key, pod.name)
	if err != nil {
		return "", nil, err
	}
	return u, func() { r.fwd.close(key) }, nil
}

func poolConfigPayload(pool *TenantPool, repo *protocol.EnsureRepo) *daemon.TenantConfig {
	w := pool.Workload
	if w == nil {
		w = &PoolWorkload{Runtime: "node"}
	}
	return daemonclient.PoolConfig(repo, w.Runtime, w.PackageManager, w.PackageManagerPath, w.DevPort)
}

// warmPoolPods are a pool's Running pods, read through the pool's own
// status.selector: the operator hashes it from the pool identity, so a label
// guessed here would silently match nothing after an operator upgrade. Nil
// when the pool does not exist or has not published a selector yet.
func (k *kube) warmPoolPods(ctx context.Context, pool string) ([]warmPoolPod, error) {
	u, err := k.dyn.Resource(WarmPoolGVR).Namespace(k.namespace).Get(ctx, pool, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get SandboxWarmPool %s: %w", pool, err)
	}
	selector, _, _ := unstructured.NestedString(u.Object, "status", "selector")
	if selector == "" {
		return nil, nil
	}
	list, err := k.core.CoreV1().Pods(k.namespace).List(ctx, metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return nil, fmt.Errorf("list pods of SandboxWarmPool %s: %w", pool, err)
	}
	out := []warmPoolPod{}
	for _, p := range list.Items {
		if p.Status.Phase != corev1.PodRunning || p.Name == "" || p.UID == "" {
			continue
		}
		out = append(out, warmPoolPod{name: p.Name, uid: p.UID, ip: p.Status.PodIP, labels: p.Labels})
	}
	return out, nil
}

// podUnbound errs on "don't touch it": a missing pod or a failed read is false.
func (k *kube) podUnbound(ctx context.Context, name string) bool {
	pod, err := k.core.CoreV1().Pods(k.namespace).Get(ctx, name, metav1.GetOptions{})
	return err == nil && pod.Labels[labelSandboxHandle] == ""
}
