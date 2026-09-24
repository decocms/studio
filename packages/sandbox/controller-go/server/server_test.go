package server

import (
	"bufio"
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
	"strings"
	"testing"
	"time"

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

func newServer(t *testing.T, p *fakeProvider) (*httptest.Server, *storetest.Memory) {
	st := storetest.NewMemory()
	reg := runtime.NewRegistry(&runtime.Runtime{Name: "agent-sandbox", Priority: 10, Provider: p, Capabilities: []protocol.Capability{protocol.CapPreview, protocol.CapCapacity}})
	srv := httptest.NewServer((&Server{Registry: reg, Store: st, DeleteDeadline: 50 * time.Millisecond, Heartbeat: time.Hour}).Handler())
	t.Cleanup(srv.Close)
	return srv, st
}

func do(t *testing.T, method, url string, body any) (*http.Response, string) {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = strings.NewReader(string(b))
	}
	req, _ := http.NewRequest(method, url, r)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res, string(b)
}

func errorCode(t *testing.T, body string) protocol.ErrorCode {
	var e protocol.ErrorResponse
	if err := json.Unmarshal([]byte(body), &e); err != nil {
		t.Fatalf("not an error body: %s", body)
	}
	return e.Code
}

func TestEnsure(t *testing.T) {
	p := &fakeProvider{}
	srv, st := newServer(t, p)
	res, body := do(t, "POST", srv.URL+"/sandboxes", protocol.EnsureRequest{ID: id, Handle: "main-abc", Opts: &protocol.EnsureOptions{SandboxImage: "android"}})
	if res.StatusCode != 200 {
		t.Fatalf("%d %s", res.StatusCode, body)
	}
	var out protocol.EnsureResponse
	_ = json.Unmarshal([]byte(body), &out)
	if out.Runtime != "agent-sandbox" || out.Daemon.Token != "tok" || out.Image.Served != "default" || !out.WarmPoolAdopted || len(out.Capabilities) != 2 {
		t.Fatalf("response = %s", body)
	}

	t.Run("a live handle is returned as-is with runtimeMismatch", func(t *testing.T) {
		_ = st.Put(context.Background(), id, "agent-sandbox", "main-abc", map[string]string{})
		_, body := do(t, "POST", srv.URL+"/sandboxes", protocol.EnsureRequest{ID: id, Handle: "main-abc", Runtime: "docker"})
		if !strings.Contains(body, `"runtimeMismatch":"agent-sandbox"`) {
			t.Fatalf("got %s", body)
		}
	})

	t.Run("a handle recorded for another id is a conflict", func(t *testing.T) {
		other := protocol.SandboxID{UserID: "someone-else", ProjectRef: id.ProjectRef}
		res, body := do(t, "POST", srv.URL+"/sandboxes", protocol.EnsureRequest{ID: other, Handle: "main-abc"})
		if res.StatusCode != 409 || errorCode(t, body) != protocol.ErrHandleConflict {
			t.Fatalf("%d %s", res.StatusCode, body)
		}
	})

	t.Run("a row on a runtime this build lacks is left alone", func(t *testing.T) {
		gone := protocol.SandboxID{UserID: "u2", ProjectRef: "r"}
		_ = st.Put(context.Background(), gone, "microvm", "vm-handle", map[string]string{})
		res, body := do(t, "POST", srv.URL+"/sandboxes", protocol.EnsureRequest{ID: gone, Handle: "vm-handle"})
		if res.StatusCode != 503 || errorCode(t, body) != protocol.ErrRuntimeUnreachable {
			t.Fatalf("%d %s", res.StatusCode, body)
		}
	})
}

func TestEnsureValidation(t *testing.T) {
	srv, _ := newServer(t, &fakeProvider{})
	for name, req := range map[string]any{
		"missing id":          protocol.EnsureRequest{Handle: "h-1"},
		"handle not a label":  protocol.EnsureRequest{ID: id, Handle: "Main_ABC"},
		"handle too long":     protocol.EnsureRequest{ID: id, Handle: strings.Repeat("a", 64)},
		"bad image":           protocol.EnsureRequest{ID: id, Handle: "h", Opts: &protocol.EnsureOptions{SandboxImage: "Android!"}},
		"bad purpose":         protocol.EnsureRequest{ID: id, Handle: "h", Opts: &protocol.EnsureOptions{Purpose: "batch"}},
		"bad package manager": protocol.EnsureRequest{ID: id, Handle: "h", Opts: &protocol.EnsureOptions{Workload: &protocol.Workload{Runtime: "node", PackageManager: "pip"}}},
		"repo without url":    protocol.EnsureRequest{ID: id, Handle: "h", Opts: &protocol.EnsureOptions{Repo: &protocol.EnsureRepo{}}},
		"tenant without ids":  protocol.EnsureRequest{ID: id, Handle: "h", Opts: &protocol.EnsureOptions{Tenant: &protocol.Tenant{}}},
		"unknown capability":  protocol.EnsureRequest{ID: id, Handle: "h", Requires: []protocol.Capability{"gpu"}},
		"not json":            "{",
		"oversized":           map[string]string{"x": strings.Repeat("a", maxBody+1)},
	} {
		res, body := do(t, "POST", srv.URL+"/sandboxes", req)
		if res.StatusCode != 400 || errorCode(t, body) != protocol.ErrBadRequest {
			t.Errorf("%s: %d %s", name, res.StatusCode, body)
		}
	}
}

func TestEnsureErrors(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		code   protocol.ErrorCode
	}{
		{&runtime.Error{Code: protocol.ErrBootstrapRejected, Message: "sandbox provisioning failed", Status: 401}, 502, protocol.ErrBootstrapRejected},
		{&runtime.Error{Code: protocol.ErrClaimStalled, Message: "no progress"}, 504, protocol.ErrClaimStalled},
		{&runtime.Error{Code: protocol.ErrClaimFailed, Message: "image pull"}, 502, protocol.ErrClaimFailed},
		{io.ErrUnexpectedEOF, 500, protocol.ErrInternal},
	} {
		srv, _ := newServer(t, &fakeProvider{ensureErr: tc.err})
		res, body := do(t, "POST", srv.URL+"/sandboxes", protocol.EnsureRequest{ID: id, Handle: "h"})
		if res.StatusCode != tc.status || errorCode(t, body) != tc.code {
			t.Errorf("%v: %d %s", tc.err, res.StatusCode, body)
		}
		if tc.code == protocol.ErrBootstrapRejected && !strings.Contains(body, `"status":401`) {
			t.Errorf("the daemon's status is lost: %s", body)
		}
	}
}

func TestStatusResurrectsOnlyWhenAsked(t *testing.T) {
	p := &fakeProvider{}
	srv, _ := newServer(t, p)
	_, body := do(t, "GET", srv.URL+"/sandboxes/h", nil)
	if p.resurrected || !strings.Contains(body, `"alive":false`) || !strings.Contains(body, `"oomKilled":true`) {
		t.Fatalf("observation had a side effect or lost data: %s", body)
	}
	_, body = do(t, "GET", srv.URL+"/sandboxes/h?resurrect=1", nil)
	if !p.resurrected || !strings.Contains(body, `"alive":true`) {
		t.Fatalf("got %s", body)
	}
}

func TestDelete(t *testing.T) {
	srv, _ := newServer(t, &fakeProvider{})
	if res, _ := do(t, "DELETE", srv.URL+"/sandboxes/h", nil); res.StatusCode != 204 {
		t.Fatalf("status %d", res.StatusCode)
	}
	srv, _ = newServer(t, &fakeProvider{deleteBlock: true})
	res, body := do(t, "DELETE", srv.URL+"/sandboxes/h", nil)
	if res.StatusCode != 202 || !strings.Contains(body, `"state":"draining"`) {
		t.Fatalf("%d %s", res.StatusCode, body)
	}
}

func TestLifetime(t *testing.T) {
	p := &fakeProvider{}
	srv, _ := newServer(t, p)
	grace := int64(30_000)
	for _, tc := range []struct {
		body   any
		status int
	}{
		{protocol.LifetimeRequest{ExtendToIdleWindow: true}, 204},
		{protocol.LifetimeRequest{GraceMs: &grace}, 204},
		{protocol.LifetimeRequest{}, 400},
		{protocol.LifetimeRequest{ExtendToIdleWindow: true, GraceMs: &grace}, 400},
		{map[string]any{"graceMs": -1}, 400},
	} {
		if res, body := do(t, "PATCH", srv.URL+"/sandboxes/h/lifetime", tc.body); res.StatusCode != tc.status {
			t.Errorf("%+v: %d %s", tc.body, res.StatusCode, body)
		}
	}
	if p.renewed != 1 || len(p.released) != 1 || p.released[0] != 30*time.Second {
		t.Fatalf("renewed=%d released=%v", p.renewed, p.released)
	}
}

func TestCredentials(t *testing.T) {
	p := &fakeProvider{}
	srv, st := newServer(t, p)
	res, body := do(t, "POST", srv.URL+"/sandboxes/h/credentials", protocol.CredentialsRequest{CloneURL: "https://x:t@github.com/a/b.git"})
	if res.StatusCode != 404 || errorCode(t, body) != protocol.ErrUnknownHandle {
		t.Fatalf("no row: %d %s", res.StatusCode, body)
	}
	_ = st.Put(context.Background(), id, "agent-sandbox", "h", map[string]string{})
	if res, _ := do(t, "POST", srv.URL+"/sandboxes/h/credentials", protocol.CredentialsRequest{}); res.StatusCode != 400 {
		t.Fatalf("empty cloneUrl: %d", res.StatusCode)
	}
	if res, _ := do(t, "POST", srv.URL+"/sandboxes/h/credentials", protocol.CredentialsRequest{CloneURL: "https://x:t@github.com/a/b.git"}); res.StatusCode != 204 || len(p.rotated) != 1 {
		t.Fatalf("status %d rotated %v", res.StatusCode, p.rotated)
	}
}

func TestEvents(t *testing.T) {
	p := &fakeProvider{phases: []protocol.Phase{{Kind: protocol.PhaseClaiming, Since: 1}, {Kind: protocol.PhaseReady}}}
	srv, _ := newServer(t, p)
	res, err := http.Get(srv.URL + "/sandboxes/h/events")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.Header.Get("content-type") != "text/event-stream" {
		t.Fatalf("content-type %s", res.Header.Get("content-type"))
	}
	var data []string
	sc := bufio.NewScanner(res.Body)
	for sc.Scan() {
		if line := sc.Text(); strings.HasPrefix(line, "data: ") {
			data = append(data, strings.TrimPrefix(line, "data: "))
		}
	}
	if len(data) != 2 || data[0] != `{"kind":"claiming","since":1}` || data[1] != `{"kind":"ready"}` {
		t.Fatalf("events = %v", data)
	}
}

func TestReadRoutes(t *testing.T) {
	srv, _ := newServer(t, &fakeProvider{})
	for path, want := range map[string]string{
		"/healthz":  `{"ok":true}`,
		"/capacity": `{"schedulable":true}`,
		"/images":   `{"runtimes":[{"runtime":"agent-sandbox","images":[{"name":"android","baseTag":"1"}]}]}`,
	} {
		if _, body := do(t, "GET", srv.URL+path, nil); strings.TrimSpace(body) != want {
			t.Errorf("%s = %s, want %s", path, body, want)
		}
	}
	if _, body := do(t, "GET", srv.URL+"/runtimes", nil); !strings.Contains(body, `"name":"agent-sandbox","available":true`) || !strings.Contains(body, `"capacity":{"schedulable":true`) {
		t.Errorf("/runtimes = %s", body)
	}
	// Exactly the spec's routes: the retired adopt route and anything else 404.
	for _, r := range [][2]string{{"POST", "/sandboxes/h/adopt"}, {"GET", "/sandboxes"}, {"PUT", "/sandboxes/h"}} {
		if res, _ := do(t, r[0], srv.URL+r[1], nil); res.StatusCode != 404 && res.StatusCode != 405 {
			t.Errorf("%s %s = %d", r[0], r[1], res.StatusCode)
		}
	}
}

func TestCapacityPerImage(t *testing.T) {
	srv, _ := newServer(t, &fakeProvider{fullImages: map[string]bool{"android": true}})
	for query, want := range map[string]string{
		"":                           `{"schedulable":true}`,
		"?sandboxImage=default":      `{"schedulable":true}`,
		"?sandboxImage=android":      `{"schedulable":false}`,
		"?sandboxImage=Not_An_Image": `"code":"bad-request"`,
	} {
		if _, body := do(t, "GET", srv.URL+"/capacity"+query, nil); !strings.Contains(body, want) {
			t.Errorf("/capacity%s = %s, want %s", query, body, want)
		}
	}
}

func TestTenantPoolsPush(t *testing.T) {
	p := &fakeProvider{}
	srv, _ := newServer(t, p)
	res, body := do(t, "POST", srv.URL+"/tenant-pools/push", map[string]any{"repo": "acme/site", "ref": "refs/heads/main"})
	if res.StatusCode != 200 || strings.TrimSpace(body) != `{"pools":["tenant-acme"]}` || len(p.pushes) != 1 {
		t.Fatalf("status=%d body=%s pushes=%v", res.StatusCode, body, p.pushes)
	}
	if res, _ := do(t, "POST", srv.URL+"/tenant-pools/push", map[string]any{"repo": "acme/site"}); res.StatusCode != 400 {
		t.Fatalf("a push without a ref = %d", res.StatusCode)
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
