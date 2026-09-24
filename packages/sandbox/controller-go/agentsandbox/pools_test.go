package agentsandbox

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	k8stesting "k8s.io/client-go/testing"
)

const mintedPoolURL = "https://x-access-token:minted@github.com/acme/site.git"

func warmPoolObject(name, selector string) *unstructured.Unstructured {
	u := &unstructured.Unstructured{Object: map[string]any{"status": map[string]any{}}}
	u.SetAPIVersion(claimAPIVersion)
	u.SetKind("SandboxWarmPool")
	u.SetNamespace(ns)
	u.SetName(name)
	if selector != "" {
		u.Object["status"] = map[string]any{"selector": selector}
	}
	return u
}

type poolHarness struct {
	*harness
	clock time.Time
}

// newPoolHarness has one pool, tenant-acme, whose pods carry pool=tenant-acme.
func newPoolHarness(t *testing.T, pool *unstructured.Unstructured, pods ...*corev1.Pod) *poolHarness {
	t.Helper()
	pools := mustPools(t, `[{"name":"tenant-acme","orgId":"org_acme","repo":"acme/site","connectionId":"conn-1"}]`)
	var objects []k8sruntime.Object
	if pool != nil {
		objects = append(objects, pool)
	}
	h := &poolHarness{harness: newHarness(t, Config{Namespace: ns, SentinelToken: sentinel, TenantPools: pools}, objects...), clock: time.Unix(1_000_000, 0)}
	h.daemon.token = sentinel
	h.studio.cloneURL = mintedPoolURL
	h.runner.now = func() time.Time { return h.clock }
	for _, p := range pods {
		if _, err := h.core.CoreV1().Pods(ns).Create(context.Background(), p, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	return h
}

func poolPod(name, ip string, phase corev1.PodPhase, handle string) *corev1.Pod {
	labels := map[string]string{"pool": "tenant-acme"}
	if handle != "" {
		labels[labelSandboxHandle] = handle
	}
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, UID: types.UID("uid-" + name), Labels: labels},
		Status:     corev1.PodStatus{Phase: phase, PodIP: ip},
	}
}

func (h *poolHarness) reconcile() {
	h.t.Helper()
	if err := h.runner.reconcileTenantPools(context.Background()); err != nil {
		h.t.Fatal(err)
	}
}

func (h *poolHarness) configs() int {
	h.daemon.mu.Lock()
	defer h.daemon.mu.Unlock()
	return len(h.daemon.configs)
}

func poolGauge(state string) float64 {
	return testutil.ToFloat64(PoolPodsMetric.WithLabelValues("tenant-acme", "org_acme", state))
}

func TestTenantPoolWarmsUnboundPodsOnly(t *testing.T) {
	h := newPoolHarness(t, warmPoolObject("tenant-acme", "pool=tenant-acme"),
		poolPod("tenant-acme-a", "10.0.0.7", corev1.PodRunning, ""),
		poolPod("tenant-acme-b", "10.0.0.8", corev1.PodRunning, "main-abc"),
		poolPod("tenant-acme-c", "10.0.0.9", corev1.PodPending, ""),
	)
	h.reconcile()
	if h.configs() != 1 {
		t.Fatalf("config posts = %d, want 1 (the Running unbound pod)", h.configs())
	}
	call := h.daemon.lastConfig(t)
	git, _ := call.body["git"].(map[string]any)
	repo, _ := git["repository"].(map[string]any)
	if call.bearer != sentinel || call.body["auth"] != nil {
		t.Fatalf("an unbound pod is configured on the sentinel, with no rotation: %+v", call)
	}
	if repo["cloneUrl"] != mintedPoolURL || repo["branch"] != "main" {
		t.Fatalf("repository = %+v", repo)
	}
	// No identity: the daemon keeps an identity-less pod unclaimed, which keeps
	// the housekeeper's idle sweep off it.
	if _, ok := git["identity"]; ok {
		t.Fatalf("identity sent to an unbound pod: %+v", git)
	}
	if h.studio.mints[0].ConnectionID != "conn-1" {
		t.Fatalf("mint = %+v", h.studio.mints[0])
	}
	if got := h.daemon.hosts[len(h.daemon.hosts)-1]; got != "10.0.0.7:9000" {
		t.Fatalf("daemon reached at %s, want the pod IP", got)
	}
	if len(h.daemon.steps) != 0 {
		t.Fatalf("a first sight must not restart dev: %v", h.daemon.steps)
	}
	if poolGauge("ready") != 1 || poolGauge("bound") != 1 || poolGauge("pending") != 0 || poolGauge("failed") != 0 {
		t.Fatalf("gauge ready=%v bound=%v pending=%v failed=%v", poolGauge("ready"), poolGauge("bound"), poolGauge("pending"), poolGauge("failed"))
	}
}

func TestTenantPoolRefresh(t *testing.T) {
	h := newPoolHarness(t, warmPoolObject("tenant-acme", "pool=tenant-acme"), poolPod("tenant-acme-a", "10.0.0.7", corev1.PodRunning, ""))
	h.reconcile()
	h.daemon.transition = "git-credential-refresh"

	h.clock = h.clock.Add(tenantPoolRefresh - time.Second)
	h.reconcile()
	if h.configs() != 1 {
		t.Fatalf("a warm pod inside the refresh interval was touched: %d posts", h.configs())
	}

	h.clock = h.clock.Add(time.Second)
	h.reconcile()
	if h.configs() != 2 || !reflect.DeepEqual(h.daemon.steps, []string{"clone:" + sentinel}) {
		t.Fatalf("posts=%d steps=%v, want a config post and a clone step", h.configs(), h.daemon.steps)
	}

	// A config post that bootstraps clones already: no extra step.
	h.daemon.transition = "bootstrap"
	h.clock = h.clock.Add(tenantPoolRefresh)
	h.reconcile()
	if len(h.daemon.steps) != 1 {
		t.Fatalf("steps = %v", h.daemon.steps)
	}
}

func TestTenantPoolPushMarksDirty(t *testing.T) {
	h := newPoolHarness(t, warmPoolObject("tenant-acme", "pool=tenant-acme"), poolPod("tenant-acme-a", "10.0.0.7", corev1.PodRunning, ""))
	h.reconcile()
	h.daemon.transition = "git-credential-refresh"
	if got := h.runner.MarkTenantPoolsDirty("Acme/Site", "refs/heads/dev"); len(got) != 0 {
		t.Fatalf("another branch marked %v", got)
	}
	if got := h.runner.MarkTenantPoolsDirty("Acme/Site", "refs/heads/main"); !reflect.DeepEqual(got, []string{"tenant-acme"}) {
		t.Fatalf("marked %v", got)
	}
	h.runner.MarkTenantPoolsDirty("acme/site", "refs/heads/main")
	h.reconcile()
	if h.configs() != 2 || len(h.daemon.steps) != 1 {
		t.Fatalf("posts=%d steps=%v, want one refresh for the burst", h.configs(), h.daemon.steps)
	}
	h.reconcile()
	if h.configs() != 2 {
		t.Fatal("the mark must be drained by the tick that used it")
	}
}

func TestTenantPoolMintFailureBacksOff(t *testing.T) {
	h := newPoolHarness(t, warmPoolObject("tenant-acme", "pool=tenant-acme"), poolPod("tenant-acme-a", "10.0.0.7", corev1.PodRunning, ""))
	// The pool names a connection but the mint gives nothing: posting the
	// anonymous URL would clone a private repo without credentials.
	h.studio.cloneURL = ""
	for i := 0; i < tenantPoolMaxFailures+2; i++ {
		h.reconcile()
	}
	if h.configs() != 0 {
		t.Fatalf("config posted with an anonymous URL: %d", h.configs())
	}
	if len(h.studio.mints) != tenantPoolMaxFailures {
		t.Fatalf("mints = %d, want the cap %d then hands off", len(h.studio.mints), tenantPoolMaxFailures)
	}
	if poolGauge("failed") != 1 || poolGauge("ready") != 0 {
		t.Fatalf("gauge failed=%v ready=%v", poolGauge("failed"), poolGauge("ready"))
	}
	// After the cooldown it gets one more chance.
	h.studio.cloneURL = mintedPoolURL
	h.clock = h.clock.Add(tenantPoolGiveUpCooldown)
	h.reconcile()
	if h.configs() != 1 || poolGauge("ready") != 1 || poolGauge("failed") != 0 {
		t.Fatalf("posts=%d ready=%v failed=%v after the cooldown", h.configs(), poolGauge("ready"), poolGauge("failed"))
	}
}

func TestTenantPoolDaemonFailureCounts(t *testing.T) {
	h := newPoolHarness(t, warmPoolObject("tenant-acme", "pool=tenant-acme"), poolPod("tenant-acme-a", "10.0.0.7", corev1.PodRunning, ""))
	h.daemon.reject = true
	h.reconcile()
	h.reconcile()
	st := h.runner.poolWarmer.pods["tenant-acme"]["uid-tenant-acme-a"]
	if st.failures != 2 || !st.lastConfigAt.IsZero() {
		t.Fatalf("state = %+v", st)
	}
}

func TestTenantPoolLeavesAPodBoundMeanwhile(t *testing.T) {
	h := newPoolHarness(t, warmPoolObject("tenant-acme", "pool=tenant-acme"), poolPod("tenant-acme-a", "10.0.0.7", corev1.PodRunning, ""))
	// The listing saw it unbound; the re-read before the post does not.
	h.core.PrependReactor("get", "pods", func(k8stesting.Action) (bool, k8sruntime.Object, error) {
		return true, poolPod("tenant-acme-a", "10.0.0.7", corev1.PodRunning, "main-abc"), nil
	})
	h.reconcile()
	if h.configs() != 0 {
		t.Fatal("a pod bound between listing and post had its tree touched")
	}
}

func TestTenantPoolWithoutAPoolObject(t *testing.T) {
	for name, pool := range map[string]*unstructured.Unstructured{
		"no SandboxWarmPool": nil,
		"no selector yet":    warmPoolObject("tenant-acme", ""),
	} {
		t.Run(name, func(t *testing.T) {
			h := newPoolHarness(t, pool, poolPod("tenant-acme-a", "10.0.0.7", corev1.PodRunning, ""))
			h.reconcile()
			if h.configs() != 0 {
				t.Fatal("warmed pods of a pool it cannot resolve")
			}
		})
	}
}

func TestTenantPoolForgetsDeletedPods(t *testing.T) {
	h := newPoolHarness(t, warmPoolObject("tenant-acme", "pool=tenant-acme"), poolPod("tenant-acme-a", "10.0.0.7", corev1.PodRunning, ""))
	h.reconcile()
	if err := h.core.CoreV1().Pods(ns).Delete(context.Background(), "tenant-acme-a", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	h.reconcile()
	if n := len(h.runner.poolWarmer.pods["tenant-acme"]); n != 0 {
		t.Fatalf("%d entries kept for deleted pods", n)
	}
}

func TestTenantPoolsNeedTheSentinel(t *testing.T) {
	pools := mustPools(t, `[{"name":"tenant-acme","orgId":"org_acme","repo":"acme/site"}]`)
	h := newHarness(t, Config{Namespace: ns, TenantPools: pools})
	if len(h.runner.pools) != 0 {
		t.Fatal("tenant pools without warm-pool mode must be ignored")
	}
}
