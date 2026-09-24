package protocol

import (
	"encoding/json"
	"testing"
)

// The daemon merges an absent list as "keep current", so an empty list the
// caller built must reach the wire, or a revoked PAT or a dropped secondary
// repo survives on a reused pod. Nil stays absent so a credential-only patch
// does not wipe them.
func TestEmptyListsAreSentNilListsAreNot(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   GitConfig
		want string
	}{
		{"nil", GitConfig{Repository: &GitRepository{CloneUrl: Str("u")}}, `{"repository":{"cloneUrl":"u"}}`},
		{
			"empty",
			GitConfig{Repository: &GitRepository{CloneUrl: Str("u"), SubmoduleCredentials: []SubmoduleCredential{}}, Repositories: []GitRepository{}},
			`{"repository":{"cloneUrl":"u","submoduleCredentials":[]},"repositories":[]}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := json.Marshal(tc.in)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tc.want {
				t.Fatalf("got %s, want %s", got, tc.want)
			}
		})
	}
}

func TestConfigRequestInlinesThePatch(t *testing.T) {
	got, err := json.Marshal(ConfigRequest{
		TenantConfig: TenantConfig{OrgId: "org"},
		Auth:         &ConfigAuth{RotateToken: "t"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"orgId":"org","auth":{"rotateToken":"t"}}`; string(got) != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}
