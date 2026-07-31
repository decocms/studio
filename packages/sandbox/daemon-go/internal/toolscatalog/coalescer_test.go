package toolscatalog

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// stub replaces the real sync and reports how many times it ran.
func stub(c *Coalescer, block <-chan struct{}) *atomic.Int32 {
	var runs atomic.Int32
	c.sync = func(Endpoint) error {
		runs.Add(1)
		if block != nil {
			<-block
		}
		return nil
	}
	return &runs
}

func waitFor(t *testing.T, runs *atomic.Int32, want int32) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if runs.Load() == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("ran %d times, want %d", runs.Load(), want)
}

func TestCoalescerDropsWhileInFlight(t *testing.T) {
	c := NewCoalescer(Opts{}, time.Hour)
	block := make(chan struct{})
	runs := stub(c, block)

	// Every dispatch carries an MCP endpoint, so the burst is the normal case.
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.Sync(Endpoint{URL: "https://mcp.example/x"})
		}()
	}
	wg.Wait()
	waitFor(t, runs, 1)
	close(block)
}

func TestCoalescerHonorsMinInterval(t *testing.T) {
	c := NewCoalescer(Opts{}, time.Hour)
	runs := stub(c, nil)
	ep := Endpoint{URL: "https://mcp.example/x"}

	c.Sync(ep)
	waitFor(t, runs, 1)
	// A second run inside the interval is dropped, not queued — a queued one would
	// just re-list the catalog the moment the window opened.
	c.Sync(ep)
	time.Sleep(20 * time.Millisecond)
	if got := runs.Load(); got != 1 {
		t.Fatalf("ran %d times inside the min interval, want 1", got)
	}

	// Past the interval it runs again.
	c.minInterval = time.Millisecond
	time.Sleep(2 * time.Millisecond)
	c.Sync(ep)
	waitFor(t, runs, 2)
}

func TestCoalescerKeysByEndpoint(t *testing.T) {
	c := NewCoalescer(Opts{}, time.Hour)
	runs := stub(c, nil)

	// One endpoint's recent sync must not suppress another's: a sandbox can be
	// re-pointed at a different Virtual MCP, and that catalog has never synced.
	c.Sync(Endpoint{URL: "https://mcp.example/a"})
	c.Sync(Endpoint{URL: "https://mcp.example/b"})
	waitFor(t, runs, 2)
}

func TestCoalescerIgnoresEmptyEndpoint(t *testing.T) {
	c := NewCoalescer(Opts{}, time.Hour)
	runs := stub(c, nil)
	c.Sync(Endpoint{})
	time.Sleep(20 * time.Millisecond)
	if got := runs.Load(); got != 0 {
		t.Fatalf("synced a run that carries no MCP endpoint (%d runs)", got)
	}
}
