package routes

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
	"github.com/decocms/studio/sandbox-daemon/internal/events"
	"github.com/decocms/studio/sandbox-daemon/internal/proc"
)

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

// Before this fix, Exec ignored decodeBody's error and ran the handler with a
// zero-value body instead of rejecting the request — a malformed request body
// silently spawned the script in background mode with no timeout/env instead
// of surfacing the 400 every other route in this package returns for the same
// decodeBody failure.
func TestExecRejectsMalformedBody(t *testing.T) {
	repoDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(repoDir, "package.json"), []byte(`{"scripts":{"build":"true"}}`), 0o644); err != nil {
		t.Fatalf("write package.json: %v", err)
	}
	store := config.NewStore()
	store.Hydrate(&config.TenantConfig{
		Application: &config.Application{
			PackageManager: &config.PackageManagerConfig{Name: config.Str("npm")},
		},
	})
	deps := ExecDeps{
		RepoDir:     repoDir,
		Store:       store,
		TaskManager: proc.NewTaskManager(proc.TaskManagerDeps{LogsDir: t.TempDir()}),
		GetStatus:   func() events.DaemonStatus { return events.DaemonStatus{} },
		SetStatus:   func(events.DaemonStatus) {},
	}

	req := httptest.NewRequest(http.MethodPost, "/exec/build", strings.NewReader("{not json"))
	req.SetPathValue("name", "build")
	rec := httptest.NewRecorder()
	Exec(deps)(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
}
