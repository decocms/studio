// Package decofile guards `.deco/blocks/*.json` — machine-managed pure JSON
// where a single malformed file breaks the entire site render. The byte-level
// /write and /edit endpoints can produce invalid JSON, and publish would commit
// those bytes verbatim onto the user's branch.
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
