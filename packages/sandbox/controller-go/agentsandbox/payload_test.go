package agentsandbox

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
)

func marshal(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestWorkloadConfigPayload(t *testing.T) {
	repo := &protocol.EnsureRepo{CloneURL: "https://x-access-token:tok@github.com/acme/site.git", UserName: "Ana", UserEmail: "ana@acme.dev", Branch: "feat"}
	for _, tc := range []struct {
		name      string
		opts      *protocol.EnsureOptions
		poolBound bool
		contains  []string
		absent    []string
		isNil     bool
	}{
		{
			name: "empty lists reach the wire so a reused pod drops revoked PATs and removed repos",
			opts: &protocol.EnsureOptions{Repo: repo},
			contains: []string{
				`"submoduleCredentials":[]`, `"repositories":[]`, `"repoName":"acme/site"`, `"branch":"feat"`,
				`"identity":{"userName":"Ana","userEmail":"ana@acme.dev"}`, `"cloneOnly":false`,
			},
		},
		{
			name: "secondary repos keep the caller's directory; one without is dropped",
			opts: &protocol.EnsureOptions{Repo: repo, ExtraRepos: []protocol.EnsureRepo{
				{CloneURL: "https://github.com/acme/checkout.git", DirectoryName: "checkout", Branch: "main"},
				{CloneURL: "https://github.com/acme/nameless.git"},
			}},
			contains: []string{`"repositories":[{"cloneUrl":"https://github.com/acme/checkout.git","branch":"main","repoName":"checkout","submoduleCredentials":[]}]`},
			absent:   []string{"nameless"},
		},
		{
			name:     "a pool pod bootstraps with no author: no identity",
			opts:     &protocol.EnsureOptions{Repo: &protocol.EnsureRepo{CloneURL: "https://github.com/acme/site.git", UserName: "  ", UserEmail: ""}},
			absent:   []string{"identity"},
			contains: []string{`"repoName":"acme/site"`},
		},
		{
			name:     "cloneOnly travels, true or false",
			opts:     &protocol.EnsureOptions{CloneOnly: true},
			contains: []string{`"cloneOnly":true`},
		},
		{
			name:      "cloneOnly is dropped on a bound tenant-pool pod, whose clone step would stop the warm dev server",
			opts:      &protocol.EnsureOptions{CloneOnly: true, Purpose: protocol.PurposeHarnessRun},
			poolBound: true,
			contains:  []string{`"cloneOnly":false`},
		},
		{
			name:     "operator identity normalizes like git-co-author.ts: a bad email is dropped",
			opts:     &protocol.EnsureOptions{Tenant: &protocol.Tenant{OrgID: "org_1", UserID: "u", UserName: " Ana ", UserEmail: "not-an-email"}},
			contains: []string{`"operator":{"userName":"Ana"}`, `"orgId":"org_1"`},
		},
		{
			name:   "a name with a newline is no operator",
			opts:   &protocol.EnsureOptions{Tenant: &protocol.Tenant{OrgID: "o", UserID: "u", UserName: "Ana\nEvil"}},
			absent: []string{"operator"},
		},
		{
			name:     "workload becomes the application block",
			opts:     &protocol.EnsureOptions{Workload: &protocol.Workload{Runtime: protocol.RuntimeBun, PackageManager: protocol.PackageManagerBun, PackageManagerPath: "apps/web", DevPort: 5173}},
			contains: []string{`"application":{"packageManager":{"name":"bun","path":"apps/web"},"runtime":"bun","port":5173}`},
		},
		{name: "a row with no options says nothing", opts: nil, isNil: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := workloadConfigPayload(tc.opts, tc.poolBound)
			if tc.isNil {
				if got != nil {
					t.Fatalf("want nil, got %s", marshal(t, got))
				}
				return
			}
			s := marshal(t, got)
			for _, want := range tc.contains {
				if !strings.Contains(s, want) {
					t.Errorf("payload %s\nlacks %s", s, want)
				}
			}
			for _, bad := range tc.absent {
				if strings.Contains(s, bad) {
					t.Errorf("payload %s\nshould not contain %s", s, bad)
				}
			}
		})
	}
}

func TestGitCredentialRefreshPatch(t *testing.T) {
	if p := gitCredentialRefreshPatch("https://github.com/acme/public.git"); p != nil {
		t.Fatalf("a public clone has nothing to rotate, got %s", marshal(t, p))
	}
	got := marshal(t, gitCredentialRefreshPatch("https://x-access-token:new@github.com/acme/site.git"))
	// Only the URL: a patch naming submodule credentials or repositories would
	// replace them.
	if want := `{"git":{"repository":{"cloneUrl":"https://x-access-token:new@github.com/acme/site.git"}}}`; got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}
