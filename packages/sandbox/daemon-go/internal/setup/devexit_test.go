package setup

import (
	"testing"

	"github.com/decocms/studio/sandbox-daemon/internal/events"
)

// A dev server that reached `running` and then died was killed, not broken at
// startup — and only `crashed` is restartable (see main.restartablePhase), so
// calling it `start-failed` disarms the watchdog for the life of the pod. Prod
// hit this via an external SIGTERM, which yarn reports as exit code 1.
func TestDevExitPhase(t *testing.T) {
	for _, tc := range []struct{ from, want string }{
		{events.PhaseRunning, events.PhaseCrashed},
		{events.PhaseStarting, events.PhaseStartFailed},
		{events.PhaseInstalling, events.PhaseStartFailed},
		{events.PhaseCrashed, events.PhaseCrashed},
		{events.PhaseStartFailed, events.PhaseStartFailed},
	} {
		if got := DevExitPhase(tc.from); got != tc.want {
			t.Errorf("DevExitPhase(%q) = %q, want %q", tc.from, got, tc.want)
		}
	}
}
