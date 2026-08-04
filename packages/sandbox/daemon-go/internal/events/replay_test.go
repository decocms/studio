package events

import "testing"

func TestReplayBufferTrimsToMaxBytes(t *testing.T) {
	r := NewReplayBuffer(10)
	r.Append("stdout", "0123456789") // exactly maxBytes
	if got := r.Read("stdout"); got != "0123456789" {
		t.Fatalf("got %q, want %q", got, "0123456789")
	}
	r.Append("stdout", "AB") // pushes past maxBytes, drops from the front
	if got := r.Read("stdout"); got != "23456789AB" {
		t.Fatalf("got %q, want %q", got, "23456789AB")
	}
}

func TestReplayBufferManySmallAppendsStaysBounded(t *testing.T) {
	r := NewReplayBuffer(5)
	for i := 0; i < 1000; i++ {
		r.Append("stdout", "x")
	}
	got := r.Read("stdout")
	if got != "xxxxx" {
		t.Fatalf("got %q, want 5 x's", got)
	}
}

func TestReplayBufferSourcesPreservesInsertionOrder(t *testing.T) {
	r := NewReplayBuffer(100)
	r.Append("stderr", "e")
	r.Append("stdout", "o")
	r.Append("stderr", "e2")
	if got := r.Sources(); len(got) != 2 || got[0] != "stderr" || got[1] != "stdout" {
		t.Fatalf("got %v, want [stderr stdout]", got)
	}
}

func TestReplayBufferEmptyAppendNoop(t *testing.T) {
	r := NewReplayBuffer(10)
	r.Append("stdout", "")
	if got := r.Sources(); len(got) != 0 {
		t.Fatalf("empty append should not register a source, got %v", got)
	}
}
