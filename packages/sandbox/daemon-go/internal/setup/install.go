package setup

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
	"github.com/decocms/studio/sandbox-daemon/internal/gitx"
	"github.com/decocms/studio/sandbox-daemon/internal/paths"
)

// repoCacheKey: 16 hex chars of sha256 over the credential-stripped cloneUrl.
// This per-repo partition is a security boundary — bun does not re-verify
// cache integrity, so a shared writable cache across repos is cross-tenant
// RCE. Do not widen.
// stripCredentials removes any userinfo from a clone URL. Clone URLs carry a
// short-lived GitHub App token (`x-access-token:ghs_...`), so anything that
// records or hashes a URL must strip it first.
func stripCredentials(cloneUrl string) string {
	u, err := url.Parse(cloneUrl)
	if err != nil {
		// Unparseable: return nothing rather than risk persisting a token.
		return ""
	}
	u.User = nil
	return u.String()
}

func repoCacheKey(cloneUrl string) string {
	key := stripCredentials(cloneUrl)
	if key == "" {
		key = cloneUrl
	}
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])[:16]
}

func resolveCloneUrl(cfg *config.Enriched, repoDir string) string {
	if u := cfg.CloneUrl(); u != "" {
		return u
	}
	if repoDir == "" || !paths.HasGitRepo(repoDir) {
		return ""
	}
	out, ok := gitx.Try([]string{"remote", "get-url", "origin"}, gitx.RunOpts{Cwd: repoDir})
	if !ok {
		return ""
	}
	return out
}

func DepsCacheEnv(cfg *config.Enriched, repoDir string) map[string]string {
	cacheRoot := os.Getenv("DEPS_CACHE_ROOT")
	if cacheRoot == "" {
		return nil
	}
	cloneUrl := resolveCloneUrl(cfg, repoDir)
	if cloneUrl == "" {
		return nil
	}
	return map[string]string{
		"BUN_INSTALL_CACHE_DIR": filepath.Join(cacheRoot, "bun", repoCacheKey(cloneUrl)),
	}
}

// PkgCacheWarmth reports whether this repo's package-manager download cache was
// already populated BEFORE the install ran: "warm", "cold", or "unknown" when
// there is no cache root or no repo to key on.
//
// It exists to answer a design question the existing timing cannot: the install
// phase is measured as one number, so a slow `miss` is indistinguishable between
// "downloaded every tarball" and "materialised 100k files from a warm cache".
// That distinction decides whether the golden tiers are worth their machinery —
// if a warm install is nearly free, skipping install buys little and the effort
// belongs on the filesystem instead (bun links near-instantly only when the
// cache and node_modules share a reflink-capable mount, which they do not while
// /app is an emptyDir).
//
// Must be called BEFORE the install: afterwards every cache is warm.
func PkgCacheWarmth(cfg *config.Enriched, repoDir string) string {
	cacheRoot := os.Getenv("DEPS_CACHE_ROOT")
	if cacheRoot == "" {
		return "unknown"
	}
	cloneUrl := resolveCloneUrl(cfg, repoDir)
	if cloneUrl == "" {
		return "unknown"
	}
	var dir string
	switch cfg.PmName() {
	case "deno":
		dir = filepath.Join(cacheRoot, "deno", repoCacheKey(cloneUrl))
	case "bun":
		dir = filepath.Join(cacheRoot, "bun", repoCacheKey(cloneUrl))
	default:
		// npm/pnpm/yarn are not pointed at the shared cache at all, so their
		// installs always pay full price. Saying "cold" would read as a warmable
		// miss; this is a different fact.
		return "unpointed"
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) == 0 {
		return "cold"
	}
	return "warm"
}

func DenoCacheEnv(cfg *config.Enriched, repoDir string) map[string]string {
	cacheRoot := os.Getenv("DEPS_CACHE_ROOT")
	if cacheRoot == "" {
		return nil
	}
	if cfg.PmName() != "deno" {
		return nil
	}
	cloneUrl := resolveCloneUrl(cfg, repoDir)
	if cloneUrl == "" {
		return nil
	}
	return map[string]string{"DENO_DIR": filepath.Join(cacheRoot, "deno", repoCacheKey(cloneUrl))}
}

// SpawnInstall runs the package manager's install command. Returns
// (exitCode, true) when an install ran, (0, false) when no install step
// applies (no pm, no install command, or no manifest).
func SpawnInstall(cfg *config.Enriched, repoDir string, env map[string]string, onChunk func(data string)) (int, bool) {
	pm := cfg.PmName()
	if pm == "" {
		return 0, false
	}
	pmConfig, ok := PackageManagers[pm]
	if !ok || pmConfig.Install == "" {
		return 0, false
	}
	installRoot := paths.ResolvePmRoot(repoDir, cfg.PmPath())
	hasManifest := false
	for _, m := range pmConfig.Manifests {
		if _, err := os.Stat(filepath.Join(installRoot, m)); err == nil {
			hasManifest = true
			break
		}
	}
	if !hasManifest {
		onChunk(fmt.Sprintf("\r\n[install] no package manifest (%s) found at %s — skipping install\r\n",
			joinOr(pmConfig.Manifests), installRoot))
		return 0, false
	}
	corepack := "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && (corepack enable 2>/dev/null || true) && "
	cmd := fmt.Sprintf("%scd %s && %s%s", cfg.RuntimePathPrefix, installRoot, corepack, pmConfig.Install)
	onChunk("\r\n$ " + cmd + "\r\n")
	merged := map[string]string{}
	for k, v := range DepsCacheEnv(cfg, repoDir) {
		merged[k] = v
	}
	for k, v := range env {
		merged[k] = v
	}
	return SpawnStep(cmd, onChunk, merged), true
}

func joinOr(items []string) string {
	out := ""
	for i, s := range items {
		if i > 0 {
			out += " or "
		}
		out += s
	}
	return out
}
