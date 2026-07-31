package toolscatalog

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// DefaultSyncMinInterval floors how often a dispatched run may trigger a
// background re-sync per endpoint — otherwise a busy sandbox re-lists the whole
// Virtual MCP on every dispatch.
const DefaultSyncMinInterval = 60 * time.Second

// Coalescer keeps `.deco/tools/` fresh from dispatch traffic without letting
// that traffic drive the sync rate: per endpoint URL, at most one sync in flight
// and at most one per MinInterval. Fire-and-forget — a dispatch never waits on
// it and never fails because of it.
type Coalescer struct {
	opts        Opts
	minInterval time.Duration

	mu       sync.Mutex
	lastRun  map[string]time.Time
	inFlight map[string]bool

	// The sync itself, swappable only by tests — the real one talks to a live MCP
	// endpoint, and coalescing is the part worth asserting.
	sync func(Endpoint) error
}

func NewCoalescer(opts Opts, minInterval time.Duration) *Coalescer {
	if minInterval <= 0 {
		minInterval = DefaultSyncMinInterval
	}
	c := &Coalescer{
		opts:        opts,
		minInterval: minInterval,
		lastRun:     map[string]time.Time{},
		inFlight:    map[string]bool{},
	}
	c.sync = c.run
	return c
}

// Sync re-syncs the catalog for ep in the background, or drops the request when
// one is already running or the last one was too recent.
func (c *Coalescer) Sync(ep Endpoint) {
	if c == nil || ep.URL == "" {
		return
	}
	c.mu.Lock()
	if c.inFlight[ep.URL] {
		c.mu.Unlock()
		return
	}
	if last, ok := c.lastRun[ep.URL]; ok && time.Since(last) < c.minInterval {
		c.mu.Unlock()
		return
	}
	c.inFlight[ep.URL] = true
	c.mu.Unlock()

	go func() {
		defer func() {
			c.mu.Lock()
			delete(c.inFlight, ep.URL)
			// Stamped on completion, not on start, so a slow sync does not
			// immediately allow another.
			c.lastRun[ep.URL] = time.Now()
			c.mu.Unlock()
		}()
		if err := c.sync(ep); err != nil {
			slog.Error("catalog sync failed", "err", err)
		}
	}()
}

func (c *Coalescer) run(ep Endpoint) error {
	if _, err := WriteEndpointFile(ep, c.opts); err != nil {
		return err
	}
	// No deadline of our own: the MCP client already bounds every request at 30s,
	// which is what keeps a hung endpoint from pinning this endpoint's in-flight
	// slot forever.
	tools, err := FetchCatalog(context.Background(), ep)
	if err != nil {
		return err
	}
	_, _, err = WriteCatalog(tools, c.opts)
	return err
}
