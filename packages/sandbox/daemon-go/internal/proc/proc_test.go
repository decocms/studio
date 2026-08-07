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

// The no-trailing-slash frameworks (next, bun) end the port with a newline, not
// a "/". When the URL is also colored, the ANSI stripper must consume the ESC so
// the port isn't shielded from the terminator check — otherwise the sniffer
// misses and the daemon dials the wrong configured port.
func TestPortSnifferColoredNoTrailingSlash(t *testing.T) {
	s := NewPortSniffer()
	s.Observe("dev", "Listening on \x1b[1mhttp://localhost:3000\x1b[0m\r\n")
	if s.Current() != 3000 {
		t.Fatalf("colored no-slash bind URL must lock 3000, got %d", s.Current())
	}
}

// A port terminated by a non-"/", non-space char (e.g. a closing paren) must
// still lock — the terminator only has to be a non-digit so a split mid-number
// keeps waiting.
func TestPortSnifferNonSlashTerminator(t *testing.T) {
	s := NewPortSniffer()
	s.Observe("dev", "  Local: (http://localhost:3000)\n")
	if s.Current() != 3000 {
		t.Fatalf("paren-terminated port must lock 3000, got %d", s.Current())
	}
}

// Reset must clear the carry, not just the port — otherwise a partial bind line
// carried from a previous cycle can splice with a new fragment into a false
// match (e.g. a leftover "…:51" + a fresh "73/").
func TestPortSnifferResetClearsCarry(t *testing.T) {
	s := NewPortSniffer()
	s.Observe("dev", "  Local:   http://localhost:51")
	s.Reset()
	s.Observe("dev", "73/\r\n")
	if s.Current() != 0 {
		t.Fatalf("stale carry survived Reset and produced a false lock: %d", s.Current())
	}
}

// The phrase gate + line-bound `[^\n]*?` must ignore an unrelated localhost URL
// from a sibling line that precedes the real bind banner in the same chunk.
func TestPortSnifferIgnoresSiblingURLBeforeBanner(t *testing.T) {
	s := NewPortSniffer()
	s.Observe("dev", "API ready on http://localhost:4000/graphql\n  Local:   http://localhost:3000/\n")
	if s.Current() != 3000 {
		t.Fatalf("must lock the banner's port 3000, not the sibling 4000, got %d", s.Current())
	}
}

// Each starter source carries independently: a chunk on `start` must not corrupt
// a partial bind line carried on `dev`.
func TestPortSnifferPerSourceCarryIsolation(t *testing.T) {
	s := NewPortSniffer()
	s.Observe("dev", "  Local:   http://localhost:51")
	s.Observe("start", "Listening on http://localhost:80")
	s.Observe("dev", "73/\r\n")
	if s.Current() != 5173 {
		t.Fatalf("dev carry corrupted by start chunk, got %d", s.Current())
	}
}

// A dev server spawned on a PTY inherits a tty, and corepack blocks on
// "Do you want to continue? [Y/n]" forever the first time it fetches a
// yarn/pnpm shim. Nothing times that out — the sandbox just never boots.
func TestBuildEnvSilencesCorepackPrompt(t *testing.T) {
	for _, tc := range []struct {
		name string
		env  []string
	}{
		{"pty", buildEnv(true, map[string]string{"PORT": "3000"}, map[string]string{"TERM": "xterm-256color"})},
		{"pipe", buildEnv(false, map[string]string{"PORT": "3000"}, nil)},
	} {
		got := map[string]string{}
		for _, kv := range tc.env {
			if i := strings.IndexByte(kv, '='); i >= 0 {
				got[kv[:i]] = kv[i+1:]
			}
		}
		if got["COREPACK_ENABLE_DOWNLOAD_PROMPT"] != "0" {
			t.Fatalf("%s: download prompt not disabled: %q", tc.name, got["COREPACK_ENABLE_DOWNLOAD_PROMPT"])
		}
		if got["COREPACK_ENABLE_STRICT"] != "0" {
			t.Fatalf("%s: strict not disabled: %q", tc.name, got["COREPACK_ENABLE_STRICT"])
		}
		// Caller-supplied env still wins.
		if got["PORT"] != "3000" {
			t.Fatalf("%s: overrides lost: %q", tc.name, got["PORT"])
		}
	}
}
