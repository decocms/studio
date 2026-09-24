package agentsandbox

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8sfake "k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/decocms/studio/packages/sandbox/controller-go/api/v1alpha1"
	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
	"github.com/decocms/studio/packages/sandbox/controller-go/runtime"
	"github.com/decocms/studio/packages/sandbox/controller-go/store/storetest"
)

const (
	ns       = "agent-sandbox-system"
	sentinel = "sentinel-sentinel-sentinel-sentinel"
)

var testID = protocol.SandboxID{UserID: "u_1", ProjectRef: "agent:org:vmcp:main"}

// fakeDaemon answers like the daemon: /health, and /config that honours the
// current bearer and applies auth.rotateToken before anything else.
type fakeDaemon struct {
	mu      sync.Mutex
	bootID  string
	token   string
	configs []configCall
	orgFs   []string
	hosts   []string
	reject  bool
}

type configCall struct {
	bearer string
	body   map[string]any
}

func (d *fakeDaemon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.hosts = append(d.hosts, r.Header.Get("x-original-host"))
	switch r.URL.Path {
	case "/health":
		_, _ = io.WriteString(w, `{"ready":true,"bootId":"`+d.bootID+`","configured":false,"setup":{"running":false,"done":true}}`)
	case "/_sandbox/config":
		bearer := strings.TrimPrefix(r.Header.Get("authorization"), "Bearer ")
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		d.configs = append(d.configs, configCall{bearer: bearer, body: body})
		if d.reject || bearer != d.token {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":"unauthorized"}`)
			return
		}
		if auth, ok := body["auth"].(map[string]any); ok {
			d.token = auth["rotateToken"].(string)
		}
		_, _ = io.WriteString(w, `{"bootId":"`+d.bootID+`","transition":"bootstrap","config":{}}`)
	case "/_sandbox/orgfs-config":
		b, _ := io.ReadAll(r.Body)
		d.orgFs = append(d.orgFs, string(b))
		_, _ = io.WriteString(w, `{"written":true}`)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (d *fakeDaemon) lastConfig(t *testing.T) configCall {
	t.Helper()
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.configs) == 0 {
		t.Fatal("no /config call")
	}
	return d.configs[len(d.configs)-1]
}

// redirect sends every daemon call to the fake, keeping the address the
// runtime chose in a header.
type redirect struct{ target *url.URL }

func (rt redirect) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.Header.Set("x-original-host", req.URL.Host)
	req.URL.Scheme, req.URL.Host = rt.target.Scheme, rt.target.Host
	return http.DefaultTransport.RoundTrip(req)
}

type fakeStudio struct {
	cloneURL, orgFs string
	mints           []protocol.EnsureRepo
}

func (s *fakeStudio) MintCloneURL(_ context.Context, repo protocol.EnsureRepo, _ int64) (string, error) {
	s.mints = append(s.mints, repo)
	return s.cloneURL, nil
}

func (s *fakeStudio) MintOrgFsConfig(context.Context, protocol.Tenant) (string, error) {
	return s.orgFs, nil
}

type harness struct {
	t       *testing.T
	dyn     *dynamicfake.FakeDynamicClient
	core    *k8sfake.Clientset
	store   *storetest.Memory
	daemon  *fakeDaemon
	runner  *Runner
	studio  *fakeStudio
	applies []k8stesting.PatchAction
	// bind is what the fake operator writes into a created claim's status;
	// empty leaves it unbound.
	bind      func(name string) string
	ready     bool
	createdMu sync.Mutex
	created   []*Claim
	deleted   []string
}

func newHarness(t *testing.T, cfg Config, objects ...k8sruntime.Object) *harness {
	h := &harness{t: t, daemon: &fakeDaemon{bootID: "boot-1"}, store: storetest.NewMemory(), studio: &fakeStudio{}, ready: true,
		bind: func(name string) string { return name }}
	h.dyn = dynamicfake.NewSimpleDynamicClientWithCustomListKinds(k8sruntime.NewScheme(), map[schema.GroupVersionResource]string{
		ClaimGVR: "SandboxClaimList", TemplateGVR: "SandboxTemplateList", HTTPRouteGVR: "HTTPRouteList",
	}, objects...)
	h.core = k8sfake.NewSimpleClientset()
	record := func(action k8stesting.Action) (bool, k8sruntime.Object, error) {
		h.applies = append(h.applies, action.(k8stesting.PatchAction))
		return true, &corev1.Service{}, nil
	}
	h.core.PrependReactor("patch", "services", record)
	h.dyn.PrependReactor("patch", "httproutes", func(a k8stesting.Action) (bool, k8sruntime.Object, error) {
		h.applies = append(h.applies, a.(k8stesting.PatchAction))
		return true, &unstructured.Unstructured{Object: map[string]any{}}, nil
	})
	// The operator: bind and ready a claim the moment it is created.
	h.dyn.PrependReactor("create", "sandboxclaims", func(a k8stesting.Action) (bool, k8sruntime.Object, error) {
		u := a.(k8stesting.CreateAction).GetObject().(*unstructured.Unstructured)
		var c Claim
		_ = k8sruntime.DefaultUnstructuredConverter.FromUnstructured(u.Object, &c)
		h.createdMu.Lock()
		h.created = append(h.created, &c)
		h.createdMu.Unlock()
		if name := h.bind(c.Name); name != "" {
			status := map[string]any{"sandbox": map[string]any{"name": name}}
			if h.ready {
				status["conditions"] = []any{map[string]any{"type": "Ready", "status": "True", "reason": "Ready", "lastTransitionTime": "2026-09-24T00:00:00Z", "message": ""}}
			}
			u.Object["status"] = status
		}
		return false, nil, nil
	})
	h.dyn.PrependReactor("delete", "sandboxclaims", func(a k8stesting.Action) (bool, k8sruntime.Object, error) {
		h.createdMu.Lock()
		h.deleted = append(h.deleted, a.(k8stesting.DeleteAction).GetName())
		h.createdMu.Unlock()
		return false, nil, nil
	})
	srv := httptest.NewServer(h.daemon)
	t.Cleanup(srv.Close)
	target, _ := url.Parse(srv.URL)
	if cfg.PreviewURLPattern == "" {
		cfg.PreviewURLPattern = "https://{handle}.preview.example.com"
	}
	if cfg.Studio == nil {
		cfg.Studio = h.studio
	}
	r, err := New(Deps{Dynamic: h.dyn, Core: h.core, Store: h.store, DaemonTransport: redirect{target}}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	r.timing = timing{watchPoll: 5 * time.Millisecond, stall: 2 * time.Second, adoptWait: 2 * time.Second, adoptPoll: 5 * time.Millisecond, goneWait: 2 * time.Second, gonePoll: 5 * time.Millisecond}
	r.daemon.sleep = func(context.Context, time.Duration) error { return nil }
	r.newToken = func() string { return strings.Repeat("a", 64) }
	h.runner = r
	h.daemon.token = "unset"
	return h
}

func (h *harness) claim(name string) *Claim {
	c, err := h.runner.kube.getClaim(context.Background(), name)
	if err != nil {
		h.t.Fatal(err)
	}
	return c
}

func (h *harness) persisted() persisted {
	h.t.Helper()
	rec, err := h.store.Get(context.Background(), testID, Name)
	if err != nil || rec == nil {
		h.t.Fatalf("no row: %v", err)
	}
	var st persisted
	if err := json.Unmarshal(rec.State, &st); err != nil {
		h.t.Fatal(err)
	}
	return st
}

func claimObject(t *testing.T, c *Claim) *unstructured.Unstructured {
	c.TypeMeta = metav1.TypeMeta{APIVersion: claimAPIVersion, Kind: claimKind}
	if c.Namespace == "" {
		c.Namespace = ns
	}
	obj, err := k8sruntime.DefaultUnstructuredConverter.ToUnstructured(c)
	if err != nil {
		t.Fatal(err)
	}
	return &unstructured.Unstructured{Object: obj}
}

func templateObject(name string) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetAPIVersion(claimAPIVersion)
	u.SetKind("SandboxTemplate")
	u.SetNamespace(ns)
	u.SetName(name)
	return u
}

var readyCond = []metav1.Condition{{Type: "Ready", Status: metav1.ConditionTrue, Reason: "Ready", LastTransitionTime: metav1.Now()}}

func TestProvisionCold(t *testing.T) {
	h := newHarness(t, Config{Namespace: ns, PreviewGateway: &Gateway{Name: "gw", Namespace: "istio"}, EnvName: "prod"})
	// Cold: the daemon accepts the per-claim token from the claim's env.
	h.daemon.token = strings.Repeat("a", 64)
	opts := protocol.EnsureOptions{
		Repo:            &protocol.EnsureRepo{CloneURL: "https://x-access-token:t@github.com/acme/site.git", UserName: "Ana", UserEmail: "ana@acme.dev"},
		OrgFsConfigJSON: `{"mounts":[]}`,
		Tenant:          &protocol.Tenant{OrgID: "org_1", UserID: "u_1"},
	}
	sb, err := h.runner.Ensure(context.Background(), testID, "main-abc", opts)
	if err != nil {
		t.Fatal(err)
	}
	c := h.created[0]
	if c.Spec.WarmPool != "none" || c.env("DAEMON_TOKEN") != sb.Daemon.Token || c.Spec.TemplateRef.Name != "studio-sandbox" {
		t.Fatalf("claim = %+v", c.Spec)
	}
	if sb.Daemon.URL != "http://main-abc.agent-sandbox-system.svc.cluster.local:9000" || *sb.PreviewURL != "https://main-abc.preview.example.com/" {
		t.Fatalf("sandbox = %+v", sb)
	}
	if sb.Image != (protocol.Image{Requested: "default", Served: "default"}) || sb.WarmPoolAdopted {
		t.Fatalf("image=%+v warm=%v", sb.Image, sb.WarmPoolAdopted)
	}
	call := h.daemon.lastConfig(t)
	if call.bearer != sb.Daemon.Token || call.body["auth"] != nil {
		t.Fatalf("cold config call = %+v", call)
	}
	if len(h.daemon.orgFs) != 1 {
		t.Fatalf("org-fs relays = %v", h.daemon.orgFs)
	}
	// Both SSA writes keep the in-process runner's field manager, with force.
	if len(h.applies) != 2 {
		t.Fatalf("applies = %d", len(h.applies))
	}
	for _, a := range h.applies {
		opts := a.GetPatchType()
		if opts != "application/apply-patch+yaml" {
			t.Errorf("%s patch type = %s", a.GetResource().Resource, opts)
		}
	}
	svc := h.applies[0].(k8stesting.PatchActionImpl)
	if svc.PatchOptions.FieldManager != legacySSAFieldManager || svc.PatchOptions.Force == nil || !*svc.PatchOptions.Force || svc.Name != "main-abc" {
		t.Errorf("service apply options = %+v name=%s", svc.PatchOptions, svc.Name)
	}
	route := h.applies[1].(k8stesting.PatchActionImpl)
	if route.PatchOptions.FieldManager != legacySSAFieldManager || route.PatchOptions.Force == nil || !*route.PatchOptions.Force {
		t.Errorf("route apply options = %+v", route.PatchOptions)
	}
	if !strings.Contains(string(route.Patch), `"hostnames":["main-abc.preview.example.com"]`) || !strings.Contains(string(route.Patch), `"name":"gw","namespace":"istio"`) {
		t.Errorf("route = %s", route.Patch)
	}
	st := h.persisted()
	if st.Writer != Writer || st.Token != sb.Daemon.Token || st.AdoptedSandboxName != "main-abc" || st.Image.Served != "default" || st.EnsureOpts.OrgFsConfigJSON == "" {
		t.Fatalf("row = %+v", st)
	}
}

func TestServicePortWithoutGateway(t *testing.T) {
	// Service DNS needs the port whether or not a gateway exists.
	h := newHarness(t, Config{Namespace: ns})
	h.daemon.token = strings.Repeat("a", 64)
	if _, err := h.runner.Ensure(context.Background(), testID, "main-abc", protocol.EnsureOptions{}); err != nil {
		t.Fatal(err)
	}
	if len(h.applies) != 1 || h.applies[0].GetResource().Resource != "services" {
		t.Fatalf("applies = %v", h.applies)
	}
}

func TestProvisionWarmTenantPool(t *testing.T) {
	pools := []TenantPool{{Name: "tenant-acme", OrgID: "org_acme", Repo: "acme/site", Branch: "main", Workload: &PoolWorkload{Runtime: "node"}}}
	h := newHarness(t, Config{Namespace: ns, SentinelToken: sentinel, TenantPools: pools}, templateObject("studio-sandbox-medium"))
	h.daemon.token = sentinel
	h.bind = func(string) string { return "tenant-acme-x7k2p" }
	opts := protocol.EnsureOptions{
		Purpose: protocol.PurposeHarnessRun, CloneOnly: true,
		Repo:   &protocol.EnsureRepo{CloneURL: "https://github.com/acme/site.git"},
		Tenant: &protocol.Tenant{OrgID: "org_acme", UserID: "u_1"},
	}
	sb, err := h.runner.Ensure(context.Background(), testID, "main-abc", opts)
	if err != nil {
		t.Fatal(err)
	}
	c := h.created[0]
	if len(c.Spec.Env) != 0 || c.Spec.WarmPool != "tenant-acme" || c.Spec.TemplateRef.Name != "studio-sandbox-medium" {
		t.Fatalf("claim = %+v", c.Spec)
	}
	call := h.daemon.lastConfig(t)
	auth, _ := call.body["auth"].(map[string]any)
	if call.bearer != sentinel || auth["rotateToken"] != sb.Daemon.Token {
		t.Fatalf("warm bootstrap = %+v", call)
	}
	// The bound pool pod keeps its dev server: cloneOnly is dropped.
	if call.body["cloneOnly"] != false || !sb.WarmPoolAdopted {
		t.Fatalf("cloneOnly=%v warmPoolAdopted=%v", call.body["cloneOnly"], sb.WarmPoolAdopted)
	}
	if sb.Daemon.URL != "http://tenant-acme-x7k2p.agent-sandbox-system.svc.cluster.local:9000" {
		t.Fatalf("daemon url = %s", sb.Daemon.URL)
	}
}

func TestProvisionWarmGenericPoolIsNamed(t *testing.T) {
	h := newHarness(t, Config{Namespace: ns, SentinelToken: sentinel})
	h.daemon.token = sentinel
	if _, err := h.runner.Ensure(context.Background(), testID, "main-abc", protocol.EnsureOptions{CloneOnly: true}); err != nil {
		t.Fatal(err)
	}
	if got := h.created[0].Spec.WarmPool; got != "studio-sandbox" {
		t.Fatalf("warmpool = %q, want the generic pool by name", got)
	}
	if h.daemon.lastConfig(t).body["cloneOnly"] != true {
		t.Fatal("cloneOnly must reach a cold (non-pool) pod")
	}
}

func TestMissingVariantDegrades(t *testing.T) {
	h := newHarness(t, Config{Namespace: ns})
	h.daemon.token = strings.Repeat("a", 64)
	sb, err := h.runner.Ensure(context.Background(), testID, "main-abc", protocol.EnsureOptions{SandboxImage: "android"})
	if err != nil {
		t.Fatal(err)
	}
	if h.created[0].Spec.TemplateRef.Name != "studio-sandbox" || sb.Image != (protocol.Image{Requested: "android", Served: "default"}) {
		t.Fatalf("template=%s image=%+v", h.created[0].Spec.TemplateRef.Name, sb.Image)
	}
	if st := h.persisted(); st.EnsureOpts.SandboxImage != "android" {
		t.Fatal("the requested image must be persisted so a resurrected claim asks again")
	}
}

func TestSentinelRejectedIsTyped(t *testing.T) {
	h := newHarness(t, Config{Namespace: ns, SentinelToken: sentinel})
	h.daemon.token = "another-claims-token"
	_, err := h.runner.Ensure(context.Background(), testID, "main-abc", protocol.EnsureOptions{})
	code, re := runtime.CodeOf(err)
	if code != protocol.ErrBootstrapRejected || re.Status != 401 || !strings.Contains(re.Message, "sandbox provisioning failed") {
		t.Fatalf("err = %v", err)
	}
	if h.claim("main-abc") != nil {
		t.Fatal("the claim must be released")
	}
	if rec, _ := h.store.Get(context.Background(), testID, Name); rec != nil {
		t.Fatal("no row for a failed provision")
	}
}

func TestResumeRotatesCredentialAndRenews(t *testing.T) {
	h := newHarness(t, Config{Namespace: ns})
	h.daemon.token = strings.Repeat("a", 64)
	opts := protocol.EnsureOptions{Repo: &protocol.EnsureRepo{CloneURL: "https://x-access-token:old@github.com/acme/site.git"}}
	if _, err := h.runner.Ensure(context.Background(), testID, "main-abc", opts); err != nil {
		t.Fatal(err)
	}
	before := h.claim("main-abc").Spec.Lifecycle.ShutdownTime.Time
	h.runner.now = func() time.Time { return time.Now().Add(time.Hour) }
	opts.Repo = &protocol.EnsureRepo{CloneURL: "https://x-access-token:new@github.com/acme/site.git"}
	if _, err := h.runner.Ensure(context.Background(), testID, "main-abc", opts); err != nil {
		t.Fatal(err)
	}
	if len(h.created) != 1 {
		t.Fatalf("resume created %d claims", len(h.created))
	}
	call := h.daemon.lastConfig(t)
	if got := marshal(t, call.body); got != `{"git":{"repository":{"cloneUrl":"https://x-access-token:new@github.com/acme/site.git"}}}` {
		t.Fatalf("resume config = %s", got)
	}
	if after := h.claim("main-abc").Spec.Lifecycle.ShutdownTime.Time; !after.After(before) {
		t.Fatalf("shutdown not renewed: %v -> %v", before, after)
	}
}

func TestRecreatedWarmPodRebootstraps(t *testing.T) {
	h := newHarness(t, Config{Namespace: ns, SentinelToken: sentinel})
	h.daemon.token = sentinel
	opts := protocol.EnsureOptions{
		Repo:            &protocol.EnsureRepo{CloneURL: "https://x-access-token:old@github.com/acme/site.git", ConnectionID: "conn_1"},
		OrgFsConfigJSON: `{"token":"old"}`,
		Tenant:          &protocol.Tenant{OrgID: "o", UserID: "u", OrgSlug: "acme"},
	}
	sb, err := h.runner.Ensure(context.Background(), testID, "main-abc", opts)
	if err != nil {
		t.Fatal(err)
	}
	// The pod is recreated under the claim: new boot id, back on the sentinel.
	h.daemon.mu.Lock()
	h.daemon.bootID, h.daemon.token = "boot-2", sentinel
	h.daemon.mu.Unlock()
	h.studio.cloneURL, h.studio.orgFs = "https://x-access-token:fresh@github.com/acme/site.git", `{"token":"fresh"}`
	if _, err := h.runner.Ensure(context.Background(), testID, "main-abc", protocol.EnsureOptions{}); err != nil {
		t.Fatal(err)
	}
	var rebootstrap *configCall
	for i := range h.daemon.configs {
		c := h.daemon.configs[i]
		if auth, ok := c.body["auth"].(map[string]any); ok && c.bearer == sentinel && auth["rotateToken"] == sb.Daemon.Token && i > 0 {
			rebootstrap = &c
		}
	}
	if rebootstrap == nil || !strings.Contains(marshal(t, rebootstrap.body), "fresh@github.com") {
		t.Fatalf("no re-bootstrap with the re-minted credential: %+v", h.daemon.configs)
	}
	if last := h.daemon.orgFs[len(h.daemon.orgFs)-1]; last != `{"token":"fresh"}` {
		t.Fatalf("org-fs relayed %s, want the re-minted config", last)
	}
	if st := h.persisted(); st.DaemonBootID != "boot-2" {
		t.Fatalf("boot id not persisted: %s", st.DaemonBootID)
	}
}

func TestJoinStartingClaim(t *testing.T) {
	// A cold claim an earlier ensure left mid-start, with no row.
	existing := claimObject(t, &Claim{ObjectMeta: metav1.ObjectMeta{Name: "main-abc"}, Spec: ClaimSpec{
		TemplateRef: TemplateRef{Name: "studio-sandbox"},
		Env:         []EnvVar{{Name: "DAEMON_TOKEN", Value: strings.Repeat("e", 64)}, {Name: "DAEMON_BOOT_ID", Value: "boot-env"}},
	}})
	h := newHarness(t, Config{Namespace: ns}, existing)
	h.daemon.token = strings.Repeat("e", 64)
	go func() {
		time.Sleep(50 * time.Millisecond)
		u, _ := h.dyn.Resource(ClaimGVR).Namespace(ns).Get(context.Background(), "main-abc", metav1.GetOptions{})
		u.Object["status"] = map[string]any{"sandbox": map[string]any{"name": "main-abc"},
			"conditions": []any{map[string]any{"type": "Ready", "status": "True", "reason": "Ready", "message": "", "lastTransitionTime": "2026-09-24T00:00:00Z"}}}
		_, _ = h.dyn.Resource(ClaimGVR).Namespace(ns).Update(context.Background(), u, metav1.UpdateOptions{})
	}()
	sb, err := h.runner.Ensure(context.Background(), testID, "main-abc", protocol.EnsureOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(h.created) != 0 || len(h.deleted) != 0 {
		t.Fatalf("a starting claim must be joined, not replaced: created=%d deleted=%v", len(h.created), h.deleted)
	}
	if sb.Daemon.Token != strings.Repeat("e", 64) {
		t.Fatalf("token = %s, want the one in the claim's env", sb.Daemon.Token)
	}
}

func TestTerminatingClaimIsWaitedOut(t *testing.T) {
	now := metav1.Now()
	existing := claimObject(t, &Claim{ObjectMeta: metav1.ObjectMeta{Name: "main-abc", DeletionTimestamp: &now, Finalizers: []string{"x"}}})
	h := newHarness(t, Config{Namespace: ns}, existing)
	h.daemon.token = strings.Repeat("a", 64)
	go func() {
		time.Sleep(50 * time.Millisecond)
		_ = h.dyn.Tracker().Delete(ClaimGVR, ns, "main-abc")
	}()
	if _, err := h.runner.Ensure(context.Background(), testID, "main-abc", protocol.EnsureOptions{}); err != nil {
		t.Fatal(err)
	}
	if len(h.created) != 1 {
		t.Fatalf("created %d", len(h.created))
	}
}

func TestReadyWarmClaimWithoutRowIsReplaced(t *testing.T) {
	existing := claimObject(t, &Claim{ObjectMeta: metav1.ObjectMeta{Name: "main-abc"}, Status: ClaimStatus{Conditions: readyCond}})
	h := newHarness(t, Config{Namespace: ns, SentinelToken: sentinel}, existing)
	h.daemon.token = sentinel
	if _, err := h.runner.Ensure(context.Background(), testID, "main-abc", protocol.EnsureOptions{}); err != nil {
		t.Fatal(err)
	}
	// Its per-claim token lived only in the lost row.
	if len(h.deleted) != 1 || len(h.created) != 1 {
		t.Fatalf("deleted=%v created=%d", h.deleted, len(h.created))
	}
}

func TestStalledClaimIsReleased(t *testing.T) {
	h := newHarness(t, Config{Namespace: ns})
	h.ready = false
	h.runner.timing.stall = 60 * time.Millisecond
	_, err := h.runner.Ensure(context.Background(), testID, "main-abc", protocol.EnsureOptions{})
	if code, _ := runtime.CodeOf(err); code != protocol.ErrClaimStalled {
		t.Fatalf("err = %v", err)
	}
	if h.claim("main-abc") != nil {
		t.Fatal("a stuck claim must be deleted")
	}
}

func TestDelete(t *testing.T) {
	h := newHarness(t, Config{Namespace: ns, PreviewGateway: &Gateway{Name: "gw", Namespace: "istio"}})
	h.daemon.token = strings.Repeat("a", 64)
	if _, err := h.runner.Ensure(context.Background(), testID, "main-abc", protocol.EnsureOptions{}); err != nil {
		t.Fatal(err)
	}
	var routeDeleted bool
	h.dyn.PrependReactor("delete", "httproutes", func(k8stesting.Action) (bool, k8sruntime.Object, error) {
		routeDeleted = true
		return true, nil, nil
	})
	if err := h.runner.Delete(context.Background(), "main-abc"); err != nil {
		t.Fatal(err)
	}
	if rec, _ := h.store.ByHandle(context.Background(), "main-abc"); rec != nil || h.claim("main-abc") != nil || !routeDeleted {
		t.Fatalf("row=%v claim=%v route=%v", rec, h.claim("main-abc"), routeDeleted)
	}

	t.Run("a stuck finalizer ends at the deadline", func(t *testing.T) {
		_ = h.dyn.Tracker().Create(ClaimGVR, claimObject(t, &Claim{ObjectMeta: metav1.ObjectMeta{Name: "stuck"}}), ns)
		h.dyn.PrependReactor("delete", "sandboxclaims", func(k8stesting.Action) (bool, k8sruntime.Object, error) { return true, nil, nil })
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		if err := h.runner.Delete(ctx, "stuck"); err != context.DeadlineExceeded {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestShutdownIsMonotonic(t *testing.T) {
	now := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	at := metav1.NewTime(now.Add(30 * time.Minute))
	h := newHarness(t, Config{Namespace: ns, IdleTTL: 15 * time.Minute},
		claimObject(t, &Claim{ObjectMeta: metav1.ObjectMeta{Name: "c"}, Spec: ClaimSpec{Lifecycle: &Lifecycle{ShutdownPolicy: "Delete", ShutdownTime: &at}}}))
	h.runner.now = func() time.Time { return now }
	shutdown := func() time.Time { return h.claim("c").Spec.Lifecycle.ShutdownTime.UTC() }

	if err := h.runner.RenewTTL(context.Background(), "c"); err != nil || !shutdown().Equal(at.UTC()) {
		t.Fatalf("renew brought shutdown earlier: %v %v", shutdown(), err)
	}
	if err := h.runner.ReleaseAfter(context.Background(), "c", time.Minute); err != nil || !shutdown().Equal(now.Add(time.Minute)) {
		t.Fatalf("release did not bring shutdown forward: %v %v", shutdown(), err)
	}
	if err := h.runner.ReleaseAfter(context.Background(), "c", 10*time.Minute); err != nil || !shutdown().Equal(now.Add(time.Minute)) {
		t.Fatalf("release pushed shutdown later: %v", shutdown())
	}
	if err := h.runner.RenewTTL(context.Background(), "c"); err != nil || !shutdown().Equal(now.Add(15*time.Minute)) {
		t.Fatalf("renew did not push shutdown out: %v", shutdown())
	}
	if err := h.runner.RenewTTL(context.Background(), "gone"); err != nil {
		t.Fatalf("a claim already gone is left gone: %v", err)
	}
}

func TestRotateCredential(t *testing.T) {
	h := newHarness(t, Config{Namespace: ns})
	h.daemon.token = strings.Repeat("a", 64)
	opts := protocol.EnsureOptions{Repo: &protocol.EnsureRepo{CloneURL: "https://x-access-token:old@github.com/acme/site.git"}}
	if _, err := h.runner.Ensure(context.Background(), testID, "main-abc", opts); err != nil {
		t.Fatal(err)
	}
	err := h.runner.RotateCredential(context.Background(), "main-abc", "https://x-access-token:t@github.com/acme/other.git")
	if code, _ := runtime.CodeOf(err); code != protocol.ErrBadRequest {
		t.Fatalf("another repository must be refused, got %v", err)
	}
	if err := h.runner.RotateCredential(context.Background(), "main-abc", "https://x-access-token:new@github.com/acme/site.git"); err != nil {
		t.Fatal(err)
	}
	if st := h.persisted(); st.EnsureOpts.Repo.CloneURL != "https://x-access-token:new@github.com/acme/site.git" {
		t.Fatalf("persisted %s", st.EnsureOpts.Repo.CloneURL)
	}
	if code, _ := runtime.CodeOf(h.runner.RotateCredential(context.Background(), "nope", "https://github.com/a/b.git")); code != protocol.ErrUnknownHandle {
		t.Fatal("unknown handle")
	}
}

func TestCredentialRefresher(t *testing.T) {
	h := newHarness(t, Config{Namespace: ns})
	h.daemon.token = strings.Repeat("a", 64)
	opts := protocol.EnsureOptions{Repo: &protocol.EnsureRepo{CloneURL: "https://x-access-token:old@github.com/acme/site.git", RepositoryID: "repo_1"}}
	if _, err := h.runner.Ensure(context.Background(), testID, "main-abc", opts); err != nil {
		t.Fatal(err)
	}
	h.studio.cloneURL = "https://x-access-token:fresh@github.com/acme/site.git"
	if err := h.runner.refreshAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(h.studio.mints) != 1 || h.studio.mints[0].RepositoryID != "repo_1" {
		t.Fatalf("mints = %+v", h.studio.mints)
	}
	if st := h.persisted(); st.EnsureOpts.Repo.CloneURL != h.studio.cloneURL {
		t.Fatalf("persisted %s", st.EnsureOpts.Repo.CloneURL)
	}
	if !strings.Contains(marshal(t, h.daemon.lastConfig(t).body), "fresh@github.com") {
		t.Fatal("the fresh credential was not pushed")
	}
}

func TestResurrectReplaysPersistedOptions(t *testing.T) {
	h := newHarness(t, Config{Namespace: ns})
	h.daemon.token = strings.Repeat("a", 64)
	opts := protocol.EnsureOptions{Purpose: protocol.PurposeHarnessRun, Repo: &protocol.EnsureRepo{CloneURL: "https://x-access-token:old@github.com/acme/site.git", ConnectionID: "c1"}}
	if _, err := h.runner.Ensure(context.Background(), testID, "main-abc", opts); err != nil {
		t.Fatal(err)
	}
	// The idle TTL reaps the claim; the row stays.
	_ = h.dyn.Tracker().Delete(ClaimGVR, ns, "main-abc")
	h.studio.cloneURL = "https://x-access-token:fresh@github.com/acme/site.git"
	ok, err := h.runner.Resurrect(context.Background(), "main-abc")
	if err != nil || !ok || len(h.created) != 2 {
		t.Fatalf("ok=%v err=%v created=%d", ok, err, len(h.created))
	}
	if h.created[1].Spec.TemplateRef.Name != "studio-sandbox" {
		// No -medium template in this cluster: purpose was replayed and degraded.
		t.Fatalf("template = %s", h.created[1].Spec.TemplateRef.Name)
	}
	if !strings.Contains(marshal(t, h.daemon.lastConfig(t).body), "fresh@github.com") {
		t.Fatal("resurrection replayed the expired credential")
	}
	if ok, _ := h.runner.Resurrect(context.Background(), "unknown"); ok {
		t.Fatal("nothing to replay is not a resurrection")
	}
}

func TestImages(t *testing.T) {
	variant := func(name, base string, ready bool) v1alpha1.SandboxVariant {
		v := v1alpha1.SandboxVariant{ObjectMeta: metav1.ObjectMeta{Name: name}, Spec: v1alpha1.SandboxVariantSpec{BaseTemplate: base, BaseTag: "1.40.2"}}
		status := metav1.ConditionFalse
		if ready {
			status = metav1.ConditionTrue
		}
		v.Status.Conditions = []metav1.Condition{{Type: v1alpha1.ConditionReady, Status: status}}
		v.Status.DefaultTemplateTag = "1.41.0"
		return v
	}
	h := newHarness(t, Config{Namespace: ns, TemplateName: "studio-sandbox-prod", Variants: func(context.Context) ([]v1alpha1.SandboxVariant, error) {
		return []v1alpha1.SandboxVariant{
			variant("studio-sandbox-prod-android", "studio-sandbox-prod", true),
			variant("studio-sandbox-prod-rust", "studio-sandbox-prod", false),
			variant("studio-sandbox-stg-android", "studio-sandbox-stg", true),
		}, nil
	}})
	got, err := h.runner.Images(context.Background())
	if err != nil || len(got) != 1 || got[0] != (protocol.ImageInfo{Name: "android", BaseTag: "1.40.2", DefaultTemplateTag: "1.41.0"}) {
		t.Fatalf("images = %+v err=%v", got, err)
	}
}

func TestPodTermination(t *testing.T) {
	limit := corev1.ResourceList{corev1.ResourceMemory: resourceQuantity("4Gi")}
	pod := func(status corev1.PodStatus) *corev1.Pod {
		return &corev1.Pod{Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: mainContainer, Resources: corev1.ResourceRequirements{Limits: limit}}}}, Status: status}
	}
	term := func(reason string, code int32) *corev1.ContainerStateTerminated {
		return &corev1.ContainerStateTerminated{Reason: reason, ExitCode: code}
	}
	oom := pod(corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{Name: mainContainer, State: corev1.ContainerState{Terminated: term("OOMKilled", 137)}}}})
	if got := podTermination(oom); got == nil || !got.OOMKilled || *got.ExitCode != 137 || got.MemoryLimit != "4Gi" {
		t.Fatalf("oom = %+v", got)
	}
	restarted := pod(corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{Name: mainContainer, LastTerminationState: corev1.ContainerState{Terminated: term("OOMKilled", 137)}}}})
	if got := podTermination(restarted); got == nil || !got.OOMKilled {
		t.Fatalf("restarted in place = %+v", got)
	}
	sidecar := pod(corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{Name: "org-fs", State: corev1.ContainerState{Terminated: term("OOMKilled", 137)}}}})
	if got := podTermination(sidecar); got != nil {
		t.Fatalf("a sidecar's kill is not the sandbox's: %+v", got)
	}
	evicted := pod(corev1.PodStatus{Reason: "Evicted", Message: `Usage of EmptyDir volume "tmp" exceeds the limit "1Gi".`})
	if got := podTermination(evicted); got == nil || got.Reason != "Evicted" || !strings.Contains(got.EvictionMessage, "EmptyDir") {
		t.Fatalf("evicted = %+v", got)
	}
	if podTermination(pod(corev1.PodStatus{})) != nil {
		t.Fatal("a running pod has nothing to report")
	}
}

func TestSchedulable(t *testing.T) {
	pending := func(reason string) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "p" + reason, Namespace: ns}, Status: corev1.PodStatus{Phase: corev1.PodPending,
			Conditions: []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: reason}}}}
	}
	k := &kube{core: k8sfake.NewSimpleClientset(pending("SchedulingGated")), namespace: ns}
	if ok, _ := k.schedulable(context.Background()); !ok {
		t.Fatal("a pod pending for another reason is not a capacity signal")
	}
	k = &kube{core: k8sfake.NewSimpleClientset(pending(corev1.PodReasonUnschedulable)), namespace: ns}
	if ok, _ := k.schedulable(context.Background()); ok {
		t.Fatal("an unschedulable pod means no capacity")
	}
}

func resourceQuantity(s string) resource.Quantity { return resource.MustParse(s) }
