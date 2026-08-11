package devwatch

import (
	"testing"
	"time"
)

func TestDecide(t *testing.T) {
	// A dead-but-known-port server past the grace window, with budget → restart.
	base := Input{
		Serving:         false,
		Restartable:     true,
		PortKnown:       true,
		UnreachableFor:  DefaultGracePeriod,
		Attempts:        0,
		RestartInFlight: false,
	}

	cases := []struct {
		name string
		in   Input
		want Action
	}{
		{"dead past grace with budget → restart", base, ActionRestart},
		{
			"serving → none",
			with(base, func(i *Input) { i.Serving = true }),
			ActionNone,
		},
		{
			"not restartable phase (installing/clone-failed) → none",
			with(base, func(i *Input) { i.Restartable = false }),
			ActionNone,
		},
		{
			"no port known yet (legit slow build) → none",
			with(base, func(i *Input) { i.PortKnown = false }),
			ActionNone,
		},
		{
			"within grace → none",
			with(base, func(i *Input) { i.UnreachableFor = DefaultGracePeriod - time.Millisecond }),
			ActionNone,
		},
		{
			"restart already in flight → none",
			with(base, func(i *Input) { i.RestartInFlight = true }),
			ActionNone,
		},
		{
			"budget exhausted → give up",
			with(base, func(i *Input) { i.Attempts = MaxRestarts }),
			ActionGiveUp,
		},
		{
			"budget exhausted but serving → none (server recovered)",
			with(base, func(i *Input) {
				i.Attempts = MaxRestarts
				i.Serving = true
			}),
			ActionNone,
		},
		{
			"last attempt still has budget → restart",
			with(base, func(i *Input) { i.Attempts = MaxRestarts - 1 }),
			ActionRestart,
		},
		{
			"exactly at grace boundary → restart",
			with(base, func(i *Input) { i.UnreachableFor = DefaultGracePeriod }),
			ActionRestart,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Decide(tc.in, DefaultGracePeriod); got != tc.want {
				t.Fatalf("Decide() = %v, want %v", got, tc.want)
			}
		})
	}
}

func with(in Input, mut func(*Input)) Input {
	mut(&in)
	return in
}
