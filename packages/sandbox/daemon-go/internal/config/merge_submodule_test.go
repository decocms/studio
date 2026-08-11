package config

import (
	"encoding/json"
	"reflect"
	"testing"
)

func repoWithCreds(creds ...SubmoduleCredential) *TenantConfig {
	return &TenantConfig{Git: &GitConfig{Repository: &GitRepository{
		CloneUrl:             Str("https://x-access-token:tok@github.com/acme/site.git"),
		SubmoduleCredentials: creds,
	}}}
}

func TestMergeSubmoduleCredentials(t *testing.T) {
	github := SubmoduleCredential{Host: "github.com", Token: "ghp_x"}

	t.Run("survives a patch that only refreshes the clone URL", func(t *testing.T) {
		// The credential-refresh path patches cloneUrl alone (~1h token rotation);
		// dropping the PATs there would leave a recovery re-clone without
		// submodules.
		patch := &Patch{Git: &GitConfig{Repository: &GitRepository{
			CloneUrl: Str("https://x-access-token:fresh@github.com/acme/site.git"),
		}}}
		got := DeepMerge(repoWithCreds(github), patch).SubmoduleCredentials()
		if !reflect.DeepEqual(got, []SubmoduleCredential{github}) {
			t.Fatalf("credentials = %v, want %v", got, []SubmoduleCredential{github})
		}
	})

	t.Run("an explicit empty array clears them", func(t *testing.T) {
		patch := &Patch{Git: &GitConfig{Repository: &GitRepository{
			SubmoduleCredentials: []SubmoduleCredential{},
		}}}
		if got := DeepMerge(repoWithCreds(github), patch).SubmoduleCredentials(); len(got) != 0 {
			t.Fatalf("credentials = %v, want empty", got)
		}
	})

	t.Run("a new set replaces the old one", func(t *testing.T) {
		gitlab := SubmoduleCredential{Host: "gitlab.com", Token: "glpat_y"}
		patch := &Patch{Git: &GitConfig{Repository: &GitRepository{
			SubmoduleCredentials: []SubmoduleCredential{gitlab},
		}}}
		got := DeepMerge(repoWithCreds(github), patch).SubmoduleCredentials()
		if !reflect.DeepEqual(got, []SubmoduleCredential{gitlab}) {
			t.Fatalf("credentials = %v, want %v", got, []SubmoduleCredential{gitlab})
		}
	})

	t.Run("parses off the wire shape Studio sends", func(t *testing.T) {
		raw := map[string]json.RawMessage{"git": json.RawMessage(
			`{"repository":{"cloneUrl":"https://github.com/acme/site.git","submoduleCredentials":[{"host":"github.com","token":"ghp_x"}]}}`,
		)}
		patch, err := ParsePatch(raw)
		if err != nil {
			t.Fatal(err)
		}
		got := DeepMerge(nil, patch).SubmoduleCredentials()
		if !reflect.DeepEqual(got, []SubmoduleCredential{github}) {
			t.Fatalf("credentials = %v, want %v", got, []SubmoduleCredential{github})
		}
	})

	t.Run("a credentials-only change is not an identity conflict", func(t *testing.T) {
		before := repoWithCreds()
		after := repoWithCreds(github)
		if kind := Classify(before, after).Kind; kind != KindNoOp {
			t.Fatalf("transition = %q, want %q", kind, KindNoOp)
		}
	})
}
