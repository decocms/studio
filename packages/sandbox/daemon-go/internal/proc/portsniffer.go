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

var urlPattern = regexp.MustCompile(`https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)`)

// ansiPattern mirrors the TS regex, which matches bracket sequences without
// requiring the ESC prefix.
var ansiPattern = regexp.MustCompile(`\[[0-9;?]*[a-zA-Z]`)

// PortSniffer locks in the first bind-URL port announced on a well-known
// starter's stdout until Reset.
type PortSniffer struct {
	mu   sync.Mutex
	port int
}

func NewPortSniffer() *PortSniffer {
	return &PortSniffer{}
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
	stripped := ansiPattern.ReplaceAllString(data, "")
	m := urlPattern.FindStringSubmatch(stripped)
	if m == nil {
		return
	}
	parsed, err := strconv.Atoi(m[1])
	if err != nil || parsed <= 0 || parsed > 65535 {
		return
	}
	p.port = parsed
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
	p.mu.Unlock()
}
