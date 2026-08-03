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
func repoCacheKey(cloneUrl string) string {
	key := cloneUrl
	if u, err := url.Parse(cloneUrl); err == nil {
		u.User = nil
		key = u.String()
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
