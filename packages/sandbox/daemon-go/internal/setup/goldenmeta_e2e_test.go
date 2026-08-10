package setup

// The whole chain, in one test: the JSON Studio actually POSTs to /config, through
// the config merge, into GoldenParams, out as a golden's provenance file, and read
// back by the uploader.
//
// Every earlier test covered one link and all of them passed while the chain was
// broken: Studio sent orgId, the Patch struct did not declare it, DeepMerge
// rebuilt TenantConfig without it, so every golden was published with no
// provenance and the uploader skipped all of them. Nothing failed — the tier just
// silently did nothing. This asserts the seam, not the parts.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

func TestOrgIdReachesGoldenMeta(t *testing.T) {
	// Verbatim shape of buildConfigPayload's output for a claimed sandbox
	// (packages/sandbox/server/provider/shared/build-config-payload.ts).
	body := `{
	  "git": {"repository": {"cloneUrl": "https://github.com/acme/site.git"}},
	  "operator": {"userName": "Jane"},
	  "cloneOnly": false,
	  "application": {"packageManager": {"name": "bun"}, "runtime": "node"},
	  "orgId": "org_1rT2srZfM75G"
	}`
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &raw); err != nil {
		t.Fatal(err)
	}
	patch, err := config.ParsePatch(raw)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.DeepMerge(nil, patch)
	if cfg.OrgId == "" {
		t.Fatal("orgId did not survive the config merge — the golden would have no owner")
	}

	// What the orchestrator builds from that config, and what publish records.
	installRoot := t.TempDir()
	golden := filepath.Join(installRoot, "golden", "node_modules")
	if err := os.MkdirAll(golden, 0o755); err != nil {
		t.Fatal(err)
	}
	p := GoldenParams{
		CloneUrl:    cfg.CloneUrl(),
		InstallRoot: installRoot,
		Pm:          "bun",
		OrgId:       cfg.OrgId,
		Env:         "stg",
	}
	WriteGoldenMeta(golden, GoldenMeta{OrgId: p.OrgId, CloneUrl: p.CloneUrl, Pm: p.Pm, Env: p.Env})

	// And what the uploader reads back before deciding to publish.
	meta, ok := ReadGoldenMeta(golden)
	if !ok {
		t.Fatal("the uploader would skip this golden as having no provenance")
	}
	if meta.OrgId != "org_1rT2srZfM75G" {
		t.Fatalf("org lost end to end: %q", meta.OrgId)
	}
	if meta.Env != "stg" {
		t.Fatalf("env lost end to end: %q", meta.Env)
	}
	if meta.CloneUrl != "https://github.com/acme/site.git" {
		t.Fatalf("clone url lost end to end: %q", meta.CloneUrl)
	}
}
