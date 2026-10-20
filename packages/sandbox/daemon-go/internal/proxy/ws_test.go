package proxy

import (
	"bufio"
	"bytes"
	"net"
	"net/http/httptest"
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

// TestServeUpstream_WriteFailureSendsCloseFrame reproduces the gap this file's
// ws.go fix closes: a dial that succeeds but whose upstream drops the
// connection before the upgrade request can be forwarded used to leave the
// client with a bare TCP reset instead of a proper WebSocket close.
func TestServeUpstream_WriteFailureSendsCloseFrame(t *testing.T) {
	clientConn, testClient := net.Pipe()
	defer testClient.Close()

	// The upstream side is already closed, so writeUpgradeRequest's Write
	// fails deterministically — no real dial/race needed.
	upstream, testUpstream := net.Pipe()
	testUpstream.Close()

	req := httptest.NewRequest("GET", "/ws", nil)
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-Websocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")

	done := make(chan struct{})
	go func() {
		serveUpstream(clientConn, bufio.NewReader(clientConn), req, upstream, nil)
		close(done)
	}()

	// serveUpstream (unlike ServeWs) doesn't close clientConn on the way out —
	// that's ServeWs's defer — so read exactly the two writes it makes (the
	// 101 handshake, then the close frame) instead of looping to EOF/deadline.
	testClient.SetReadDeadline(time.Now().Add(2 * time.Second))
	var got bytes.Buffer
	buf := make([]byte, 512)
	for range 2 {
		n, err := testClient.Read(buf)
		if err != nil {
			t.Fatalf("reading from client conn: %v", err)
		}
		got.Write(buf[:n])
	}

	if !bytes.Contains(got.Bytes(), []byte("101 Switching Protocols")) {
		t.Fatalf("expected a completed handshake before the close frame, got: %q", got.Bytes())
	}
	if !bytes.Contains(got.Bytes(), []byte{0x88}) {
		t.Fatalf("expected a close frame (opcode 0x88) after the handshake, got: %q", got.Bytes())
	}

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("serveUpstream did not return after the upstream write failed")
	}
}
