package proc

import (
	"regexp"
	"strconv"
	"sync"
)

var WellKnownStarters = []string{"dev", "start"}

func IsWellKnownStarter(name string) bool {
	for _, s := range WellKnownStarters {
		if s == name {
			return true
		}
	}
	return false
}

// urlPattern requires one of the banner phrases ("Local:" / "Listening on") on
// the SAME line as the bind URL — a bare `http://localhost:N` isn't enough.
// `dev`/`start` often run more than one process (e.g. a framework that prints
// the injected PORT, a proxied fetch, a sibling `node server.js`) whose stdout
// interleaves on the same stream; without the phrase gate an unrelated URL
// could win the lock before the real bind line arrives. Frameworks covered:
//
//	vite:  `Local:   http://localhost:5173/`
//	next:  `- Local:        http://localhost:3000`
//	bun:   `Listening on http://localhost:3000`
//	fresh: `Listening on http://0.0.0.0:8000/`
//
// The port must be followed by a `/` or whitespace (incl. the trailing newline)
// so a chunk that splits mid-number ("...:51" | "73/") waits for its
// continuation instead of locking the truncated "51".
var urlPattern = regexp.MustCompile(
	`(?:Local:|Listening on)[^\n]*?\bhttps?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)[/\s]`,
)

// ansiPattern mirrors the TS regex, which matches bracket sequences without
// requiring the ESC prefix.
var ansiPattern = regexp.MustCompile(`\[[0-9;?]*[a-zA-Z]`)

// carryLimit bounds the per-source tail kept across Observe calls. The longest
// phrase+URL we need to span is well under 100 chars, so 200 leaves headroom.
const carryLimit = 200

// PortSniffer locks in the first bind-URL port announced on a well-known
// starter's stdout until Reset.
type PortSniffer struct {
	mu   sync.Mutex
	port int
	// PTY reads (child.onData) aren't line-buffered — a chunk boundary can land
	// mid bind-line (e.g. "...Local:   http://localhost:51" | "73/\n"). Matching
	// each chunk in isolation would miss the announcement forever, so we carry a
	// bounded, ANSI-stripped tail per source and match against the concatenation.
	carry map[string]string
}

func NewPortSniffer() *PortSniffer {
	return &PortSniffer{carry: map[string]string{}}
}

func (p *PortSniffer) Observe(source, data string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.port != 0 {
		return
	}
	if !IsWellKnownStarter(source) {
		return
	}
	combined := p.carry[source] + ansiPattern.ReplaceAllString(data, "")
	m := urlPattern.FindStringSubmatch(combined)
	if m == nil {
		p.carry[source] = tail(combined, carryLimit)
		return
	}
	parsed, err := strconv.Atoi(m[1])
	if err != nil || parsed <= 0 || parsed > 65535 {
		p.carry[source] = tail(combined, carryLimit)
		return
	}
	delete(p.carry, source)
	p.port = parsed
}

// tail returns the last n runes of s (rune-safe so a multibyte char like the
// vite "➜" prefix is never split across a carry boundary).
func tail(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[len(r)-n:])
}

// Current returns the sniffed port, 0 when nothing is locked in.
func (p *PortSniffer) Current() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.port
}

func (p *PortSniffer) Reset() {
	p.mu.Lock()
	p.port = 0
	p.carry = map[string]string{}
	p.mu.Unlock()
}
