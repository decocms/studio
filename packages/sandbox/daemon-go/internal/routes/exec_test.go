package routes

import "testing"

// Before this fix, an await-mode exec with no timeoutMs left spec.TimeoutMs
// at 0, which armTimeout treats as "no timeout" — the handler would block on
// TaskManager.Finished forever if the script never exits.
func TestResolveAwaitTimeoutMsDefaultsWhenUnset(t *testing.T) {
	if got := resolveAwaitTimeoutMs(0); got != bashDefaultTimeoutMs {
		t.Fatalf("got %d, want default %d", got, bashDefaultTimeoutMs)
	}
	if got := resolveAwaitTimeoutMs(-1); got != bashDefaultTimeoutMs {
		t.Fatalf("got %d, want default %d", got, bashDefaultTimeoutMs)
	}
}

func TestResolveAwaitTimeoutMsCapsAtCeiling(t *testing.T) {
	if got := resolveAwaitTimeoutMs(bashAwaitCeilingMs * 10); got != bashAwaitCeilingMs {
		t.Fatalf("got %d, want ceiling %d", got, bashAwaitCeilingMs)
	}
}

func TestResolveAwaitTimeoutMsPassesThroughValidValue(t *testing.T) {
	if got := resolveAwaitTimeoutMs(5000); got != 5000 {
		t.Fatalf("got %d, want 5000", got)
	}
}
