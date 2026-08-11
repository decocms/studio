package setup

// A clone URL carries a short-lived GitHub App token
// (`https://x-access-token:ghs_...@github.com/org/repo.git`). The golden meta is
// written to a hostPath shared by every sandbox on the node and chowned to the
// uid the tenant runs as, so persisting the raw URL hands one tenant another
// tenant's credential. Observed in stg before this guard existed.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// SYNTHETIC. Never paste a real token here, not even truncated: this file is
// committed, and a fixture is not a place to store a credential. The shape is
// what matters — `x-access-token:ghs_<opaque>` is what a clone URL carries.
const tokenUrl = "https://x-access-token:ghs_FAKE0000000000000000000000000000@github.com/acme/site.git"

func TestGoldenMetaNeverPersistsCredentials(t *testing.T) {
	dir := t.TempDir()
	nm := filepath.Join(dir, "node_modules")
	if err := os.MkdirAll(nm, 0o755); err != nil {
		t.Fatal(err)
	}
	WriteGoldenMeta(nm, GoldenMeta{OrgId: "org_a", CloneUrl: tokenUrl, Pm: "bun", Env: "stg"})

	raw, err := os.ReadFile(goldenMetaPath(nm))
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	// Assert on the file's bytes, not on the struct: the struct could be right
	// while the write path is wrong, and it is the file a co-tenant can read.
	for _, secret := range []string{"ghs_", "x-access-token", "FAKE0000000000000000000000000000"} {
		if strings.Contains(body, secret) {
			t.Fatalf("meta persisted a credential (%q):\n%s", secret, body)
		}
	}
	// Still useful for an incident: the repo must remain identifiable.
	if !strings.Contains(body, "github.com/acme/site.git") {
		t.Fatalf("stripping removed the repo identity too:\n%s", body)
	}

	meta, ok := ReadGoldenMeta(nm)
	if !ok {
		t.Fatal("meta unreadable after stripping")
	}
	if strings.Contains(meta.CloneUrl, "ghs_") {
		t.Fatalf("read-back still carries a credential: %q", meta.CloneUrl)
	}
}

// An unparseable URL must yield nothing rather than fall through to the raw
// string — a partial parse failure is exactly when a token would slip past.
func TestStripCredentialsFailsClosed(t *testing.T) {
	if got := stripCredentials("://x-access-token:ghs_abc@bad"); got != "" {
		t.Fatalf("unparseable URL was persisted: %q", got)
	}
	if got := stripCredentials("https://github.com/acme/site.git"); got != "https://github.com/acme/site.git" {
		t.Fatalf("a credential-free URL was altered: %q", got)
	}
}

// The cache key must not shift because of this change: it already stripped
// credentials, and a different key would orphan every archive already published.
func TestRepoCacheKeyUnchangedByStripping(t *testing.T) {
	bare := repoCacheKey("https://github.com/acme/site.git")
	withToken := repoCacheKey(tokenUrl)
	if bare != withToken {
		t.Fatalf("key now depends on credentials:\n bare  %q\n token %q", bare, withToken)
	}
	// Anchored values: the guard is that the ALGORITHM is stable, because a
	// changed key orphans every archive already in the store. Synthetic URLs on
	// purpose — a test fixture must not name a customer's repository.
	for url, want := range map[string]string{
		"https://github.com/acme/site.git":       "2182d8011efb6345",
		"https://github.com/acme/other-site.git": "ad745d22a5f67e77",
	} {
		if got := repoCacheKey(url); got != want {
			t.Fatalf("key for %s changed to %q (want %q) — published archives would be orphaned", url, got, want)
		}
	}
}
