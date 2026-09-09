package proxy

import (
	"bufio"
	"net"
	"testing"
	"time"
)

// TestSplice_ReturnsWhenUpstreamClosesEvenIfClientNeverDoes reproduces the
// deadlock this file's splice fix closes: an upstream (dev server) that
// closes while the client side never sends anything and never closes its own
// connection must not hang splice forever.
func TestSplice_ReturnsWhenUpstreamClosesEvenIfClientNeverDoes(t *testing.T) {
	clientConn, testClient := net.Pipe()
	defer testClient.Close()
	upstreamConn, testUpstream := net.Pipe()

	// Upstream (the dev server) is already gone; the client peer stays open
	// and silent, exactly the case that used to block clientBuf.Read forever.
	testUpstream.Close()

	done := make(chan struct{})
	go func() {
		splice(clientConn, bufio.NewReader(clientConn), upstreamConn, nil)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("splice did not return after upstream closed; client-read goroutine leaked")
	}
}
