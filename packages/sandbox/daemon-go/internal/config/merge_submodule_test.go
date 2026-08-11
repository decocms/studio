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

	// A credentials-only change has no side effect to run — no re-clone, no
	// restart — so Classify calls it a no-op. That must not be read as "don't
	// write it down": the store has to end up holding the new value, or a PAT
	// rotation is accepted with a 200 and silently discarded.
	t.Run("a credentials-only change is a no-op transition", func(t *testing.T) {
		before := repoWithCreds()
		after := repoWithCreds(github)
		if kind := Classify(before, after).Kind; kind != KindNoOp {
			t.Fatalf("transition = %q, want %q", kind, KindNoOp)
		}
	})

	t.Run("...but the store still persists it", func(t *testing.T) {
		store := NewStore()
		if res := store.Apply(&Patch{Git: &GitConfig{Repository: &GitRepository{
			CloneUrl: Str("https://github.com/acme/site.git"),
		}}}); !res.Applied {
			t.Fatalf("bootstrap rejected: %s", res.Reason)
		}
		res := store.Apply(&Patch{Git: &GitConfig{Repository: &GitRepository{
			SubmoduleCredentials: []SubmoduleCredential{github},
		}}})
		if !res.Applied || res.Transition.Kind != KindNoOp {
			t.Fatalf("applied=%v transition=%q", res.Applied, res.Transition.Kind)
		}
		// The receipt and the store must agree — this is what regressed.
		if got := res.After.SubmoduleCredentials(); len(got) != 1 {
			t.Fatalf("receipt lost the credentials: %v", got)
		}
		if got := store.Read().SubmoduleCredentials(); len(got) != 1 || got[0] != github {
			t.Fatalf("store = %v, want %v", got, []SubmoduleCredential{github})
		}
	})

	t.Run("an inert patch does not claim an unconfigured daemon", func(t *testing.T) {
		store := NewStore()
		store.Apply(&Patch{Git: &GitConfig{Repository: &GitRepository{
			SubmoduleCredentials: []SubmoduleCredential{github},
		}}})
		if store.Read() != nil {
			t.Fatalf("store bootstrapped from a credentials-only patch: %+v", store.Read())
		}
	})
}
