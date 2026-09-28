package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
	"github.com/decocms/studio/packages/sandbox/controller-go/runtime"
	"github.com/decocms/studio/packages/sandbox/controller-go/store/storetest"
)

type fakeProvider struct {
	ensureErr   error
	ensured     []string
	deleteBlock bool
	alive       bool
	resurrected bool
	renewed     int
	released    []time.Duration
	rotated     []string
	phases      []protocol.Phase
	// fullImages are unschedulable.
	fullImages map[string]bool
	pushes     [][2]string
}

func (f *fakeProvider) Probe(context.Context) (bool, string) { return true, "" }
func (f *fakeProvider) Ensure(_ context.Context, id protocol.SandboxID, handle string, opts protocol.EnsureOptions) (*runtime.Sandbox, error) {
	if f.ensureErr != nil {
		return nil, f.ensureErr
	}
	f.ensured = append(f.ensured, handle)
	u := "https://" + handle + ".preview/"
	return &runtime.Sandbox{Handle: handle, Workdir: "/app", PreviewURL: &u, Daemon: protocol.Daemon{URL: "http://d", Token: "tok"},
		Image: protocol.Image{Requested: "android", Served: "default"}, WarmPoolAdopted: true}, nil
}
func (f *fakeProvider) Delete(ctx context.Context, _ string) error {
	if f.deleteBlock {
		<-ctx.Done()
		return ctx.Err()
	}
	return nil
}
func (f *fakeProvider) Alive(context.Context, string) (bool, error) { return f.alive, nil }
func (f *fakeProvider) Describe(context.Context, string) (*runtime.Described, error) {
	return &runtime.Described{Daemon: &protocol.Daemon{URL: "http://d", Token: "tok"}}, nil
}
func (f *fakeProvider) Resurrect(context.Context, string) (bool, error) {
	f.resurrected = true
	return true, nil
}
func (f *fakeProvider) LastTermination(context.Context, string) (*protocol.PodTermination, error) {
	return &protocol.PodTermination{Reason: "OOMKilled", OOMKilled: true}, nil
}
func (f *fakeProvider) RenewTTL(context.Context, string) error { f.renewed++; return nil }
func (f *fakeProvider) ReleaseAfter(_ context.Context, _ string, d time.Duration) error {
	f.released = append(f.released, d)
	return nil
}
func (f *fakeProvider) RotateCredential(_ context.Context, _ string, u string) error {
	f.rotated = append(f.rotated, u)
	return nil
}
func (f *fakeProvider) Watch(context.Context, string) (<-chan protocol.Phase, error) {
	ch := make(chan protocol.Phase, len(f.phases))
	for _, p := range f.phases {
		ch <- p
	}
	close(ch)
	return ch, nil
}
func (f *fakeProvider) Schedulable(_ context.Context, image string) (bool, error) {
	return !f.fullImages[image], nil
}
func (f *fakeProvider) MarkTenantPoolsDirty(repo, ref string) []string {
	f.pushes = append(f.pushes, [2]string{repo, ref})
	return []string{"tenant-acme"}
}
func (f *fakeProvider) Images(context.Context) ([]protocol.ImageInfo, error) {
	return []protocol.ImageInfo{{Name: "android", BaseTag: "1"}}, nil
}
func (f *fakeProvider) Close() {}

var id = protocol.SandboxID{UserID: "u", ProjectRef: "agent:o:v:main"}

func newServer(t *testing.T, p *fakeProvider) (*mcp.ClientSession, *storetest.Memory) {
	st := storetest.NewMemory()
	reg := runtime.NewRegistry(&runtime.Runtime{Name: "agent-sandbox", Priority: 10, Provider: p, Capabilities: []protocol.Capability{protocol.CapPreview, protocol.CapCapacity}})
	srv := httptest.NewServer((&Server{Registry: reg, Store: st, DeleteDeadline: 50 * time.Millisecond}).Handler())
	t.Cleanup(srv.Close)
	return connect(t, srv.URL, nil), st
}

func connect(t *testing.T, base string, opts *mcp.ClientOptions) *mcp.ClientSession {
	t.Helper()
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "studio-test"}, opts).
		Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: base + protocol.PathMCP}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return cs
}

func call(t *testing.T, cs *mcp.ClientSession, tool string, args any) *mcp.CallToolResult {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", tool, err)
	}
	return res
}

// ok is a successful call's output as the server serialized it.
func ok(t *testing.T, res *mcp.CallToolResult) string {
	t.Helper()
	if res.IsError || res.StructuredContent == nil {
		t.Fatalf("call failed: %s", text(res))
	}
	return text(res)
}

func text(res *mcp.CallToolResult) string {
	if len(res.Content) == 0 {
		return ""
	}
	if tc, ok := res.Content[0].(*mcp.TextContent); ok {
		return tc.Text
	}
	return ""
}

func failure(t *testing.T, res *mcp.CallToolResult) protocol.ErrorResponse {
	t.Helper()
	var e protocol.ErrorResponse
	if !res.IsError || json.Unmarshal([]byte(text(res)), &e) != nil {
		t.Fatalf("not an error result: isError=%v %s", res.IsError, text(res))
	}
	return e
}

func TestTools(t *testing.T) {
	cs, _ := newServer(t, &fakeProvider{})
	list, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range list.Tools {
		names = append(names, tool.Name)
	}
	sort.Strings(names)
	want := []string{protocol.ToolCapacity, protocol.ToolCredentials, protocol.ToolDelete, protocol.ToolEnsure, protocol.ToolImages,
		protocol.ToolLifetime, protocol.ToolRuntimes, protocol.ToolStatus, protocol.ToolTenantPoolsPush, protocol.ToolWatch}
	sort.Strings(want)
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("tools = %v, want %v", names, want)
	}
}

func TestEnsure(t *testing.T) {
	p := &fakeProvider{}
	cs, st := newServer(t, p)
	body := ok(t, call(t, cs, protocol.ToolEnsure, protocol.EnsureRequest{ID: id, Handle: "main-abc", Opts: &protocol.EnsureOptions{SandboxImage: "android"}}))
	var out protocol.EnsureResponse
	_ = json.Unmarshal([]byte(body), &out)
	if out.Runtime != "agent-sandbox" || out.Daemon.Token != "tok" || out.Image.Served != "default" || !out.WarmPoolAdopted || len(out.Capabilities) != 2 {
		t.Fatalf("response = %s", body)
	}

	t.Run("fields this build does not know are ignored", func(t *testing.T) {
		args := map[string]any{"id": id, "handle": "main-abc", "fromANewerStudio": true, "opts": map[string]any{"alsoNew": 1}}
		ok(t, call(t, cs, protocol.ToolEnsure, args))
	})

	t.Run("a live handle is returned as-is with runtimeMismatch", func(t *testing.T) {
		_ = st.Put(context.Background(), id, "agent-sandbox", "main-abc", map[string]string{})
		body := ok(t, call(t, cs, protocol.ToolEnsure, protocol.EnsureRequest{ID: id, Handle: "main-abc", Runtime: "docker"}))
		if !strings.Contains(body, `"runtimeMismatch":"agent-sandbox"`) {
			t.Fatalf("got %s", body)
		}
	})

	t.Run("a handle recorded for another id is a conflict", func(t *testing.T) {
		other := protocol.SandboxID{UserID: "someone-else", ProjectRef: id.ProjectRef}
		if e := failure(t, call(t, cs, protocol.ToolEnsure, protocol.EnsureRequest{ID: other, Handle: "main-abc"})); e.Code != protocol.ErrHandleConflict {
			t.Fatalf("%+v", e)
		}
	})

	t.Run("a row on a runtime this build lacks is left alone", func(t *testing.T) {
		gone := protocol.SandboxID{UserID: "u2", ProjectRef: "r"}
		_ = st.Put(context.Background(), gone, "microvm", "vm-handle", map[string]string{})
		if e := failure(t, call(t, cs, protocol.ToolEnsure, protocol.EnsureRequest{ID: gone, Handle: "vm-handle"})); e.Code != protocol.ErrRuntimeUnreachable {
			t.Fatalf("%+v", e)
		}
	})
}

func TestEnsureValidation(t *testing.T) {
	cs, _ := newServer(t, &fakeProvider{})
	for name, req := range map[string]protocol.EnsureRequest{
		"missing id":          {Handle: "h-1"},
		"handle not a label":  {ID: id, Handle: "Main_ABC"},
		"handle too long":     {ID: id, Handle: strings.Repeat("a", 64)},
		"bad image":           {ID: id, Handle: "h", Opts: &protocol.EnsureOptions{SandboxImage: "Android!"}},
		"bad purpose":         {ID: id, Handle: "h", Opts: &protocol.EnsureOptions{Purpose: "batch"}},
		"bad package manager": {ID: id, Handle: "h", Opts: &protocol.EnsureOptions{Workload: &protocol.Workload{Runtime: "node", PackageManager: "pip"}}},
		"repo without url":    {ID: id, Handle: "h", Opts: &protocol.EnsureOptions{Repo: &protocol.EnsureRepo{}}},
		"tenant without ids":  {ID: id, Handle: "h", Opts: &protocol.EnsureOptions{Tenant: &protocol.Tenant{}}},
		"unknown capability":  {ID: id, Handle: "h", Requires: []protocol.Capability{"gpu"}},
	} {
		if e := failure(t, call(t, cs, protocol.ToolEnsure, req)); e.Code != protocol.ErrBadRequest {
			t.Errorf("%s: %+v", name, e)
		}
	}
	// The schema rejects a missing required field before the handler runs.
	if res := call(t, cs, protocol.ToolEnsure, map[string]any{"id": id}); !res.IsError {
		t.Error("an ensure without a handle was accepted")
	}
	if _, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: protocol.ToolEnsure, Arguments: map[string]string{"x": strings.Repeat("a", maxBody+1)}}); err == nil {
		t.Error("an oversized request was accepted")
	}
}

func TestEnsureErrors(t *testing.T) {
	for _, tc := range []struct {
		err  error
		code protocol.ErrorCode
	}{
		{&runtime.Error{Code: protocol.ErrBootstrapRejected, Message: "sandbox provisioning failed", Status: 401}, protocol.ErrBootstrapRejected},
		{&runtime.Error{Code: protocol.ErrClaimStalled, Message: "no progress"}, protocol.ErrClaimStalled},
		{&runtime.Error{Code: protocol.ErrClaimFailed, Message: "image pull"}, protocol.ErrClaimFailed},
		{io.ErrUnexpectedEOF, protocol.ErrInternal},
	} {
		cs, _ := newServer(t, &fakeProvider{ensureErr: tc.err})
		e := failure(t, call(t, cs, protocol.ToolEnsure, protocol.EnsureRequest{ID: id, Handle: "h"}))
		if e.Code != tc.code {
			t.Errorf("%v: %+v", tc.err, e)
		}
		if tc.code == protocol.ErrBootstrapRejected && (e.Status != 401 || e.Error != "sandbox provisioning failed") {
			t.Errorf("the daemon's answer is lost: %+v", e)
		}
	}
	if e := failure(t, call(t, connectEmpty(t), protocol.ToolEnsure, protocol.EnsureRequest{ID: id, Handle: "h"})); e.Code != protocol.ErrNoRuntime {
		t.Errorf("no runtime: %+v", e)
	}
}

func connectEmpty(t *testing.T) *mcp.ClientSession {
	srv := httptest.NewServer((&Server{Registry: runtime.NewRegistry(), Store: storetest.NewMemory()}).Handler())
	t.Cleanup(srv.Close)
	return connect(t, srv.URL, nil)
}

func TestStatusResurrectsOnlyWhenAsked(t *testing.T) {
	p := &fakeProvider{}
	cs, _ := newServer(t, p)
	body := ok(t, call(t, cs, protocol.ToolStatus, protocol.StatusRequest{Handle: "h"}))
	if p.resurrected || !strings.Contains(body, `"alive":false`) || !strings.Contains(body, `"oomKilled":true`) {
		t.Fatalf("observation had a side effect or lost data: %s", body)
	}
	body = ok(t, call(t, cs, protocol.ToolStatus, protocol.StatusRequest{Handle: "h", Resurrect: true}))
	if !p.resurrected || !strings.Contains(body, `"alive":true`) {
		t.Fatalf("got %s", body)
	}
}

func TestDelete(t *testing.T) {
	cs, _ := newServer(t, &fakeProvider{})
	if body := ok(t, call(t, cs, protocol.ToolDelete, protocol.HandleRequest{Handle: "h"})); body != `{"state":"deleted"}` {
		t.Fatalf("got %s", body)
	}
	cs, _ = newServer(t, &fakeProvider{deleteBlock: true})
	if body := ok(t, call(t, cs, protocol.ToolDelete, protocol.HandleRequest{Handle: "h"})); body != `{"state":"draining"}` {
		t.Fatalf("got %s", body)
	}
}

func TestLifetime(t *testing.T) {
	p := &fakeProvider{}
	cs, _ := newServer(t, p)
	grace := int64(30_000)
	for _, tc := range []struct {
		body    any
		isError bool
	}{
		{protocol.LifetimeRequest{Handle: "h", ExtendToIdleWindow: true}, false},
		{protocol.LifetimeRequest{Handle: "h", GraceMs: &grace}, false},
		{protocol.LifetimeRequest{Handle: "h"}, true},
		{protocol.LifetimeRequest{Handle: "h", ExtendToIdleWindow: true, GraceMs: &grace}, true},
		{map[string]any{"handle": "h", "graceMs": -1}, true},
	} {
		if res := call(t, cs, protocol.ToolLifetime, tc.body); res.IsError != tc.isError {
			t.Errorf("%+v: %s", tc.body, text(res))
		}
	}
	if p.renewed != 1 || len(p.released) != 1 || p.released[0] != 30*time.Second {
		t.Fatalf("renewed=%d released=%v", p.renewed, p.released)
	}
}

func TestCredentials(t *testing.T) {
	p := &fakeProvider{}
	cs, st := newServer(t, p)
	req := protocol.CredentialsRequest{Handle: "h", CloneURL: "https://x:t@github.com/a/b.git"}
	if e := failure(t, call(t, cs, protocol.ToolCredentials, req)); e.Code != protocol.ErrUnknownHandle {
		t.Fatalf("no row: %+v", e)
	}
	_ = st.Put(context.Background(), id, "agent-sandbox", "h", map[string]string{})
	if e := failure(t, call(t, cs, protocol.ToolCredentials, protocol.CredentialsRequest{Handle: "h"})); e.Code != protocol.ErrBadRequest {
		t.Fatalf("empty cloneUrl: %+v", e)
	}
	if ok(t, call(t, cs, protocol.ToolCredentials, req)); len(p.rotated) != 1 {
		t.Fatalf("rotated %v", p.rotated)
	}
}

func TestWatch(t *testing.T) {
	p := &fakeProvider{phases: []protocol.Phase{{Kind: protocol.PhaseClaiming, Since: 1}, {Kind: protocol.PhaseReady}}}
	st := storetest.NewMemory()
	reg := runtime.NewRegistry(&runtime.Runtime{Name: "agent-sandbox", Priority: 10, Provider: p})
	srv := httptest.NewServer((&Server{Registry: reg, Store: st}).Handler())
	t.Cleanup(srv.Close)
	notes := make(chan *mcp.ProgressNotificationParams, 8)
	cs := connect(t, srv.URL, &mcp.ClientOptions{ProgressNotificationHandler: func(_ context.Context, req *mcp.ProgressNotificationClientRequest) {
		notes <- req.Params
	}})
	params := &mcp.CallToolParams{Name: protocol.ToolWatch, Arguments: protocol.HandleRequest{Handle: "h"}}
	params.SetProgressToken("watch-1")
	res, err := cs.CallTool(context.Background(), params)
	if err != nil {
		t.Fatal(err)
	}
	if body := ok(t, res); body != `{"kind":"ready"}` {
		t.Fatalf("result = %s", body)
	}
	// The Go client hands notifications to the handler asynchronously, so
	// order comes from the progress counter.
	progress := make([]string, 2)
	for range 2 {
		select {
		case n := <-notes:
			if i := int(n.Progress) - 1; i >= 0 && i < 2 {
				progress[i] = n.Message
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("progress so far = %v", progress)
		}
	}
	if progress[0] != `{"kind":"claiming","since":1}` || progress[1] != `{"kind":"ready"}` {
		t.Fatalf("progress = %v", progress)
	}

	p.phases = []protocol.Phase{{Kind: protocol.PhaseClaiming, Since: 1}}
	if e := failure(t, call(t, cs, protocol.ToolWatch, protocol.HandleRequest{Handle: "h"})); e.Code != protocol.ErrInternal {
		t.Fatalf("a watch that ends early = %+v", e)
	}
}

func TestReadTools(t *testing.T) {
	cs, _ := newServer(t, &fakeProvider{})
	for tool, want := range map[string]string{
		protocol.ToolCapacity: `{"schedulable":true}`,
		protocol.ToolImages:   `{"runtimes":[{"runtime":"agent-sandbox","images":[{"name":"android","baseTag":"1"}]}]}`,
	} {
		if body := ok(t, call(t, cs, tool, map[string]any{})); body != want {
			t.Errorf("%s = %s, want %s", tool, body, want)
		}
	}
	if body := ok(t, call(t, cs, protocol.ToolRuntimes, nil)); !strings.Contains(body, `"name":"agent-sandbox","available":true`) || !strings.Contains(body, `"capacity":{"schedulable":true`) {
		t.Errorf("runtimes = %s", body)
	}
}

func TestCapacityPerImage(t *testing.T) {
	cs, _ := newServer(t, &fakeProvider{fullImages: map[string]bool{"android": true}})
	for image, want := range map[string]string{
		"":             `{"schedulable":true}`,
		"default":      `{"schedulable":true}`,
		"android":      `{"schedulable":false}`,
		"Not_An_Image": `"code":"bad-request"`,
	} {
		res := call(t, cs, protocol.ToolCapacity, protocol.CapacityRequest{SandboxImage: image})
		got := text(res)
		if !strings.Contains(got, want) {
			t.Errorf("capacity(%q) = %s, want %s", image, got, want)
		}
	}
}

func TestTenantPoolsPush(t *testing.T) {
	p := &fakeProvider{}
	cs, _ := newServer(t, p)
	if body := ok(t, call(t, cs, protocol.ToolTenantPoolsPush, protocol.TenantPoolsPushRequest{Repo: "acme/site", Ref: "refs/heads/main"})); body != `{"pools":["tenant-acme"]}` || len(p.pushes) != 1 {
		t.Fatalf("body=%s pushes=%v", body, p.pushes)
	}
	if res := call(t, cs, protocol.ToolTenantPoolsPush, map[string]any{"repo": "acme/site"}); !res.IsError {
		t.Fatal("a push without a ref was accepted")
	}
}

// writeCert issues a certificate signed by ca (self-signed when ca is nil).
func writeCert(t *testing.T, dir, name string, ca *tls.Certificate, isCA bool) (tls.Certificate, string, string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: isCA, BasicConstraintsValid: true,
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
	}
	parent, signer := tmpl, any(key)
	if ca != nil {
		parent, _ = x509.ParseCertificate(ca.Certificate[0])
		signer = ca.PrivateKey
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, parent, &key.PublicKey, signer)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalECPrivateKey(key)
	certFile, keyFile := filepath.Join(dir, name+".crt"), filepath.Join(dir, name+".key")
	_ = os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
	_ = os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600)
	pair, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		t.Fatal(err)
	}
	return pair, certFile, keyFile
}

func TestMutualTLS(t *testing.T) {
	dir := t.TempDir()
	ca, caFile, _ := writeCert(t, dir, "ca", nil, true)
	_, serverCert, serverKey := writeCert(t, dir, "server", &ca, false)
	client, _, _ := writeCert(t, dir, "studio", &ca, false)
	rogueCA, _, _ := writeCert(t, dir, "rogue-ca", nil, true)
	rogue, _, _ := writeCert(t, dir, "rogue", &rogueCA, false)

	if _, err := TLS(serverCert, serverKey, ""); err == nil {
		t.Fatal("a claim API without a client CA must refuse to start")
	}
	cfg, err := TLS(serverCert, serverKey, caFile)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewUnstartedServer((&Server{Registry: runtime.NewRegistry(), Store: storetest.NewMemory()}).Handler())
	srv.TLS = cfg
	srv.StartTLS()
	defer srv.Close()

	roots := x509.NewCertPool()
	caCert, _ := x509.ParseCertificate(ca.Certificate[0])
	roots.AddCert(caCert)
	get := func(certs ...tls.Certificate) error {
		c := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, Certificates: certs}}}
		res, err := c.Get(srv.URL + "/healthz")
		if err == nil {
			res.Body.Close()
		}
		return err
	}
	if err := get(client); err != nil {
		t.Fatalf("Studio's certificate was refused: %v", err)
	}
	if err := get(); err == nil {
		t.Fatal("a client without a certificate got through")
	}
	if err := get(rogue); err == nil {
		t.Fatal("a certificate from another CA got through")
	}
}
