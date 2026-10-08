package content

// JavaScript's JSON, byte for byte.
//
// The reference server (`@decocms/blocks/protocol`, TypeScript) stores a block
// as `JSON.stringify(entry, null, 2) + "\n"` and answers with JSON.stringify'd
// bodies. `deco serve` on a laptop writes the same bytes, so a sandbox edit and
// a local edit of one entry must not differ by a single byte, or every save
// churns the git diff. encoding/json can't do that: it reorders nothing but
// loses JS property order (integer-like keys first), formats numbers its own
// way, escapes <, > and &, and has no room for the lone UTF-16 surrogates a
// JS string may hold.
//
// Values are: nil (null), bool, float64, string, []any and *Object. Strings are
// WTF-8: valid UTF-8, except that a lone surrogate from a `\udXXX` escape is
// kept as its 3-byte generalized encoding, so it round-trips the way it does
// in JS.

import (
	"strconv"
	"strings"
	"unicode/utf8"
)

// Object is a JS object: own string keys in property order.
type Object struct {
	keys []string
	vals map[string]any
}

// NewObject builds an object from alternating keys and values.
func NewObject(kv ...any) *Object {
	o := &Object{vals: map[string]any{}}
	for i := 0; i+1 < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

// arrayIndex reports whether key is a canonical array index (0 to 2^32-2):
// such keys come first, in ascending order, in every JS property listing.
func arrayIndex(key string) (uint64, bool) {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	var n uint64
	for i := 0; i < len(key); i++ {
		c := key[i]
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + uint64(c-'0')
	}
	return n, n <= 4294967294
}

// Set defines key: an existing key keeps its position, like a JS assignment.
func (o *Object) Set(key string, value any) {
	if o.vals == nil {
		o.vals = map[string]any{}
	}
	if _, ok := o.vals[key]; ok {
		o.vals[key] = value
		return
	}
	o.vals[key] = value
	if n, ok := arrayIndex(key); ok {
		i := 0
		for ; i < len(o.keys); i++ {
			m, isIndex := arrayIndex(o.keys[i])
			if !isIndex || m > n {
				break
			}
		}
		o.keys = append(o.keys, "")
		copy(o.keys[i+1:], o.keys[i:])
		o.keys[i] = key
		return
	}
	o.keys = append(o.keys, key)
}

// Get returns an own property.
func (o *Object) Get(key string) (any, bool) {
	if o == nil {
		return nil, false
	}
	v, ok := o.vals[key]
	return v, ok
}

// Has reports an own property.
func (o *Object) Has(key string) bool {
	_, ok := o.Get(key)
	return ok
}

// Keys returns the own keys in JS property order.
func (o *Object) Keys() []string {
	if o == nil {
		return nil
	}
	return o.keys
}

// Len is the number of own keys.
func (o *Object) Len() int {
	if o == nil {
		return 0
	}
	return len(o.keys)
}

// ---------------------------------------------------------------- decoding

// decodeUTF8 decodes bytes like the WHATWG TextDecoder: every maximal
// invalid subpart becomes one U+FFFD (fatal: an error instead), and a leading
// BOM is dropped when stripBOM is set (TextDecoder's default).
func decodeUTF8(b []byte, fatal, stripBOM bool) (string, bool) {
	if stripBOM && len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		b = b[3:]
	}
	if utf8.Valid(b) {
		return string(b), true
	}
	if fatal {
		return "", false
	}
	var sb strings.Builder
	sb.Grow(len(b))
	i := 0
	for i < len(b) {
		c := b[i]
		if c < 0x80 {
			sb.WriteByte(c)
			i++
			continue
		}
		need, lower, upper := 0, byte(0x80), byte(0xBF)
		switch {
		case c >= 0xC2 && c <= 0xDF:
			need = 1
		case c >= 0xE0 && c <= 0xEF:
			need = 2
			if c == 0xE0 {
				lower = 0xA0
			} else if c == 0xED {
				upper = 0x9F
			}
		case c >= 0xF0 && c <= 0xF4:
			need = 3
			if c == 0xF0 {
				lower = 0x90
			} else if c == 0xF4 {
				upper = 0x8F
			}
		default:
			sb.WriteRune(utf8.RuneError)
			i++
			continue
		}
		j := i + 1
		ok := true
		for k := 0; k < need; k++ {
			if j >= len(b) || b[j] < lower || b[j] > upper {
				ok = false
				break
			}
			lower, upper = 0x80, 0xBF
			j++
		}
		if !ok {
			sb.WriteRune(utf8.RuneError)
			i = j
			continue
		}
		sb.Write(b[i:j])
		i = j
	}
	return sb.String(), true
}

// maxParseDepth bounds nesting so a hostile body can't exhaust the stack.
// OPEN: JS parses any depth and only fails later (stringify's call stack); a
// body nested deeper than this is a parse error here.
const maxParseDepth = 10000

type parser struct {
	s     string
	i     int
	depth int
}

type parseError struct{ msg string }

func (e *parseError) Error() string { return e.msg }

// ParseJSON is JSON.parse over text.
func ParseJSON(text string) (any, error) {
	p := &parser{s: text}
	p.ws()
	v, err := p.value()
	if err != nil {
		return nil, err
	}
	p.ws()
	if p.i != len(p.s) {
		return nil, p.fail("Unexpected non-whitespace character after JSON")
	}
	return v, nil
}

func (p *parser) fail(msg string) error {
	return &parseError{msg: msg + " at position " + strconv.Itoa(p.i)}
}

func (p *parser) ws() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *parser) value() (any, error) {
	if p.i >= len(p.s) {
		return nil, p.fail("Unexpected end of JSON input")
	}
	switch c := p.s[p.i]; {
	case c == '{':
		return p.object()
	case c == '[':
		return p.array()
	case c == '"':
		return p.str()
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	case strings.HasPrefix(p.s[p.i:], "true"):
		p.i += 4
		return true, nil
	case strings.HasPrefix(p.s[p.i:], "false"):
		p.i += 5
		return false, nil
	case strings.HasPrefix(p.s[p.i:], "null"):
		p.i += 4
		return nil, nil
	}
	return nil, p.fail("Unexpected token")
}

func (p *parser) enter() error {
	p.depth++
	if p.depth > maxParseDepth {
		return p.fail("JSON nested too deeply")
	}
	return nil
}

func (p *parser) object() (any, error) {
	if err := p.enter(); err != nil {
		return nil, err
	}
	defer func() { p.depth-- }()
	p.i++ // {
	o := &Object{vals: map[string]any{}}
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == '}' {
		p.i++
		return o, nil
	}
	for {
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != '"' {
			return nil, p.fail("Expected property name")
		}
		k, err := p.str()
		if err != nil {
			return nil, err
		}
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != ':' {
			return nil, p.fail("Expected ':' after property name")
		}
		p.i++
		p.ws()
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		o.Set(k.(string), v)
		p.ws()
		if p.i >= len(p.s) {
			return nil, p.fail("Unexpected end of JSON input")
		}
		if p.s[p.i] == ',' {
			p.i++
			continue
		}
		if p.s[p.i] == '}' {
			p.i++
			return o, nil
		}
		return nil, p.fail("Expected ',' or '}' after property value")
	}
}

func (p *parser) array() (any, error) {
	if err := p.enter(); err != nil {
		return nil, err
	}
	defer func() { p.depth-- }()
	p.i++ // [
	out := []any{}
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == ']' {
		p.i++
		return out, nil
	}
	for {
		p.ws()
		v, err := p.value()
		if err != nil {
			return nil, err
		}
		out = append(out, v)
		p.ws()
		if p.i >= len(p.s) {
			return nil, p.fail("Unexpected end of JSON input")
		}
		if p.s[p.i] == ',' {
			p.i++
			continue
		}
		if p.s[p.i] == ']' {
			p.i++
			return out, nil
		}
		return nil, p.fail("Expected ',' or ']' after array element")
	}
}

func hexVal(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
}

func (p *parser) hex4() (rune, bool) {
	if p.i+4 > len(p.s) {
		return 0, false
	}
	var r rune
	for k := 0; k < 4; k++ {
		h := hexVal(p.s[p.i+k])
		if h < 0 {
			return 0, false
		}
		r = r<<4 | rune(h)
	}
	p.i += 4
	return r, true
}

// appendWTF8 appends a code point, surrogates included (generalized UTF-8).
func appendWTF8(sb *strings.Builder, r rune) {
	if r >= 0xD800 && r <= 0xDFFF {
		sb.WriteByte(byte(0xE0 | (r >> 12)))
		sb.WriteByte(byte(0x80 | ((r >> 6) & 0x3F)))
		sb.WriteByte(byte(0x80 | (r & 0x3F)))
		return
	}
	sb.WriteRune(r)
}

func (p *parser) str() (any, error) {
	p.i++ // "
	var sb strings.Builder
	start := p.i
	for {
		if p.i >= len(p.s) {
			return nil, p.fail("Unterminated string in JSON")
		}
		c := p.s[p.i]
		switch {
		case c == '"':
			sb.WriteString(p.s[start:p.i])
			p.i++
			return sb.String(), nil
		case c < 0x20:
			return nil, p.fail("Bad control character in string literal in JSON")
		case c == '\\':
			sb.WriteString(p.s[start:p.i])
			p.i++
			if p.i >= len(p.s) {
				return nil, p.fail("Unterminated string in JSON")
			}
			e := p.s[p.i]
			p.i++
			switch e {
			case '"', '\\', '/':
				sb.WriteByte(e)
			case 'b':
				sb.WriteByte('\b')
			case 'f':
				sb.WriteByte('\f')
			case 'n':
				sb.WriteByte('\n')
			case 'r':
				sb.WriteByte('\r')
			case 't':
				sb.WriteByte('\t')
			case 'u':
				r, ok := p.hex4()
				if !ok {
					return nil, p.fail("Bad Unicode escape in JSON")
				}
				// A high surrogate followed by an escaped low one is one code point.
				if r >= 0xD800 && r <= 0xDBFF && strings.HasPrefix(p.s[p.i:], `\u`) {
					save := p.i
					p.i += 2
					if lo, ok := p.hex4(); ok && lo >= 0xDC00 && lo <= 0xDFFF {
						r = 0x10000 + (r-0xD800)<<10 + (lo - 0xDC00)
					} else {
						p.i = save
					}
				}
				appendWTF8(&sb, r)
			default:
				p.i--
				return nil, p.fail("Bad escaped character in JSON")
			}
			start = p.i
		default:
			p.i++
		}
	}
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func (p *parser) number() (any, error) {
	start := p.i
	if p.s[p.i] == '-' {
		p.i++
	}
	if p.i >= len(p.s) {
		return nil, p.fail("No number after minus sign in JSON")
	}
	if p.s[p.i] == '0' {
		p.i++
	} else if isDigit(p.s[p.i]) {
		for p.i < len(p.s) && isDigit(p.s[p.i]) {
			p.i++
		}
	} else {
		return nil, p.fail("No number after minus sign in JSON")
	}
	if p.i < len(p.s) && p.s[p.i] == '.' {
		p.i++
		if p.i >= len(p.s) || !isDigit(p.s[p.i]) {
			return nil, p.fail("Unterminated fractional number in JSON")
		}
		for p.i < len(p.s) && isDigit(p.s[p.i]) {
			p.i++
		}
	}
	if p.i < len(p.s) && (p.s[p.i] == 'e' || p.s[p.i] == 'E') {
		p.i++
		if p.i < len(p.s) && (p.s[p.i] == '+' || p.s[p.i] == '-') {
			p.i++
		}
		if p.i >= len(p.s) || !isDigit(p.s[p.i]) {
			return nil, p.fail("Exponent part is missing a number in JSON")
		}
		for p.i < len(p.s) && isDigit(p.s[p.i]) {
			p.i++
		}
	}
	// Overflow is ±Inf, as in JS (stringified as null).
	f, _ := strconv.ParseFloat(p.s[start:p.i], 64)
	return f, nil
}

// ---------------------------------------------------------------- encoding

// FormatNumber is ECMAScript Number::toString(10).
func FormatNumber(f float64) string {
	if f != f {
		return "NaN"
	}
	if f == 0 {
		return "0"
	}
	if f < 0 {
		return "-" + FormatNumber(-f)
	}
	if f > 1.7976931348623157e308 {
		return "Infinity"
	}
	e := strconv.FormatFloat(f, 'e', -1, 64) // d.ddde±XX
	mant, expPart, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	exp, _ := strconv.Atoi(expPart)
	k := len(digits)
	n := exp + 1
	switch {
	case k <= n && n <= 21:
		return digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return "0." + strings.Repeat("0", -n) + digits
	}
	sign := "+"
	if n-1 < 0 {
		sign = "-"
	}
	abs := n - 1
	if abs < 0 {
		abs = -abs
	}
	if k == 1 {
		return digits + "e" + sign + strconv.Itoa(abs)
	}
	return digits[:1] + "." + digits[1:] + "e" + sign + strconv.Itoa(abs)
}

// nextCodePoint decodes one WTF-8 code point: a lone surrogate's 3-byte
// encoding comes back as the surrogate itself.
func nextCodePoint(s string, i int) (rune, int) {
	if i+2 < len(s) && s[i] == 0xED && s[i+1] >= 0xA0 && s[i+1] <= 0xBF {
		return rune(0xD000) | rune(s[i+1]&0x3F)<<6 | rune(s[i+2]&0x3F), 3
	}
	r, size := utf8.DecodeRuneInString(s[i:])
	return r, size
}

const lowerHex = "0123456789abcdef"

// QuoteJSON is JSON.stringify(string).
func QuoteJSON(sb *strings.Builder, s string) {
	sb.WriteByte('"')
	start := 0
	for i := 0; i < len(s); {
		c := s[i]
		if c >= 0x20 && c != '"' && c != '\\' && c < 0x80 {
			i++
			continue
		}
		if c < 0x80 {
			sb.WriteString(s[start:i])
			switch c {
			case '"':
				sb.WriteString(`\"`)
			case '\\':
				sb.WriteString(`\\`)
			case '\b':
				sb.WriteString(`\b`)
			case '\f':
				sb.WriteString(`\f`)
			case '\n':
				sb.WriteString(`\n`)
			case '\r':
				sb.WriteString(`\r`)
			case '\t':
				sb.WriteString(`\t`)
			default:
				sb.WriteString(`\u00`)
				sb.WriteByte(lowerHex[c>>4])
				sb.WriteByte(lowerHex[c&0xF])
			}
			i++
			start = i
			continue
		}
		r, size := nextCodePoint(s, i)
		if r >= 0xD800 && r <= 0xDFFF {
			sb.WriteString(s[start:i])
			sb.WriteString(`\u`)
			sb.WriteByte(lowerHex[(r>>12)&0xF])
			sb.WriteByte(lowerHex[(r>>8)&0xF])
			sb.WriteByte(lowerHex[(r>>4)&0xF])
			sb.WriteByte(lowerHex[r&0xF])
			i += size
			start = i
			continue
		}
		i += size
	}
	sb.WriteString(s[start:])
	sb.WriteByte('"')
}

// Stringify is JSON.stringify(v) (indent 0) or JSON.stringify(v, null, indent).
func Stringify(v any, indent int) string {
	var sb strings.Builder
	writeValue(&sb, v, indent, "")
	return sb.String()
}

func writeValue(sb *strings.Builder, v any, indent int, current string) {
	switch x := v.(type) {
	case nil:
		sb.WriteString("null")
	case bool:
		if x {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
	case float64:
		if x != x || x > 1.7976931348623157e308 || x < -1.7976931348623157e308 {
			sb.WriteString("null")
		} else {
			sb.WriteString(FormatNumber(x))
		}
	case int:
		sb.WriteString(FormatNumber(float64(x)))
	case string:
		QuoteJSON(sb, x)
	case []any:
		if len(x) == 0 {
			sb.WriteString("[]")
			return
		}
		inner := current + strings.Repeat(" ", indent)
		sb.WriteByte('[')
		for i, item := range x {
			if i > 0 {
				sb.WriteByte(',')
			}
			if indent > 0 {
				sb.WriteByte('\n')
				sb.WriteString(inner)
			}
			writeValue(sb, item, indent, inner)
		}
		if indent > 0 {
			sb.WriteByte('\n')
			sb.WriteString(current)
		}
		sb.WriteByte(']')
	case *Object:
		if x.Len() == 0 {
			sb.WriteString("{}")
			return
		}
		inner := current + strings.Repeat(" ", indent)
		sb.WriteByte('{')
		for i, k := range x.keys {
			if i > 0 {
				sb.WriteByte(',')
			}
			if indent > 0 {
				sb.WriteByte('\n')
				sb.WriteString(inner)
			}
			QuoteJSON(sb, k)
			sb.WriteByte(':')
			if indent > 0 {
				sb.WriteByte(' ')
			}
			writeValue(sb, x.vals[k], indent, inner)
		}
		if indent > 0 {
			sb.WriteByte('\n')
			sb.WriteString(current)
		}
		sb.WriteByte('}')
	case rawJSON:
		sb.WriteString(string(x))
	default:
		panic("content: unsupported JSON value")
	}
}

// rawJSON is an already-serialized value, spliced in verbatim.
type rawJSON string

// ---------------------------------------------------------------- strings

// utf16Units returns s as UTF-16 code units (JS string semantics).
func utf16Units(s string) []uint16 {
	out := make([]uint16, 0, len(s))
	for i := 0; i < len(s); {
		r, size := nextCodePoint(s, i)
		i += size
		if r >= 0x10000 {
			r -= 0x10000
			out = append(out, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF)))
		} else {
			out = append(out, uint16(r))
		}
	}
	return out
}

// jsLength is a JS string's .length.
func jsLength(s string) int {
	n := 0
	for i := 0; i < len(s); {
		r, size := nextCodePoint(s, i)
		i += size
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// compareJS orders two strings like JS's `<`: by UTF-16 code units.
func compareJS(a, b string) int {
	// Byte order equals code-unit order unless a supplementary code point
	// meets U+E000..U+FFFF; compare in UTF-16 only when it might matter.
	ascii := true
	for i := 0; i < len(a) && ascii; i++ {
		ascii = a[i] < 0x80
	}
	for i := 0; i < len(b) && ascii; i++ {
		ascii = b[i] < 0x80
	}
	if ascii {
		return strings.Compare(a, b)
	}
	x, y := utf16Units(a), utf16Units(b)
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			if x[i] < y[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(x) < len(y):
		return -1
	case len(x) > len(y):
		return 1
	}
	return 0
}
