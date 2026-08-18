package routes

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/decofile"
	"github.com/decocms/studio/sandbox-daemon/internal/httpx"
	"github.com/decocms/studio/sandbox-daemon/internal/paths"
	"github.com/decocms/studio/sandbox-daemon/internal/urlallow"
)

const (
	maxImageBytes    = 5 * 1024 * 1024
	maxTransferBytes = 500 * 1024 * 1024
	transferDeadline = 5 * time.Minute
)

type FsDeps struct {
	AppRoot            string
	RepoDir            string
	OnWorkingTreeWrite func(path string)
	// AllowedHosts gates /write_from_url and /upload_to_url. Boot env, never
	// the request body. Empty denies every transfer.
	AllowedHosts     []string
	AllowSameHostDev bool
}

func (d FsDeps) notifyWrite(path string) {
	if d.OnWorkingTreeWrite != nil {
		d.OnWorkingTreeWrite(path)
	}
}

// decodeBody caps the request body at maxTransferBytes: without a limit, a
// misbehaving or malicious caller could stream an unbounded body into memory
// and crash the daemon, tearing down the sandbox pod on the next missed
// health probe. The cap matches the daemon's other file-transfer bound.
func decodeBody(r *http.Request, out any) error {
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxTransferBytes+1))
	if err != nil {
		return fmt.Errorf("Failed to parse body: %s", err.Error())
	}
	if len(raw) > maxTransferBytes {
		return fmt.Errorf("Request body exceeded %d bytes", maxTransferBytes)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("Failed to parse body: %s", err.Error())
	}
	return nil
}

func resolveReadPath(appRoot, repoDir, userPath string) (string, bool) {
	if filepath.IsAbs(userPath) {
		return userPath, true
	}
	return paths.SafePath(appRoot, repoDir, userPath)
}

// sniffImageMediaType reports the media type only for the formats /read is
// willing to return inline; anything else reads as text or binary.
func sniffImageMediaType(probe []byte) string {
	mediaType, _, _ := strings.Cut(http.DetectContentType(probe), ";")
	switch mediaType {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return mediaType
	}
	return ""
}

func Read(deps FsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path   string `json:"path"`
			Offset int    `json:"offset"`
			Limit  int    `json:"limit"`
			Full   bool   `json:"full"`
		}
		if err := decodeBody(r, &body); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		filePath, ok := resolveReadPath(deps.AppRoot, deps.RepoDir, body.Path)
		if !ok {
			httpx.Error(w, 400, "Path escapes project root")
			return
		}
		stat, err := os.Stat(filePath)
		if err != nil {
			// Decofile fallback: `.deco/blocks.gen.json` is commonly gitignored
			// (a multi-MB single line the runtime regenerates on dev cold-start),
			// so a fresh sandbox has the block sources but not the merged file.
			// Rebuild it on the fly from the sibling `.deco/blocks/*.json` so the
			// CMS is readable before the dev server boots. Returned un-numbered:
			// the decofile is consumed as one blob and the client's line-number
			// strip is a no-op on content that lacks the `^\d+\t` prefix.
			//
			// Only for relative paths: those are SafePath-confined to appRoot by
			// resolveReadPath, so the sibling `blocks` dir can't escape the
			// project. An absolute `body.Path` bypasses SafePath, so refuse to
			// turn it into a directory glob (the CMS only ever sends relative).
			if !filepath.IsAbs(body.Path) && filepath.Base(filePath) == decofile.GenBasename {
				blocksDir := filepath.Join(filepath.Dir(filePath), decofile.BlocksDirname)
				if merged, ok := decofile.GenerateFromBlocksDeduped(blocksDir); ok {
					httpx.JSON(w, 200, map[string]any{
						"kind":      "text",
						"content":   merged,
						"lineCount": 1,
					})
					return
				}
			}
			httpx.Error(w, 400, fmt.Sprintf("File not found: %s", body.Path))
			return
		}
		if stat.IsDir() {
			httpx.Error(w, 400, "Path is a directory")
			return
		}
		f, err := os.Open(filePath)
		if err != nil {
			httpx.Error(w, 400, fmt.Sprintf("File not found: %s", body.Path))
			return
		}
		probeSize := stat.Size()
		if probeSize > 8192 {
			probeSize = 8192
		}
		probe := make([]byte, probeSize)
		io.ReadFull(f, probe)
		f.Close()

		if mediaType := sniffImageMediaType(probe); mediaType != "" {
			if stat.Size() > maxImageBytes {
				httpx.Error(w, 400, fmt.Sprintf("Image too large (%d bytes; cap is %d)", stat.Size(), maxImageBytes))
				return
			}
			raw, err := os.ReadFile(filePath)
			if err != nil {
				httpx.Error(w, 500, err.Error())
				return
			}
			httpx.JSON(w, 200, map[string]any{
				"kind":      "image",
				"mediaType": mediaType,
				"size":      stat.Size(),
				"base64":    base64.StdEncoding.EncodeToString(raw),
			})
			return
		}

		if bytes.IndexByte(probe, 0) >= 0 {
			httpx.Error(w, 400, "File appears to be binary and is not a supported image format (jpeg/png/gif/webp).")
			return
		}

		raw, err := os.ReadFile(filePath)
		if err != nil {
			httpx.Error(w, 500, err.Error())
			return
		}
		lines := strings.Split(string(raw), "\n")
		offset := 1
		if !body.Full && body.Offset > 1 {
			offset = body.Offset
		}
		limit := 2000
		if body.Full {
			limit = len(lines)
		} else if body.Limit > 0 {
			limit = body.Limit
		}
		start := offset - 1
		if start > len(lines) {
			start = len(lines)
		}
		end := start + limit
		if end > len(lines) {
			end = len(lines)
		}
		var b strings.Builder
		for i := start; i < end; i++ {
			if i > start {
				b.WriteByte('\n')
			}
			fmt.Fprintf(&b, "%d\t%s", offset+(i-start), lines[i])
		}
		httpx.JSON(w, 200, map[string]any{
			"kind":      "text",
			"content":   b.String(),
			"lineCount": len(lines),
		})
	}
}

func Write(deps FsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path    string  `json:"path"`
			Content *string `json:"content"`
		}
		if err := decodeBody(r, &body); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		if body.Content == nil {
			httpx.Error(w, 400, "content is required")
			return
		}
		filePath, ok := paths.SafePath(deps.AppRoot, deps.RepoDir, body.Path)
		if !ok {
			httpx.Error(w, 400, "Path escapes app root")
			return
		}
		if jsonErr := decofile.InvalidBlockJSON(body.Path, *body.Content); jsonErr != "" {
			httpx.Error(w, 400, "Refusing to write "+jsonErr)
			return
		}
		if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
			httpx.Error(w, 500, err.Error())
			return
		}
		if err := os.WriteFile(filePath, []byte(*body.Content), 0o644); err != nil {
			httpx.Error(w, 500, err.Error())
			return
		}
		deps.notifyWrite(body.Path)
		httpx.JSON(w, 200, map[string]any{"ok": true, "bytesWritten": len(*body.Content)})
	}
}

func assertUnlinkAllowed(normalized string, recursive bool) string {
	if normalized == "" || strings.Contains(normalized, "..") {
		return "Invalid path"
	}
	if recursive && (normalized == "." || normalized == "") {
		return "Refusing to recursively delete the repository root"
	}
	for _, seg := range strings.Split(normalized, "/") {
		if seg == ".git" {
			return "Refusing to delete .git"
		}
	}
	return ""
}

func Unlink(deps FsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path      string `json:"path"`
			Recursive bool   `json:"recursive"`
		}
		if err := decodeBody(r, &body); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		if body.Path == "" {
			httpx.Error(w, 400, "path is required")
			return
		}
		normalized := strings.ReplaceAll(body.Path, "\\", "/")
		if reason := assertUnlinkAllowed(normalized, body.Recursive); reason != "" {
			httpx.Error(w, 400, reason)
			return
		}
		filePath, ok := paths.SafePath(deps.AppRoot, deps.RepoDir, body.Path)
		if !ok {
			httpx.Error(w, 400, "Path escapes app root")
			return
		}
		existed := true
		stat, err := os.Stat(filePath)
		if err != nil {
			if os.IsNotExist(err) {
				existed = false
			} else {
				httpx.Error(w, 500, err.Error())
				return
			}
		} else if stat.IsDir() {
			if !body.Recursive {
				httpx.Error(w, 400, "Refusing to unlink directory without recursive: true")
				return
			}
			if err := os.RemoveAll(filePath); err != nil {
				httpx.Error(w, 500, err.Error())
				return
			}
		} else if err := os.Remove(filePath); err != nil {
			if os.IsNotExist(err) {
				existed = false
			} else {
				httpx.Error(w, 500, err.Error())
				return
			}
		}
		if existed {
			deps.notifyWrite(body.Path)
		}
		httpx.JSON(w, 200, map[string]any{"ok": true, "existed": existed})
	}
}

func Mkdir(deps FsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
		}
		if err := decodeBody(r, &body); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		if body.Path == "" {
			httpx.Error(w, 400, "path is required")
			return
		}
		normalized := strings.ReplaceAll(body.Path, "\\", "/")
		if normalized == "" || strings.Contains(normalized, "..") {
			httpx.Error(w, 400, "Invalid path")
			return
		}
		dirPath, ok := paths.SafePath(deps.AppRoot, deps.RepoDir, body.Path)
		if !ok {
			httpx.Error(w, 400, "Path escapes app root")
			return
		}
		if err := os.MkdirAll(dirPath, 0o755); err != nil {
			httpx.Error(w, 500, err.Error())
			return
		}
		deps.notifyWrite(body.Path)
		httpx.JSON(w, 200, map[string]any{"ok": true})
	}
}

func Rename(deps FsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			From string `json:"from"`
			To   string `json:"to"`
		}
		if err := decodeBody(r, &body); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		if body.From == "" {
			httpx.Error(w, 400, "from is required")
			return
		}
		if body.To == "" {
			httpx.Error(w, 400, "to is required")
			return
		}
		fromNorm := strings.ReplaceAll(body.From, "\\", "/")
		toNorm := strings.ReplaceAll(body.To, "\\", "/")
		if fromNorm == "" || toNorm == "" || strings.Contains(fromNorm, "..") || strings.Contains(toNorm, "..") {
			httpx.Error(w, 400, "Invalid path")
			return
		}
		fromPath, okFrom := paths.SafePath(deps.AppRoot, deps.RepoDir, body.From)
		toPath, okTo := paths.SafePath(deps.AppRoot, deps.RepoDir, body.To)
		if !okFrom || !okTo {
			httpx.Error(w, 400, "Path escapes app root")
			return
		}
		if _, err := os.Stat(fromPath); err != nil {
			httpx.Error(w, 400, fmt.Sprintf("Path not found: %s", body.From))
			return
		}
		if _, err := os.Stat(toPath); err == nil {
			httpx.Error(w, 400, fmt.Sprintf("Path already exists: %s", body.To))
			return
		} else if !os.IsNotExist(err) {
			httpx.Error(w, 500, err.Error())
			return
		}
		if err := os.MkdirAll(filepath.Dir(toPath), 0o755); err != nil {
			httpx.Error(w, 500, err.Error())
			return
		}
		if err := os.Rename(fromPath, toPath); err != nil {
			httpx.Error(w, 500, err.Error())
			return
		}
		deps.notifyWrite(body.To)
		httpx.JSON(w, 200, map[string]any{"ok": true})
	}
}

func Edit(deps FsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path       string  `json:"path"`
			OldString  string  `json:"old_string"`
			NewString  *string `json:"new_string"`
			ReplaceAll bool    `json:"replace_all"`
		}
		if err := decodeBody(r, &body); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		filePath, ok := paths.SafePath(deps.AppRoot, deps.RepoDir, body.Path)
		if !ok {
			httpx.Error(w, 400, "Path escapes app root")
			return
		}
		if body.OldString == "" {
			httpx.Error(w, 400, "old_string is required")
			return
		}
		if body.NewString == nil {
			httpx.Error(w, 400, "new_string is required")
			return
		}
		if body.OldString == *body.NewString {
			httpx.Error(w, 400, "old_string and new_string must differ")
			return
		}
		raw, err := os.ReadFile(filePath)
		if err != nil {
			httpx.Error(w, 400, fmt.Sprintf("File not found: %s", body.Path))
			return
		}
		content := string(raw)
		count := strings.Count(content, body.OldString)
		if count == 0 {
			httpx.Error(w, 400, "old_string not found in file")
			return
		}
		if !body.ReplaceAll && count > 1 {
			httpx.Error(w, 400, fmt.Sprintf("old_string found %d times. Use replace_all or provide more context to make it unique.", count))
			return
		}
		var updated string
		replacements := 1
		if body.ReplaceAll {
			updated = strings.ReplaceAll(content, body.OldString, *body.NewString)
			replacements = count
		} else {
			updated = strings.Replace(content, body.OldString, *body.NewString, 1)
		}
		if jsonErr := decofile.InvalidBlockJSON(body.Path, updated); jsonErr != "" {
			httpx.Error(w, 400, "Refusing to write "+jsonErr)
			return
		}
		if err := os.WriteFile(filePath, []byte(updated), 0o644); err != nil {
			httpx.Error(w, 500, err.Error())
			return
		}
		deps.notifyWrite(body.Path)
		httpx.JSON(w, 200, map[string]any{"ok": true, "replacements": replacements, "content": updated})
	}
}

func Grep(deps FsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Pattern    string `json:"pattern"`
			Path       string `json:"path"`
			OutputMode string `json:"output_mode"`
			IgnoreCase bool   `json:"ignore_case"`
			Context    int    `json:"context"`
			Glob       string `json:"glob"`
			Limit      int    `json:"limit"`
		}
		if err := decodeBody(r, &body); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		if body.Pattern == "" {
			httpx.Error(w, 400, "pattern is required")
			return
		}
		searchPath := deps.RepoDir
		if body.Path != "" {
			resolved, ok := paths.SafePath(deps.AppRoot, deps.RepoDir, body.Path)
			if !ok {
				httpx.Error(w, 400, "Path escapes app root")
				return
			}
			searchPath = resolved
		}
		var args []string
		mode := body.OutputMode
		switch mode {
		case "count":
			args = append(args, "--count")
		case "content":
			args = append(args, "--line-number")
		default:
			mode = "files"
			args = append(args, "--files-with-matches")
		}
		if body.IgnoreCase {
			args = append(args, "-i")
		}
		if body.Context > 0 && mode == "content" {
			args = append(args, "-C", fmt.Sprintf("%d", body.Context))
		}
		if body.Glob != "" {
			args = append(args, "--glob", body.Glob)
		}
		args = append(args, "--", body.Pattern, searchPath)

		limit := 250
		if body.Limit > 0 {
			limit = body.Limit
		}

		cmd := exec.Command("rg", args...)
		cmd.Dir = deps.RepoDir
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			httpx.Error(w, 500, err.Error())
			return
		}
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Start(); err != nil {
			httpx.Error(w, 500, fmt.Sprintf(`grep unavailable: %s. Install ripgrep ("brew install ripgrep") or use bash + grep.`, err.Error()))
			return
		}
		var lines []string
		truncated := false
		reader := bufioScanner(stdout)
		for reader.Scan() {
			line := reader.Text()
			if line == "" {
				continue
			}
			if len(lines) >= limit {
				truncated = true
				cmd.Process.Kill()
				break
			}
			lines = append(lines, line)
		}
		err = cmd.Wait()
		code := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				code = exitErr.ExitCode()
			} else {
				code = -1
			}
		}
		if code > 1 && !truncated {
			msg := stderr.String()
			if msg == "" {
				msg = fmt.Sprintf("rg failed with code %d", code)
			}
			httpx.Error(w, 500, msg)
			return
		}
		httpx.JSON(w, 200, map[string]any{
			"results":    strings.Join(lines, "\n"),
			"matchCount": len(lines),
		})
	}
}

var globExcludeDirs = map[string]bool{
	"node_modules": true, ".git": true, ".next": true, "dist": true,
	"build": true, ".turbo": true, ".cache": true, ".ssh": true,
	".aws": true, ".gnupg": true,
}

const (
	globResultLimit    = 1000
	globMaxResultLimit = 10000
)

func isGlobPathAllowed(rel string) bool {
	for _, seg := range strings.Split(rel, "/") {
		if globExcludeDirs[seg] {
			return false
		}
	}
	return true
}

func globMatch(pattern, rel string) bool {
	return globMatchSegments(strings.Split(pattern, "/"), strings.Split(rel, "/"))
}

func globMatchSegments(pat, segs []string) bool {
	if len(pat) == 0 {
		return len(segs) == 0
	}
	if pat[0] == "**" {
		if globMatchSegments(pat[1:], segs) {
			return true
		}
		for i := range segs {
			if globMatchSegments(pat[1:], segs[i+1:]) {
				return true
			}
		}
		return false
	}
	if len(segs) == 0 {
		return false
	}
	ok, err := filepath.Match(pat[0], segs[0])
	if err != nil || !ok {
		return false
	}
	return globMatchSegments(pat[1:], segs[1:])
}

func pathSegmentDepth(rel string) int {
	n := 0
	for _, s := range strings.Split(rel, "/") {
		if s != "" {
			n++
		}
	}
	return n
}

func collectEmptyDirectories(filePaths []string, directoryPaths map[string]bool) []string {
	empty := []string{}
	for dir := range directoryPaths {
		if dir == "" {
			continue
		}
		prefix := dir + "/"
		hasNested := false
		for _, f := range filePaths {
			if strings.HasPrefix(f, prefix) {
				hasNested = true
				break
			}
		}
		if !hasNested {
			for other := range directoryPaths {
				if other != dir && strings.HasPrefix(other, prefix) {
					hasNested = true
					break
				}
			}
		}
		if !hasNested {
			empty = append(empty, dir)
		}
	}
	sort.Strings(empty)
	return empty
}

func Glob(deps FsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Pattern  string `json:"pattern"`
			Path     string `json:"path"`
			Limit    *int   `json:"limit"`
			MaxDepth *int   `json:"maxDepth"`
		}
		if err := decodeBody(r, &body); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		if body.Pattern == "" {
			httpx.Error(w, 400, "pattern is required")
			return
		}
		searchPath := deps.RepoDir
		if body.Path != "" {
			resolved, ok := paths.SafePath(deps.AppRoot, deps.RepoDir, body.Path)
			if !ok {
				httpx.Error(w, 400, "Path escapes app root")
				return
			}
			searchPath = resolved
		}
		resultLimit := globResultLimit
		if body.Limit != nil && *body.Limit >= 1 {
			resultLimit = *body.Limit
			if resultLimit > globMaxResultLimit {
				resultLimit = globMaxResultLimit
			}
		}
		maxDepth := 0
		if body.MaxDepth != nil && *body.MaxDepth >= 1 {
			maxDepth = *body.MaxDepth
		}

		prefix := ""
		if searchPath != deps.RepoDir {
			if rel, err := filepath.Rel(deps.RepoDir, searchPath); err == nil && !strings.HasPrefix(rel, "..") {
				prefix = filepath.ToSlash(rel)
			}
		}

		filePaths := []string{}
		directoryPaths := map[string]bool{}
		truncated := false

		var walk func(absDir, relDir string) bool
		walk = func(absDir, relDir string) bool {
			entries, err := os.ReadDir(absDir)
			if err != nil {
				return false
			}
			for _, entry := range entries {
				childRel := entry.Name()
				if relDir != "" {
					childRel = relDir + "/" + entry.Name()
				}
				if !isGlobPathAllowed(childRel) {
					continue
				}
				if entry.Type()&os.ModeSymlink != 0 {
					continue
				}
				repoRel := childRel
				if prefix != "" {
					repoRel = prefix + "/" + childRel
				}
				depth := pathSegmentDepth(repoRel)
				if entry.IsDir() {
					if maxDepth > 0 && depth > maxDepth {
						continue
					}
					if body.Pattern == "**/*" || globMatch(body.Pattern, childRel) {
						directoryPaths[repoRel] = true
					}
					if walk(filepath.Join(absDir, entry.Name()), childRel) {
						return true
					}
				} else {
					if maxDepth > 0 && depth > maxDepth {
						continue
					}
					if globMatch(body.Pattern, childRel) {
						filePaths = append(filePaths, repoRel)
						if len(filePaths) >= resultLimit {
							truncated = true
							return true
						}
					}
				}
			}
			return false
		}
		walk(searchPath, "")

		resp := map[string]any{
			"files":       filePaths,
			"directories": collectEmptyDirectories(filePaths, directoryPaths),
		}
		if truncated {
			resp["truncated"] = true
		}
		httpx.JSON(w, 200, resp)
	}
}

func WriteFromUrl(deps FsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
			URL  string `json:"url"`
		}
		if err := decodeBody(r, &body); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		if body.URL == "" {
			httpx.Error(w, 400, "url is required")
			return
		}
		filePath, ok := paths.SafePath(deps.AppRoot, deps.RepoDir, body.Path)
		if !ok {
			httpx.Error(w, 400, "Path escapes app root")
			return
		}
		if err := urlallow.Assert(body.URL, deps.AllowedHosts, deps.AllowSameHostDev); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		client := urlallow.Client(transferDeadline, deps.AllowedHosts, deps.AllowSameHostDev)
		resp, err := client.Get(body.URL)
		if err != nil {
			httpx.Error(w, 502, fmt.Sprintf("fetch failed: %s", err.Error()))
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			httpx.Error(w, 502, fmt.Sprintf("upstream returned HTTP %d", resp.StatusCode))
			return
		}
		if resp.ContentLength > maxTransferBytes {
			httpx.Error(w, 413, fmt.Sprintf("Payload too large (%d > %d)", resp.ContentLength, maxTransferBytes))
			return
		}
		if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
			httpx.Error(w, 500, err.Error())
			return
		}
		out, err := os.Create(filePath)
		if err != nil {
			httpx.Error(w, 500, err.Error())
			return
		}
		written, err := io.Copy(out, io.LimitReader(resp.Body, maxTransferBytes+1))
		out.Close()
		if err != nil || written > maxTransferBytes {
			os.Remove(filePath)
			msg := fmt.Sprintf("Stream exceeded %d bytes", maxTransferBytes)
			if err != nil {
				msg = err.Error()
			}
			httpx.Error(w, 502, fmt.Sprintf("stream failed: %s", msg))
			return
		}
		httpx.JSON(w, 200, map[string]any{"ok": true, "path": body.Path, "size": written})
	}
}

func UploadToUrl(deps FsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path        string `json:"path"`
			URL         string `json:"url"`
			ContentType string `json:"contentType"`
		}
		if err := decodeBody(r, &body); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		if body.URL == "" {
			httpx.Error(w, 400, "url is required")
			return
		}
		filePath, ok := resolveReadPath(deps.AppRoot, deps.RepoDir, body.Path)
		if !ok {
			httpx.Error(w, 400, "Path escapes project root")
			return
		}
		if err := urlallow.Assert(body.URL, deps.AllowedHosts, deps.AllowSameHostDev); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		stat, err := os.Stat(filePath)
		if err != nil {
			httpx.Error(w, 400, fmt.Sprintf("File not found: %s", body.Path))
			return
		}
		if stat.IsDir() {
			httpx.Error(w, 400, "Path is a directory")
			return
		}
		if stat.Size() > maxTransferBytes {
			httpx.Error(w, 413, fmt.Sprintf("File too large (%d > %d)", stat.Size(), maxTransferBytes))
			return
		}
		f, err := os.Open(filePath)
		if err != nil {
			httpx.Error(w, 500, err.Error())
			return
		}
		defer f.Close()
		req, err := http.NewRequest("PUT", body.URL, f)
		if err != nil {
			httpx.Error(w, 502, fmt.Sprintf("upload failed: %s", err.Error()))
			return
		}
		req.ContentLength = stat.Size()
		if body.ContentType != "" {
			req.Header.Set("Content-Type", body.ContentType)
		}
		client := urlallow.Client(transferDeadline, deps.AllowedHosts, deps.AllowSameHostDev)
		resp, err := client.Do(req)
		if err != nil {
			httpx.Error(w, 502, fmt.Sprintf("upload failed: %s", err.Error()))
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			errText, _ := io.ReadAll(io.LimitReader(resp.Body, 500))
			httpx.Error(w, 502, fmt.Sprintf("upstream returned HTTP %d: %s", resp.StatusCode, string(errText)))
			return
		}
		httpx.JSON(w, 200, map[string]any{"ok": true, "size": stat.Size()})
	}
}
