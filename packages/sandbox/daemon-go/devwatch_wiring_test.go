package main

import (
	"strings"
	"testing"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/devwatch"
)

// The watchdog must size a respawn's window from the boot this sandbox was
// actually measured to need. The montecarlo numbers are the ones that matter:
// a 5m18s boot has to buy the respawn more than the 20s default grace.
func TestRestartGraceForBoot(t *testing.T) {
	got := restartGraceForBoot((5*time.Minute + 18*time.Second).Milliseconds())
	if want := 10*time.Minute + 36*time.Second; got != want {
		t.Fatalf("want %v, got %v", want, got)
	}
	if got <= devwatch.DefaultGracePeriod {
		t.Fatalf("a 5m boot must widen past the default grace, got %v", got)
	}
}

// noteBootDuration has to work before devWatchLoop exists (a boot can finish
// first) and must keep the slowest boot, so the loop can replay it.
func TestNoteBootDurationReplaysToLaterTracker(t *testing.T) {
	d := &daemon{}
	d.noteBootDuration((5 * time.Minute).Milliseconds())
	d.noteBootDuration((1 * time.Second).Milliseconds()) // slower boot wins
	if got := d.observedBootMs.Load(); got != (5 * time.Minute).Milliseconds() {
		t.Fatalf("want the slowest boot retained, got %dms", got)
	}

	tr := devwatch.NewTracker(devwatch.Config{})
	tr.RaiseRestartGrace(restartGraceForBoot(d.observedBootMs.Load()))
	if want := 10 * time.Minute; tr.RestartGrace() != want {
		t.Fatalf("want %v after replay, got %v", want, tr.RestartGrace())
	}
}

// A zero or negative duration is a lifecycle bug, not a hint to shrink anything.
func TestNoteBootDurationIgnoresNonPositive(t *testing.T) {
	d := &daemon{}
	d.noteBootDuration(0)
	d.noteBootDuration(-1)
	if got := d.observedBootMs.Load(); got != 0 {
		t.Fatalf("want 0, got %d", got)
	}
}

func TestTailBytes(t *testing.T) {
	if got := tailBytes("abc", 10); got != "abc" {
		t.Fatalf("short input should pass through, got %q", got)
	}
	got := tailBytes("abcdef", 3)
	if got != "…def" {
		t.Fatalf("want the LAST bytes marked as truncated, got %q", got)
	}
	if !strings.HasSuffix(got, "def") {
		t.Fatalf("a crash's last words must survive, got %q", got)
	}
}
