// Package decofile owns the `.deco/blocks/*.json` domain on both sides:
//
//   - validation: the byte-level /write and /edit endpoints can produce invalid
//     JSON, and publish would commit those bytes verbatim onto the user's
//     branch, so a single malformed file — which breaks the entire site render —
//     must be rejected at write time (IsBlockPath, InvalidBlockJSON).
//   - generation: merging every block source into the `blocks.gen.json` artifact
//     the runtime emits (GenerateFromBlocksDeduped), so the CMS is readable
//     before the dev server has regenerated it.
package decofile

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Case-insensitive: on a case-insensitive filesystem `.deco/blocks/x.JSON`
// must not slip past the last-resort net in publish.
var blockRe = regexp.MustCompile(`(?i)(^|/)\.deco/blocks/.+\.json$`)

// IsBlockPath reports whether relPath points at a decofile block JSON file.
// Deliberately excludes JSONC configs and the multi-MB `.deco/*.gen.json`.
func IsBlockPath(relPath string) bool {
	return blockRe.MatchString(strings.ReplaceAll(relPath, `\`, "/"))
}

// InvalidBlockJSON returns an error string when content for a decofile block
// path is not valid JSON, and "" when the path is out of scope or well-formed.
func InvalidBlockJSON(relPath, content string) string {
	normalized := strings.ReplaceAll(relPath, `\`, "/")
	if !IsBlockPath(normalized) {
		return ""
	}
	var v any
	if err := json.Unmarshal([]byte(content), &v); err != nil {
		return fmt.Sprintf("invalid JSON in decofile block %q: %s", normalized, err.Error())
	}
	return ""
}
