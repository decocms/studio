package proc

import (
	"strings"
	"testing"
)

func TestRingBufferKeepsTail(t *testing.T) {
	rb := NewRingBuffer(10)
	rb.Append("0123456789")
	data, truncated := rb.Read()
	if data != "0123456789" || truncated {
		t.Fatalf("got %q truncated=%v", data, truncated)
	}
	rb.Append("ABCDE")
	data, truncated = rb.Read()
	if !truncated {
		t.Fatal("expected truncation")
	}
	if len(data) != 10 || !strings.HasSuffix(data, "ABCDE") {
		t.Fatalf("got %q", data)
	}
}

func TestPortSnifferLockIn(t *testing.T) {
	s := NewPortSniffer()
	s.Observe("not-a-starter", "Local: http://localhost:5173/")
	if s.Current() != 0 {
		t.Fatal("non-starter sources must be ignored")
	}
	s.Observe("dev", "\x1b[32mLocal:\x1b[0m   http://localhost:5174/")
	if s.Current() != 5174 {
		t.Fatalf("got %d", s.Current())
	}
	s.Observe("dev", "outbound fetch http://localhost:9999/api")
	if s.Current() != 5174 {
		t.Fatal("first match must stay locked in")
	}
	s.Reset()
	if s.Current() != 0 {
		t.Fatal("reset must unlock")
	}
	s.Observe("start", "Listening on http://0.0.0.0:8000/")
	if s.Current() != 8000 {
		t.Fatalf("got %d", s.Current())
	}
}

// A bare `http://localhost:N` with no banner phrase must NOT lock — otherwise an
// early line echoing the injected PORT (3000) hijacks the probe before vite's
// real `Local: http://localhost:5173/` arrives. This is the granado regression:
// the daemon dialed 3000 while vite served 5173.
func TestPortSnifferIgnoresBareURLBeforeBanner(t *testing.T) {
	s := NewPortSniffer()
	s.Observe("dev", "[deco] proxying dev server at http://localhost:3000\r\n")
	if s.Current() != 0 {
		t.Fatalf("bare URL without a banner phrase must not lock, got %d", s.Current())
	}
	s.Observe("dev", "  \x1b[32m➜\x1b[0m  Local:   http://localhost:5173/\r\n")
	if s.Current() != 5173 {
		t.Fatalf("expected the real vite bind port 5173, got %d", s.Current())
	}
}

// PTY output isn't line-buffered: the bind line can split across chunks. The
// sniffer must carry a per-source tail so the announcement still matches once
// its continuation arrives (the other half of the granado regression).
func TestPortSnifferSpansChunkBoundary(t *testing.T) {
	s := NewPortSniffer()
	s.Observe("dev", "  ➜  Local:   http://localhost:51")
	if s.Current() != 0 {
		t.Fatal("partial bind line must not lock yet")
	}
	s.Observe("dev", "73/\r\n")
	if s.Current() != 5173 {
		t.Fatalf("split bind line must lock once completed, got %d", s.Current())
	}
}
