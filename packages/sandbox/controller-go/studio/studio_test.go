package studio

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
)

func TestCallbacks(t *testing.T) {
	var got map[string]any
	var path string
	answer := `{"cloneUrl":"https://x-access-token:fresh@github.com/a/b.git"}`
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &got)
		switch answer {
		case "500":
			w.WriteHeader(500)
		default:
			_, _ = io.WriteString(w, answer)
		}
	}))
	defer srv.Close()
	c, err := New(srv.URL+"/", srv.Client().Transport.(*http.Transport).TLSClientConfig)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	fresh, err := c.MintCloneURL(ctx, protocol.EnsureRepo{CloneURL: "https://github.com/a/b.git", RepositoryID: "repo_1"}, 1800000)
	if err != nil || fresh != "https://x-access-token:fresh@github.com/a/b.git" {
		t.Fatalf("fresh=%q err=%v", fresh, err)
	}
	if path != protocol.CloneURLPath || got["repositoryId"] != "repo_1" || got["bufferMs"] != float64(1800000) || got["connectionId"] != nil {
		t.Fatalf("path=%s body=%v", path, got)
	}

	answer = `{"cloneUrl":null}`
	if fresh, err := c.MintCloneURL(ctx, protocol.EnsureRepo{CloneURL: "u", ConnectionID: "c"}, 0); err != nil || fresh != "" {
		t.Fatalf("a decline is empty, not an error: %q %v", fresh, err)
	}
	answer = "500"
	if _, err := c.MintCloneURL(ctx, protocol.EnsureRepo{CloneURL: "u", ConnectionID: "c"}, 0); err == nil {
		t.Fatal("a 500 is an error")
	}

	answer = `{"orgFsConfigJson":"{\"mounts\":[]}"}`
	cfg, err := c.MintOrgFsConfig(ctx, protocol.Tenant{OrgID: "o", UserID: "u", OrgSlug: "acme"})
	if err != nil || cfg != `{"mounts":[]}` || path != protocol.OrgFsConfigPath {
		t.Fatalf("cfg=%q err=%v path=%s", cfg, err, path)
	}

	if _, err := New("http://studio.internal", nil); err == nil {
		t.Fatal("a plaintext callback URL must be refused")
	}
}
