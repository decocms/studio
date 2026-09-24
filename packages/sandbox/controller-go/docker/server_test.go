package docker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
	"github.com/decocms/studio/packages/sandbox/controller-go/runtime"
	"github.com/decocms/studio/packages/sandbox/controller-go/server"
)

func TestClaimAPIOnDocker(t *testing.T) {
	h := newHarness(t, Config{})
	registry := runtime.NewRegistry(
		&runtime.Runtime{Name: "agent-sandbox", Priority: 10, Capabilities: []protocol.Capability{protocol.CapWarmPool}, Provider: probeFails{h.runner}},
		&runtime.Runtime{Name: Name, Priority: 20, Capabilities: Capabilities, Provider: h.runner},
	)
	srv := httptest.NewServer((&server.Server{Registry: registry, Store: h.store, DeleteDeadline: time.Second}).Handler())
	t.Cleanup(srv.Close)
	call := func(method, path, body string) (int, string) {
		t.Helper()
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}

	status, body := call("GET", "/runtimes", "")
	var runtimes protocol.RuntimesResponse
	_ = json.Unmarshal([]byte(body), &runtimes)
	if status != 200 || len(runtimes.Runtimes) != 2 || runtimes.Runtimes[1].Name != Name || !runtimes.Runtimes[1].Available || runtimes.Runtimes[0].Available {
		t.Fatalf("/runtimes = %d %s", status, body)
	}
	if status, body := call("GET", "/images", ""); status != 200 || body != `{"runtimes":[{"runtime":"docker","images":[{"name":"android"}]}]}`+"\n" {
		t.Fatalf("/images = %d %s", status, body)
	}
	if status, body := call("GET", "/capacity", ""); status != 200 || !strings.Contains(body, `"schedulable":true`) {
		t.Fatalf("/capacity = %d %s", status, body)
	}

	status, body = call("POST", "/sandboxes", `{"id":{"userId":"u_1","projectRef":"agent:org:vmcp:main"},"handle":"sb-1","opts":{"sandboxImage":"android"}}`)
	var ensured protocol.EnsureResponse
	_ = json.Unmarshal([]byte(body), &ensured)
	if status != 200 || ensured.Runtime != Name || ensured.Image.Served != "android" || ensured.Daemon.URL == "" {
		t.Fatalf("POST /sandboxes = %d %s", status, body)
	}
	if rec, _ := h.store.ByHandle(ctx, "sb-1"); rec == nil || rec.Runtime != Name {
		t.Fatalf("row = %+v", rec)
	}

	status, body = call("GET", "/sandboxes/sb-1", "")
	var got protocol.StatusResponse
	_ = json.Unmarshal([]byte(body), &got)
	if status != 200 || !got.Alive || got.Runtime != Name || got.Daemon == nil || got.LastTermination != nil {
		t.Fatalf("GET /sandboxes/sb-1 = %d %s", status, body)
	}
	if status, body := call("PATCH", "/sandboxes/sb-1/lifetime", `{"graceMs":1000}`); status != 204 {
		t.Fatalf("PATCH lifetime = %d %s", status, body)
	}
	if status, body := call("DELETE", "/sandboxes/sb-1", ""); status != 204 {
		t.Fatalf("DELETE = %d %s", status, body)
	}
	if h.engine.get("sb-1") != nil {
		t.Fatal("container survived DELETE")
	}
}

// probeFails is a runtime whose probe fails, as agent-sandbox's does on a
// machine with no cluster.
type probeFails struct{ runtime.Provider }

func (probeFails) Probe(context.Context) (bool, string) { return false, "no cluster" }
