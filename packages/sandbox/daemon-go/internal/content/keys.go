package content

// The one file-name rule for saved blocks, ported from
// `@decocms/blocks/protocol/keys` (keys.ts):
//
//   - name to file: encodeURIComponent(name) + ".json", directly in .deco/blocks;
//   - file to name: the stem decoded exactly once (the raw stem when that fails);
//   - spellings of one name (files that decode to the same name after repeated
//     decoding): the file whose entry has a `path` wins, then the one that took
//     more decoding, then the lowest file name;
//   - file content: JSON.stringify(entry, null, 2) + "\n".

import (
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	blockFileExtension = ".json"
	// MaxEncodedNameBytes keeps `<encoded>.json` under a 255-byte file name.
	MaxEncodedNameBytes = 250
)

var windowsDeviceNames = func() map[string]bool {
	m := map[string]bool{"CON": true, "PRN": true, "AUX": true, "NUL": true}
	for i := 1; i <= 9; i++ {
		m["COM"+string(rune('0'+i))] = true
		m["LPT"+string(rune('0'+i))] = true
	}
	return m
}()

var sourceExtensions = []string{".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}

// uriError is JS's URIError: thrown (panicked) by encodeURIComponent on a lone
// surrogate. Like any unexpected throw in the TS server, it surfaces as an
// Internal error (-32603) for the call.
type uriError struct{}

func isURIUnreserved(c byte) bool {
	return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' ||
		strings.IndexByte("-_.!~*'()", c) >= 0
}

const upperHex = "0123456789ABCDEF"

// encodeURIComponent is JS's encodeURIComponent; it panics with uriError on a
// lone surrogate, as JS throws.
func encodeURIComponent(s string) string {
	var sb strings.Builder
	for i := 0; i < len(s); {
		c := s[i]
		if c < 0x80 {
			if isURIUnreserved(c) {
				sb.WriteByte(c)
			} else {
				sb.WriteByte('%')
				sb.WriteByte(upperHex[c>>4])
				sb.WriteByte(upperHex[c&0xF])
			}
			i++
			continue
		}
		r, size := nextCodePoint(s, i)
		if (r >= 0xD800 && r <= 0xDFFF) || (r == utf8.RuneError && size == 1) {
			panic(uriError{})
		}
		for k := 0; k < size; k++ {
			b := s[i+k]
			sb.WriteByte('%')
			sb.WriteByte(upperHex[b>>4])
			sb.WriteByte(upperHex[b&0xF])
		}
		i += size
	}
	return sb.String()
}

// decodeURIComponent is JS's decodeURIComponent; ok is false where JS throws.
func decodeURIComponent(s string) (string, bool) {
	if strings.IndexByte(s, '%') < 0 {
		return s, true
	}
	var sb strings.Builder
	octet := func(i int) (byte, bool) {
		if i+2 >= len(s) || s[i] != '%' {
			return 0, false
		}
		h, l := hexVal(s[i+1]), hexVal(s[i+2])
		if h < 0 || l < 0 {
			return 0, false
		}
		return byte(h<<4 | l), true
	}
	for i := 0; i < len(s); {
		if s[i] != '%' {
			sb.WriteByte(s[i])
			i++
			continue
		}
		b, ok := octet(i)
		if !ok {
			return "", false
		}
		i += 3
		if b < 0x80 {
			sb.WriteByte(b)
			continue
		}
		n := 0
		for mask := byte(0x80); b&mask != 0 && n < 8; mask >>= 1 {
			n++
		}
		if n == 1 || n > 4 {
			return "", false
		}
		octets := []byte{b}
		for k := 1; k < n; k++ {
			c, ok := octet(i)
			if !ok || c&0xC0 != 0x80 {
				return "", false
			}
			octets = append(octets, c)
			i += 3
		}
		r, size := utf8.DecodeRune(octets)
		if size != n || (r == utf8.RuneError && size == 1) {
			return "", false
		}
		sb.Write(octets)
	}
	return sb.String(), true
}

// BlockFileName is the file a saved block named name is stored in.
func BlockFileName(name string) string {
	return encodeURIComponent(name) + blockFileExtension
}

// IsBlockFileName reports a saved-block file name: `.json`, a stem, no folder,
// not a dotfile.
func IsBlockFileName(file string) bool {
	return strings.HasSuffix(file, blockFileExtension) &&
		!strings.HasPrefix(file, ".") &&
		len(file) > len(blockFileExtension) &&
		!strings.Contains(file, "/") &&
		!strings.Contains(file, `\`)
}

func stem(file string) string {
	return strings.TrimSuffix(file, blockFileExtension)
}

// BlockNameFromFile is the entry name stored in file: the stem decoded once.
func BlockNameFromFile(file string) string {
	raw := stem(file)
	if name, ok := decodeURIComponent(raw); ok {
		return name
	}
	return raw
}

// FullyDecodeFileName decodes file's stem until it stops changing: the
// spelling-group key, and how many decodes it took.
func FullyDecodeFileName(file string) (string, int) {
	name := stem(file)
	passes := 0
	for strings.Contains(name, "%") {
		next, ok := decodeURIComponent(name)
		if !ok || next == name {
			break
		}
		name = next
		passes++
	}
	return name, passes
}

// SpellingKey is the spelling-group key of a saved-block name.
func SpellingKey(name string) string {
	key, _ := FullyDecodeFileName(BlockFileName(name))
	return key
}

// SerializeBlock is the bytes a saved block is stored as.
func SerializeBlock(entry any) string {
	return Stringify(entry, 2) + "\n"
}

// entryHasPath reports a page-like entry: a non-empty string `path`.
func entryHasPath(entry any) bool {
	o, ok := entry.(*Object)
	if !ok {
		return false
	}
	p, ok := o.Get("path")
	s, isString := p.(string)
	return ok && isString && len(s) > 0
}

// spellingCandidate is one file holding (a spelling of) a saved block.
type spellingCandidate struct {
	File    string
	Version string
	HasPath bool
	Value   *Object // nil when the body wasn't read
}

func compareSpellings(a, b *spellingCandidate) int {
	if a.HasPath != b.HasPath {
		if a.HasPath {
			return -1
		}
		return 1
	}
	_, passesA := FullyDecodeFileName(a.File)
	_, passesB := FullyDecodeFileName(b.File)
	if passesA != passesB {
		return passesB - passesA
	}
	return compareJS(a.File, b.File)
}

type resolvedSpelling struct {
	Name     string
	Winner   *spellingCandidate
	Shadowed []*spellingCandidate
}

// resolveSpellings groups candidates by spelling key and picks one winner per
// group, returned in file-name order of the winners.
func resolveSpellings(candidates []*spellingCandidate) []resolvedSpelling {
	var order []string
	groups := map[string][]*spellingCandidate{}
	for _, c := range candidates {
		key, _ := FullyDecodeFileName(c.File)
		if _, ok := groups[key]; !ok {
			order = append(order, key)
		}
		groups[key] = append(groups[key], c)
	}
	winners := make([]resolvedSpelling, 0, len(order))
	for _, key := range order {
		group := append([]*spellingCandidate(nil), groups[key]...)
		sort.SliceStable(group, func(i, j int) bool { return compareSpellings(group[i], group[j]) < 0 })
		winners = append(winners, resolvedSpelling{
			Name:     BlockNameFromFile(group[0].File),
			Winner:   group[0],
			Shadowed: group[1:],
		})
	}
	sort.SliceStable(winners, func(i, j int) bool {
		return compareJS(winners[i].Winner.File, winners[j].Winner.File) < 0
	})
	// A Map keyed by name: a later winner with the same name replaces the
	// earlier one in place (as `new Map(entries)` does).
	out := make([]resolvedSpelling, 0, len(winners))
	index := map[string]int{}
	for _, w := range winners {
		if i, ok := index[w.Name]; ok {
			out[i] = w
			continue
		}
		index[w.Name] = len(out)
		out = append(out, w)
	}
	return out
}

// NameViolation is a rule a name breaks.
type NameViolation struct {
	Reason  string
	Message string
}

// jsLower is String.prototype.toLowerCase, close enough: per-code-point
// lowercase that leaves lone surrogates alone, with U+0130's special mapping.
// OPEN: the context-sensitive final-sigma rule isn't ported.
func jsLower(s string) string {
	ascii := true
	for i := 0; i < len(s) && ascii; i++ {
		ascii = s[i] < 0x80
	}
	if ascii {
		return strings.ToLower(s)
	}
	var sb strings.Builder
	for i := 0; i < len(s); {
		r, size := nextCodePoint(s, i)
		switch {
		case r >= 0xD800 && r <= 0xDFFF, r == utf8.RuneError && size == 1:
			sb.WriteString(s[i : i+size])
		case r == 0x130:
			sb.WriteString("i̇")
		default:
			sb.WriteRune(unicode.ToLower(r))
		}
		i += size
	}
	return sb.String()
}

// checkBlockName reports every rule a name to save breaks. existing, when
// non-nil, refuses a new name differing from an existing one only in case.
func checkBlockName(name string, existing []string) []NameViolation {
	if name == "" {
		return []NameViolation{{"empty", "the name is empty"}}
	}
	var out []NameViolation
	if strings.Contains(name, `\`) || strings.Contains(name, "\x00") {
		out = append(out, NameViolation{"invalid-character", "the name contains a backslash or a NUL character"})
	}
	if strings.Contains(name, "..") {
		out = append(out, NameViolation{"dot-dot", `the name contains ".."`})
	}
	if strings.HasPrefix(name, ".") {
		out = append(out, NameViolation{"leading-dot", `the name starts with ".", which would make its file hidden`})
	}
	if name == "__proto__" {
		out = append(out, NameViolation{"reserved", `the name "__proto__" is reserved`})
	}
	encoded := encodeURIComponent(name)
	if len(encoded) > MaxEncodedNameBytes {
		out = append(out, NameViolation{"too-long", "the encoded name is over 250 bytes"})
	}
	deviceStem := strings.ToUpper(strings.SplitN(encoded, ".", 2)[0])
	if windowsDeviceNames[deviceStem] {
		out = append(out, NameViolation{"device-name", `"` + deviceStem + `" is a Windows device name`})
	}
	lower := jsLower(name)
	for _, ext := range sourceExtensions {
		if strings.HasSuffix(lower, ext) {
			out = append(out, NameViolation{"source-extension", `the name ends in "` + ext + `", which would shadow a source module`})
			break
		}
	}
	if existing != nil {
		isNew := true
		collidesWith := ""
		found := false
		for _, e := range existing {
			if e == name {
				isNew = false
				break
			}
			if !found && jsLower(e) == lower {
				collidesWith, found = e, true
			}
		}
		if isNew && found {
			out = append(out, NameViolation{"case-collision", `the name differs from the existing entry "` + collidesWith + `" only in letter case`})
		}
	}
	return out
}

// checkDeletedName: anything non-empty can be deleted.
func checkDeletedName(name string) []NameViolation {
	if name == "" {
		return []NameViolation{{"empty", "the name is empty"}}
	}
	return nil
}
