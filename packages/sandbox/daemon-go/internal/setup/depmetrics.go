package setup

import (
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/decocms/studio/sandbox-daemon/internal/telemetry"
)

// Dependency telemetry leaves the pod as JSON lines on stdout AND, where
// sandbox-env's `telemetry.*` opens an ACCEPT to the in-cluster collector, as
// OTLP metrics (see EmitDepsRestore). Shapes here must stay byte-compatible
// with the TS daemon's setup/dep-metrics.ts or the sandbox dashboard panels
// stop matching.

const (
	maxDeps        = 10_000
	maxLineBytes   = 600
	maxMetaBytes   = 80
	depsRestoreMsg = "sandbox.deps.restore"
	depsMsg        = "sandbox.deps"
)

// RestoreSource is which cache tier served a dependency step. "l1"/"l2" need
// the golden cache, which this daemon does not implement yet.
type RestoreSource string

const (
	RestoreL1        RestoreSource = "l1"
	RestoreL2        RestoreSource = "l2"
	RestoreMiss      RestoreSource = "miss"
	RestoreNoInstall RestoreSource = "no-install"
)

type depsRestoreLine struct {
	Msg        string        `json:"msg"`
	Source     RestoreSource `json:"source"`
	RepoHash   string        `json:"repo_hash"`
	DurationMs int64         `json:"duration_ms"`
	BootId     string        `json:"bootId"`
}

// BuildDepsRestoreLine renders one line per completed dependency step. The
// golden cache cannot report its own hit rate — a hit needs the pod to land on
// a node already warm for its repo, which is a property of fleet churn.
func BuildDepsRestoreLine(source RestoreSource, cloneUrl string, durationMs int64, bootId string) string {
	hash := "unknown"
	if cloneUrl != "" {
		hash = repoCacheKey(cloneUrl)
	}
	b, err := json.Marshal(depsRestoreLine{
		Msg: depsRestoreMsg, Source: source, RepoHash: hash,
		DurationMs: durationMs, BootId: bootId,
	})
	if err != nil {
		return ""
	}
	return string(b)
}

func EmitDepsRestore(source RestoreSource, cloneUrl string, durationMs int64, bootId string) {
	if line := BuildDepsRestoreLine(source, cloneUrl, durationMs, bootId); line != "" {
		os.Stdout.WriteString(line + "\n")
	}
	// Same event, second channel. The stdout line stays byte-compatible with
	// the TS daemon and is what existing panels read; the metric is what
	// survives the log pipeline, which samples info-level lines at 1% and so
	// cannot be counted on at canary volume. No-op unless OTLP is configured.
	telemetry.RecordDepsRestore(context.Background(), string(source), durationMs)
}

// IsPackageManifest reports whether rel (relative to node_modules) is a real
// package manifest — its dir sits directly under a node_modules or a scope
// dir. Rejects fixture manifests shipped deep inside packages.
func IsPackageManifest(rel string) bool {
	d := strings.Split(filepath.ToSlash(rel), "/")
	d = d[:len(d)-1]
	n := len(d)
	if n == 0 {
		return false
	}
	if n >= 2 && strings.HasPrefix(d[n-2], "@") {
		return n == 2 || d[n-3] == "node_modules"
	}
	return n == 1 || d[n-2] == "node_modules"
}

// readInstalledDeps reads the flattened installed dependency set straight off
// disk — PM-agnostic, so npm/pnpm/yarn/bun all yield the same set without
// parsing four lockfile formats. Symlinks are not followed, which skips pnpm's
// top-level links while still finding its real dirs under .pnpm/.
func readInstalledDeps(nodeModulesDir string) []string {
	seen := map[string]bool{}
	var out []string
	filepath.WalkDir(nodeModulesDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if len(out) >= maxDeps {
			return filepath.SkipAll
		}
		if d.IsDir() || d.Name() != "package.json" {
			return nil
		}
		rel, err := filepath.Rel(nodeModulesDir, path)
		if err != nil || !IsPackageManifest(rel) {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		var manifest struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		}
		if json.Unmarshal(raw, &manifest) != nil || manifest.Name == "" || manifest.Version == "" {
			return nil
		}
		key := manifest.Name + "@" + manifest.Version
		if !seen[key] {
			seen[key] = true
			out = append(out, key)
		}
		return nil
	})
	return out
}

type depsLine struct {
	Msg             string `json:"msg"`
	Chunk           int    `json:"chunk"`
	Chunks          int    `json:"chunks"`
	DependencyCount int    `json:"dependencyCount"`
	Deps            string `json:"deps"`
	BootId          string `json:"bootId"`
	PackageManager  string `json:"packageManager"`
	RepoName        string `json:"repoName,omitempty"`
	Branch          string `json:"branch,omitempty"`
}

type DepMetricsInput struct {
	InstallRoot    string
	PackageManager string
	BootId         string
	RepoName       string
	Branch         string
}

func clipMeta(s string) string {
	if len(s) > maxMetaBytes {
		return s[:maxMetaBytes]
	}
	return s
}

// chunkByBytes greedily packs name@version strings so each rendered line stays
// under maxLineBytes. Both simpler shapes fail in the pipeline: one line with
// the whole array is truncated at 16KB, one line per dep gets ~99% rate-sampled
// away.
func chunkByBytes(flat []string, envelopeBytes int) [][]string {
	var groups [][]string
	var cur []string
	bytes := envelopeBytes + 2
	for _, dep := range flat {
		entry := len(dep) + 5 // \"…\" (4) + comma (1)
		if len(cur) > 0 && bytes+entry > maxLineBytes {
			groups = append(groups, cur)
			cur = nil
			bytes = envelopeBytes + 2
		}
		cur = append(cur, dep)
		bytes += entry
	}
	if len(cur) > 0 {
		groups = append(groups, cur)
	}
	return groups
}

// BuildDepLines renders the installed dependency set for pre-bake analysis.
// `deps` is a pre-encoded JSON string, not a real array, so no pipeline stage
// can flatten it; VictoriaLogs `unroll (deps)` parses it back.
func BuildDepLines(flat []string, in DepMetricsInput) []string {
	repoName, branch := clipMeta(in.RepoName), clipMeta(in.Branch)
	envelope, _ := json.Marshal(depsLine{
		Msg: depsMsg, Chunk: 999, Chunks: 999, DependencyCount: len(flat),
		Deps: "", BootId: in.BootId, PackageManager: in.PackageManager,
		RepoName: repoName, Branch: branch,
	})
	groups := chunkByBytes(flat, len(envelope))
	if len(groups) == 0 {
		groups = [][]string{{}} // a zero-dep install still emits one countable line
	}
	lines := make([]string, 0, len(groups))
	for i, group := range groups {
		if group == nil {
			group = []string{}
		}
		encoded, _ := json.Marshal(group)
		b, err := json.Marshal(depsLine{
			Msg: depsMsg, Chunk: i + 1, Chunks: len(groups), DependencyCount: len(flat),
			Deps: string(encoded), BootId: in.BootId, PackageManager: in.PackageManager,
			RepoName: repoName, Branch: branch,
		})
		if err == nil {
			lines = append(lines, string(b))
		}
	}
	return lines
}

// EmitInstalledDeps walks node_modules and reports the dep set. Best-effort:
// telemetry must never break the install path.
func EmitInstalledDeps(in DepMetricsInput) {
	flat := readInstalledDeps(filepath.Join(in.InstallRoot, "node_modules"))
	var buf strings.Builder
	for _, line := range BuildDepLines(flat, in) {
		buf.WriteString(line)
		buf.WriteString("\n")
	}
	os.Stdout.WriteString(buf.String())
}
