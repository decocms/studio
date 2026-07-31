package events

import (
	"encoding/json"
	"testing"
)

// TestLifecyclePhaseExhaustiveness fails when a phase is added to AllPhases
// without a marshal case — the Go substitute for exhaustive matching.
func TestLifecyclePhaseExhaustiveness(t *testing.T) {
	for _, phase := range AllPhases {
		s := LifecycleState{Phase: phase, To: "x", Error: "e", Port: 1, HtmlSupport: true}
		raw, err := json.Marshal(s)
		if err != nil {
			t.Fatalf("phase %q not handled by MarshalJSON: %v", phase, err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("phase %q produced invalid JSON: %v", phase, err)
		}
		if decoded["phase"] != phase {
			t.Fatalf("phase %q marshalled as %v", phase, decoded["phase"])
		}
	}
	if _, err := json.Marshal(LifecycleState{Phase: "not-a-phase"}); err == nil {
		t.Fatal("unknown phase must fail to marshal")
	}
}

func TestLifecyclePayloadShapes(t *testing.T) {
	cases := map[string]LifecycleState{
		`{"phase":"idle"}`:                                    {Phase: PhaseIdle},
		`{"phase":"checking-out","to":"main"}`:                {Phase: PhaseCheckingOut, To: "main"},
		`{"error":"boom","phase":"clone-failed"}`:             {Phase: PhaseCloneFailed, Error: "boom"},
		`{"htmlSupport":true,"phase":"running","port":3000}`:  {Phase: PhaseRunning, Port: 3000, HtmlSupport: true},
		`{"htmlSupport":false,"phase":"running","port":3000}`: {Phase: PhaseRunning, Port: 3000},
		`{"phase":"crashed"}`:                                 {Phase: PhaseCrashed},
	}
	for want, state := range cases {
		raw, err := json.Marshal(state)
		if err != nil {
			t.Fatalf("%+v: %v", state, err)
		}
		if string(raw) != want {
			t.Errorf("marshal %+v = %s, want %s", state, raw, want)
		}
	}
}
