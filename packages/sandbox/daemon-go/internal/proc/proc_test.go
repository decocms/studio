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
