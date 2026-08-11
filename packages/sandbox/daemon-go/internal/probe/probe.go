package probe

import (
	"context"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	FastInterval     = 1 * time.Second
	SlowInterval     = 30 * time.Second
	HeadTimeout      = 5 * time.Second
	FailureThreshold = 3
)

const (
	StatusBooting = "booting"
	StatusOnline  = "online"
	StatusOffline = "offline"
)

type State struct {
	Status      string
	Port        int
	HtmlSupport bool
}

type Deps struct {
	GetPort  func() int
	OnChange func(s State)
	OnLog    func(msg string)
	// Fast/Slow override the poll cadence; zero uses FastInterval/SlowInterval.
	// Exposed so a healthy server's dead-detection latency is tunable (and so
	// tests don't wait the 30s slow interval).
	Fast time.Duration
	Slow time.Duration
}

type Prober struct {
	mu                  sync.Mutex
	state               State
	consecutiveFailures int
	deps                Deps
	fast                time.Duration
	slow                time.Duration
	stop                chan struct{}
}

func Start(deps Deps) *Prober {
	fast := deps.Fast
	if fast <= 0 {
		fast = FastInterval
	}
	slow := deps.Slow
	if slow <= 0 {
		slow = SlowInterval
	}
	p := &Prober{
		state: State{Status: StatusBooting},
		deps:  deps,
		fast:  fast,
		slow:  slow,
		stop:  make(chan struct{}),
	}
	go p.loop()
	return p
}

func (p *Prober) Reset() {
	p.mu.Lock()
	p.state = State{Status: StatusBooting}
	p.consecutiveFailures = 0
	p.mu.Unlock()
}

func (p *Prober) Stop() {
	close(p.stop)
}

func (p *Prober) loop() {
	for {
		p.mu.Lock()
		delay := p.slow
		if p.state.Status != StatusOnline || p.consecutiveFailures > 0 {
			delay = p.fast
		}
		p.mu.Unlock()
		select {
		case <-time.After(delay):
		case <-p.stop:
			return
		}
		p.tick()
	}
}

func (p *Prober) tick() {
	port := p.deps.GetPort()

	p.mu.Lock()
	if port != p.state.Port {
		p.applyLocked(State{Status: StatusBooting, Port: port})
	}
	if p.state.Port == 0 {
		p.mu.Unlock()
		return
	}
	portAtStart := p.state.Port
	p.mu.Unlock()

	status, isHtml, up := head(portAtStart)

	p.mu.Lock()
	defer p.mu.Unlock()
	if p.state.Port != portAtStart {
		return
	}
	if up {
		p.consecutiveFailures = 0
		next := State{Status: StatusOnline, Port: p.state.Port, HtmlSupport: isHtml}
		prevStatus := p.state.Status
		p.applyLocked(next)
		if prevStatus == StatusBooting && p.deps.OnLog != nil {
			p.deps.OnLog("[probe] server responded on port " + itoa(p.state.Port) + " (status " + itoa(status) + ")\r\n")
		} else if prevStatus == StatusOffline && p.deps.OnLog != nil {
			p.deps.OnLog("[probe] server back online on port " + itoa(p.state.Port) + " (status " + itoa(status) + ")\r\n")
		}
	} else {
		p.consecutiveFailures++
		if p.state.Status == StatusOnline && p.consecutiveFailures >= FailureThreshold {
			next := p.state
			next.Status = StatusOffline
			p.applyLocked(next)
			if p.deps.OnLog != nil {
				p.deps.OnLog("[probe] server stopped responding on port " + itoa(p.state.Port) + "\r\n")
			}
		}
	}
}

func (p *Prober) applyLocked(next State) {
	if next == p.state {
		return
	}
	p.state = next
	if p.deps.OnChange != nil {
		snapshot := next
		go p.deps.OnChange(snapshot)
	}
}

func itoa(n int) string {
	return strconv.Itoa(n)
}

func head(port int) (status int, isHtml, up bool) {
	client := &http.Client{
		Timeout: HeadTimeout,
		Transport: &http.Transport{
			DialContext: DialLoopback,
		},
	}
	req, err := http.NewRequest("HEAD", "http://loopback:"+itoa(port)+"/", nil)
	if err != nil {
		return 0, false, false
	}
	req = req.WithContext(contextWithPort(req.Context(), port))
	res, err := client.Do(req)
	if err != nil {
		return 0, false, false
	}
	res.Body.Close()
	ct := strings.ToLower(res.Header.Get("Content-Type"))
	return res.StatusCode, strings.Contains(ct, "text/html"), true
}

type portKey struct{}

func contextWithPort(ctx context.Context, port int) context.Context {
	return context.WithValue(ctx, portKey{}, port)
}

// DialLoopback tries [::1] first and falls back to 127.0.0.1 on
// connect-level failures only (never mid-flight errors).
func DialLoopback(ctx context.Context, network, addr string) (net.Conn, error) {
	port := ""
	if v, ok := ctx.Value(portKey{}).(int); ok {
		port = itoa(v)
	} else {
		_, p, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		port = p
	}
	d := net.Dialer{}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort("::1", port))
	if err == nil {
		return conn, nil
	}
	return d.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", port))
}
