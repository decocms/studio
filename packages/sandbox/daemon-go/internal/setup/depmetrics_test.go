package setup

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBuildDepsRestoreLineShape(t *testing.T) {
	line := BuildDepsRestoreLine(RestoreMiss, "https://u:p@github.com/o/r.git", 1234, "boot-1")
	// Field order must match the TS emitter so the stored lines look identical.
	if !strings.HasPrefix(line, `{"msg":"sandbox.deps.restore","source":"miss","repo_hash":"`) {
		t.Fatalf("unexpected prefix: %s", line)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(line), &got); err != nil {
		t.Fatal(err)
	}
	if got["duration_ms"] != float64(1234) || got["bootId"] != "boot-1" {
		t.Fatalf("got %v", got)
	}
	// Credentials are stripped before hashing, never emitted.
	if strings.Contains(line, "u:p") || strings.Contains(line, "github.com") {
		t.Fatalf("line leaked the clone URL: %s", line)
	}
	hash, _ := got["repo_hash"].(string)
	if len(hash) != 16 {
		t.Fatalf("repo_hash = %q, want 16 hex chars", hash)
	}
	// The same repo with and without credentials must hash identically.
	bare := BuildDepsRestoreLine(RestoreMiss, "https://github.com/o/r.git", 1, "b")
	var bareGot map[string]any
	json.Unmarshal([]byte(bare), &bareGot)
	if bareGot["repo_hash"] != hash {
		t.Fatalf("credential stripping changed the hash: %v vs %v", bareGot["repo_hash"], hash)
	}
}

func TestBuildDepsRestoreLineUnknownRepo(t *testing.T) {
	line := BuildDepsRestoreLine(RestoreNoInstall, "", 0, "b")
	if !strings.Contains(line, `"repo_hash":"unknown"`) {
		t.Fatalf("got %s", line)
	}
}

func TestIsPackageManifest(t *testing.T) {
	cases := map[string]bool{
		"pkg/package.json":                            true,
		"@scope/pkg/package.json":                     true,
		"pkg/node_modules/nested/package.json":        true,
		"@scope/pkg/node_modules/dep/package.json":    true,
		".pnpm/foo@1.0.0/node_modules/x/package.json": true,
		"pkg/fixtures/sample/package.json":            false,
		"pkg/dist/deep/nested/package.json":           false,
		"package.json":                                false,
	}
	for rel, want := range cases {
		if got := IsPackageManifest(rel); got != want {
			t.Errorf("IsPackageManifest(%q) = %v, want %v", rel, got, want)
		}
	}
}

// Both simpler shapes fail in the log pipeline: one line with the whole array
// is truncated at 16KB, one line per dep gets rate-sampled away.
func TestBuildDepLinesStayUnderByteCap(t *testing.T) {
	flat := make([]string, 400)
	for i := range flat {
		flat[i] = "@scope/some-reasonably-long-package-name-" + string(rune('a'+i%26)) + "@1.2.3"
	}
	lines := BuildDepLines(flat, DepMetricsInput{
		PackageManager: "npm", BootId: "boot-1",
		RepoName: strings.Repeat("r", 200), Branch: strings.Repeat("b", 200),
	})
	if len(lines) < 2 {
		t.Fatalf("expected chunking, got %d line(s)", len(lines))
	}
	seen := 0
	for i, line := range lines {
		if len(line) > maxLineBytes {
			t.Errorf("line %d is %d bytes, over the %d cap", i, len(line), maxLineBytes)
		}
		var parsed struct {
			Chunk, Chunks, DependencyCount int
			Deps                           string
			RepoName, Branch               string
		}
		if err := json.Unmarshal([]byte(line), &parsed); err != nil {
			t.Fatal(err)
		}
		if parsed.Chunks != len(lines) || parsed.Chunk != i+1 {
			t.Errorf("line %d: chunk %d/%d", i, parsed.Chunk, parsed.Chunks)
		}
		if parsed.DependencyCount != len(flat) {
			t.Errorf("dependencyCount = %d, want %d", parsed.DependencyCount, len(flat))
		}
		// Long meta must be clipped, or a single-dep line blows the cap.
		if len(parsed.RepoName) > maxMetaBytes || len(parsed.Branch) > maxMetaBytes {
			t.Errorf("meta not clipped: repo=%d branch=%d", len(parsed.RepoName), len(parsed.Branch))
		}
		// `deps` is a pre-encoded JSON string, not a real array.
		var group []string
		if err := json.Unmarshal([]byte(parsed.Deps), &group); err != nil {
			t.Fatalf("deps is not a JSON-encoded array: %v", err)
		}
		seen += len(group)
	}
	if seen != len(flat) {
		t.Fatalf("chunking lost deps: %d of %d", seen, len(flat))
	}
}

// A zero-dep install still has to emit one countable line, or the denominator
// is unknowable.
func TestBuildDepLinesEmitsForZeroDeps(t *testing.T) {
	lines := BuildDepLines(nil, DepMetricsInput{PackageManager: "npm", BootId: "b"})
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1", len(lines))
	}
	if !strings.Contains(lines[0], `"dependencyCount":0`) || !strings.Contains(lines[0], `"deps":"[]"`) {
		t.Fatalf("got %s", lines[0])
	}
}
