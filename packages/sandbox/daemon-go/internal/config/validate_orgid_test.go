package config

import "testing"

func TestValidateRejectsPathTraversingOrgId(t *testing.T) {
	cases := []struct {
		name    string
		orgId   string
		wantErr bool
	}{
		{"normal org id", "org_abc", false},
		{"empty (unset)", "", false},
		{"parent traversal", "../../etc", true},
		{"embedded slash", "org/abc", true},
		{"bare parent", "..", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg := &TenantConfig{OrgId: c.orgId}
			got := Validate(cfg)
			if c.wantErr && got == "" {
				t.Fatalf("Validate(orgId=%q) = %q, want a rejection reason", c.orgId, got)
			}
			if !c.wantErr && got != "" {
				t.Fatalf("Validate(orgId=%q) = %q, want no error", c.orgId, got)
			}
		})
	}
}
