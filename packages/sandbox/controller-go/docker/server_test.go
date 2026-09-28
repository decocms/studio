package docker

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

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
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "studio-test"}, nil).
		Connect(ctx, &mcp.StreamableClientTransport{Endpoint: srv.URL + protocol.PathMCP}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	call := func(tool string, args any, out any) string {
		t.Helper()
		res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: tool, Arguments: args})
		if err != nil {
			t.Fatalf("%s: %v", tool, err)
		}
		text := res.Content[0].(*mcp.TextContent).Text
		if res.IsError {
			t.Fatalf("%s failed: %s", tool, text)
		}
		if out != nil {
			_ = json.Unmarshal([]byte(text), out)
		}
		return text
	}

	var runtimes protocol.RuntimesResponse
	body := call(protocol.ToolRuntimes, nil, &runtimes)
	if len(runtimes.Runtimes) != 2 || runtimes.Runtimes[1].Name != Name || !runtimes.Runtimes[1].Available || runtimes.Runtimes[0].Available {
		t.Fatalf("runtimes = %s", body)
	}
	if body := call(protocol.ToolImages, nil, nil); body != `{"runtimes":[{"runtime":"docker","images":[{"name":"android"}]}]}` {
		t.Fatalf("images = %s", body)
	}
	if body := call(protocol.ToolCapacity, nil, nil); !strings.Contains(body, `"schedulable":true`) {
		t.Fatalf("capacity = %s", body)
	}

	var ensured protocol.EnsureResponse
	body = call(protocol.ToolEnsure, protocol.EnsureRequest{
		ID: protocol.SandboxID{UserID: "u_1", ProjectRef: "agent:org:vmcp:main"}, Handle: "sb-1",
		Opts: &protocol.EnsureOptions{SandboxImage: "android"},
	}, &ensured)
	if ensured.Runtime != Name || ensured.Image.Served != "android" || ensured.Daemon.URL == "" {
		t.Fatalf("ensure = %s", body)
	}
	if rec, _ := h.store.ByHandle(ctx, "sb-1"); rec == nil || rec.Runtime != Name {
		t.Fatalf("row = %+v", rec)
	}

	var got protocol.StatusResponse
	body = call(protocol.ToolStatus, protocol.StatusRequest{Handle: "sb-1"}, &got)
	if !got.Alive || got.Runtime != Name || got.Daemon == nil || got.LastTermination != nil {
		t.Fatalf("status = %s", body)
	}
	grace := int64(1000)
	call(protocol.ToolLifetime, protocol.LifetimeRequest{Handle: "sb-1", GraceMs: &grace}, nil)
	if body := call(protocol.ToolDelete, protocol.HandleRequest{Handle: "sb-1"}, nil); body != `{"state":"deleted"}` {
		t.Fatalf("delete = %s", body)
	}
	if h.engine.get("sb-1") != nil {
		t.Fatal("container survived the delete")
	}
}

// probeFails is a runtime whose probe fails, as agent-sandbox's does on a
// machine with no cluster.
type probeFails struct{ runtime.Provider }

func (probeFails) Probe(context.Context) (bool, string) { return false, "no cluster" }
