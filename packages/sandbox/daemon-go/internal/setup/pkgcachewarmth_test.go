package setup

// The install phase is timed as ONE number, so a slow `miss` cannot be told apart
// from "downloaded every tarball" versus "materialised 100k files from a warm
// cache". That distinction decides whether the golden tiers earn their machinery,
// so it has to be an attribute rather than a guess.

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

func TestPkgCacheWarmthOmittedFromLineWhenUnset(t *testing.T) {
	// Existing dashboard panels parse this line; an always-present key would
	// change its shape for consumers that never asked for the field.
	line := BuildDepsRestoreLine(RestoreMiss, "https://github.com/o/r.git", 5, "b", "")
	if want := "pkg_cache"; contains(line, want) {
		t.Fatalf("empty warmth still emitted the key:\n%s", line)
	}
	line = BuildDepsRestoreLine(RestoreMiss, "https://github.com/o/r.git", 5, "b", "warm")
	if !contains(line, `"pkg_cache":"warm"`) {
		t.Fatalf("warmth missing from the line:\n%s", line)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}

func TestPkgCacheWarmthUnknownWithoutARoot(t *testing.T) {
	t.Setenv("DEPS_CACHE_ROOT", "")
	if got := PkgCacheWarmth(nil, t.TempDir()); got != "unknown" {
		t.Fatalf("got %q want unknown", got)
	}
}

// A populated cache dir is warm, an absent or empty one is cold. Empty counts as
// cold on purpose: a directory the chown init container created but nothing has
// written to has saved no work.
func TestPkgCacheWarmthReadsTheCacheDir(t *testing.T) {
	root := t.TempDir()
	t.Setenv("DEPS_CACHE_ROOT", root)
	key := repoCacheKey("https://github.com/acme/site.git")

	dir := filepath.Join(root, "bun", key)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := cfgWithPm("bun", "https://github.com/acme/site.git")
	// Present but empty.
	if got := PkgCacheWarmth(cfg, ""); got != "cold" {
		t.Fatalf("an empty cache dir read as %q, want cold", got)
	}
	if err := os.WriteFile(filepath.Join(dir, "some-tarball"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := PkgCacheWarmth(cfg, ""); got != "warm" {
		t.Fatalf("a populated cache dir read as %q, want warm", got)
	}
}

// npm/pnpm/yarn are never pointed at the shared cache, so their installs always
// pay full price. Reporting "cold" would read as a warmable miss and skew the
// very comparison this attribute exists for; it is a different fact.
func TestPkgCacheWarmthUnpointedForNonBunNonDeno(t *testing.T) {
	t.Setenv("DEPS_CACHE_ROOT", t.TempDir())
	for _, pm := range []string{"npm", "pnpm", "yarn"} {
		cfg := cfgWithPm(pm, "https://github.com/acme/site.git")
		if got := PkgCacheWarmth(cfg, ""); got != "unpointed" {
			t.Fatalf("%s read as %q, want unpointed", pm, got)
		}
	}
}

func cfgWithPm(pm, cloneUrl string) *config.Enriched {
	return &config.Enriched{TenantConfig: config.TenantConfig{
		Git: &config.GitConfig{Repository: &config.GitRepository{CloneUrl: &cloneUrl}},
		Application: &config.Application{
			PackageManager: &config.PackageManagerConfig{Name: &pm},
		},
	}}
}
