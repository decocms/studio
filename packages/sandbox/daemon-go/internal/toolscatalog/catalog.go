// Package toolscatalog materializes an org's Virtual MCP tool catalog onto the
// sandbox filesystem so an agent can discover and script against tools from
// disk. One raw JSON Schema file per tool under `<repo>/.deco/tools/` —
// deliberately no TypeScript codegen (agents wanting a typed client run
// `@decocms/typegen` themselves).
package toolscatalog

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/decocms/studio/sandbox-daemon/internal/gitx"
	"github.com/decocms/studio/sandbox-daemon/internal/paths"
)

// CatalogDir is where the catalog lands, relative to the repo root.
const CatalogDir = ".deco/tools"

// EndpointFilename holds the run's pre-authenticated MCP endpoint, written next
// to the catalog. A dotfile so `ls`-style browsing shows only tool schemas, and
// so the catalog prune (which targets non-dot `*.json`) never deletes it.
const EndpointFilename = ".endpoint.json"

// Endpoint is the run's pre-authenticated MCP endpoint.
type Endpoint struct {
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	// ExpiresAt is epoch ms when the endpoint's credential expires.
	ExpiresAt int64 `json:"expiresAt,omitempty"`
}

// Tool is one entry of the endpoint's tool listing.
type Tool struct {
	Name         string          `json:"name"`
	Description  string          `json:"description,omitempty"`
	InputSchema  json.RawMessage `json:"inputSchema,omitempty"`
	OutputSchema json.RawMessage `json:"outputSchema,omitempty"`
}

// File is one catalog entry, ready to write.
type File struct {
	Filename string
	Content  []byte
}

// catalogEntry is the on-disk shape of a `<TOOL>.json` catalog file. Field
// order is the emitted key order.
type catalogEntry struct {
	Name         string          `json:"name"`
	Description  string          `json:"description,omitempty"`
	InputSchema  json.RawMessage `json:"inputSchema"`
	OutputSchema json.RawMessage `json:"outputSchema,omitempty"`
}

type Opts struct {
	AppRoot string
	RepoDir string
}

var unsafeFilenameChars = regexp.MustCompile(`[^A-Za-z0-9_.-]`)

// CatalogFiles renders one `<TOOL>.json` per tool holding
// `{ name, description?, inputSchema, outputSchema? }`. Pure — the caller writes
// them. Filenames are sanitized; names that collide after sanitizing get a
// `-2`, `-3`… suffix so no tool is silently dropped.
func CatalogFiles(tools []Tool) ([]File, error) {
	used := map[string]bool{}
	out := make([]File, 0, len(tools))
	for _, tool := range tools {
		body := catalogEntry{
			Name:         tool.Name,
			Description:  tool.Description,
			InputSchema:  tool.InputSchema,
			OutputSchema: tool.OutputSchema,
		}
		if len(body.InputSchema) == 0 {
			body.InputSchema = json.RawMessage(`{"type":"object"}`)
		}
		content, err := json.MarshalIndent(body, "", "  ")
		if err != nil {
			return nil, err
		}
		base := unsafeFilenameChars.ReplaceAllString(tool.Name, "_")
		if base == "" {
			base = "tool"
		}
		filename := base + ".json"
		for i := 2; used[filename]; i++ {
			filename = fmt.Sprintf("%s-%d.json", base, i)
		}
		used[filename] = true
		out = append(out, File{Filename: filename, Content: append(content, '\n')})
	}
	return out, nil
}

// WriteCatalog writes the catalog under `<repoDir>/.deco/tools/` (clamped to
// AppRoot), prunes stale `*.json` from a previous sync, and excludes the dir so
// the shutdown `git add -A` never commits it. Returns the tool names written.
func WriteCatalog(tools []Tool, opts Opts) (count int, names []string, err error) {
	files, err := CatalogFiles(tools)
	if err != nil {
		return 0, nil, err
	}
	dir, ok := paths.SafePath(opts.AppRoot, opts.RepoDir, CatalogDir)
	if !ok {
		return 0, []string{}, nil // escapes the workspace root
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return 0, nil, err
	}
	gitx.EnsureExclude(opts.RepoDir, "/"+CatalogDir+"/")

	keep := map[string]bool{}
	names = []string{}
	for i, file := range files {
		target, ok := paths.SafePath(opts.AppRoot, opts.RepoDir, CatalogDir+"/"+file.Filename)
		if !ok {
			continue // escapes the workspace root — skip
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return 0, nil, err
		}
		if err := os.WriteFile(target, file.Content, 0o644); err != nil {
			return 0, nil, err
		}
		keep[file.Filename] = true
		names = append(names, tools[i].Name)
	}

	// Prune files from a previous sync that this one didn't write, so a
	// renamed/removed tool doesn't linger as a stale catalog entry. Dotfiles
	// (the endpoint file) are not catalog entries — never prune them.
	entries, readErr := os.ReadDir(dir)
	if readErr == nil {
		for _, e := range entries {
			name := e.Name()
			if strings.HasSuffix(name, ".json") && !strings.HasPrefix(name, ".") && !keep[name] {
				os.Remove(filepath.Join(dir, name))
			}
		}
	}
	return len(names), names, nil
}

// WriteEndpointFile writes the run's MCP endpoint to
// `<repoDir>/.deco/tools/.endpoint.json` so in-workspace scripts and the typegen
// CLI can call tools without flags or env. 0600 — it holds a bearer credential.
func WriteEndpointFile(ep Endpoint, opts Opts) (bool, error) {
	target, ok := paths.SafePath(opts.AppRoot, opts.RepoDir, CatalogDir+"/"+EndpointFilename)
	if !ok {
		return false, nil // escapes the workspace root
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return false, err
	}
	gitx.EnsureExclude(opts.RepoDir, "/"+CatalogDir+"/")
	if ep.Headers == nil {
		ep.Headers = map[string]string{}
	}
	content, err := json.MarshalIndent(ep, "", "  ")
	if err != nil {
		return false, err
	}
	if err := os.WriteFile(target, append(content, '\n'), 0o600); err != nil {
		return false, err
	}
	return true, nil
}
