package config

// The golden cache keys shared archives by org, and the org reaches the daemon
// only through a config patch. DeepMerge REBUILDS TenantConfig field by field,
// so a field missing from either Patch or the rebuild is dropped on every apply
// — silently, because nothing in the boot path reads it. That is exactly what
// happened: Studio sent orgId, ParsePatch ignored it, and every golden was
// published without provenance, which made the uploader skip all of them.

import (
	"encoding/json"
	"testing"
)

func parse(t *testing.T, body string) *Patch {
	t.Helper()
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &raw); err != nil {
		t.Fatal(err)
	}
	p, err := ParsePatch(raw)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestDeepMergeCarriesOrgId(t *testing.T) {
	t.Run("a patch that sets it", func(t *testing.T) {
		out := DeepMerge(nil, parse(t, `{"orgId":"org_abc"}`))
		if out.OrgId != "org_abc" {
			t.Fatalf("orgId lost through the patch: %q", out.OrgId)
		}
	})

	// The real sequence: Studio pushes the full workload config on claim, then
	// pushes narrower patches (git credential refresh, cloneOnly) afterwards. A
	// later patch must not wipe the org, or the golden published after it loses
	// provenance and the uploader skips it.
	t.Run("a later patch that omits it keeps it", func(t *testing.T) {
		first := DeepMerge(nil, parse(t, `{"orgId":"org_abc","cloneOnly":false}`))
		second := DeepMerge(first, parse(t, `{"cloneOnly":true}`))
		if second.OrgId != "org_abc" {
			t.Fatalf("a patch without orgId wiped it: %q", second.OrgId)
		}
		if second.CloneOnly == nil || !*second.CloneOnly {
			t.Fatal("the patch's own field did not apply")
		}
	})

	t.Run("a patch can change it", func(t *testing.T) {
		first := DeepMerge(nil, parse(t, `{"orgId":"org_a"}`))
		second := DeepMerge(first, parse(t, `{"orgId":"org_b"}`))
		if second.OrgId != "org_b" {
			t.Fatalf("got %q want org_b", second.OrgId)
		}
	})

	// Absent is not the same as empty: a warm pod's first patch may carry only a
	// token rotation, and treating that as "clear the org" is the bug this file
	// exists to prevent.
	t.Run("an empty patch keeps it", func(t *testing.T) {
		first := DeepMerge(nil, parse(t, `{"orgId":"org_abc"}`))
		if got := DeepMerge(first, parse(t, `{}`)).OrgId; got != "org_abc" {
			t.Fatalf("an empty patch wiped it: %q", got)
		}
	})
}
