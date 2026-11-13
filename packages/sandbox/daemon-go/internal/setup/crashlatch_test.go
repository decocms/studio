package setup

import (
	"testing"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
	"github.com/decocms/studio/sandbox-daemon/internal/events"
)

func TestConfigTransitionsThatRestartDevClearTheCrashLatch(t *testing.T) {
	cases := []struct {
		kind  string
		clear bool
	}{
		{config.KindBootstrap, true},
		{config.KindBranchChange, true},
		{config.KindPmChange, true},
		{config.KindRuntimeChange, true},
		{config.KindPortChange, true},
		{config.KindEnvChange, true},
		{config.KindNoOp, false},
		{config.KindAppsChange, false},
		{config.KindGitCredentialRefresh, false},
	}
	for _, c := range cases {
		status := events.DaemonStatus{State: "error", Reason: "dev script exited with code 1"}
		o := &Orchestrator{deps: OrchestratorDeps{
			GetStatus: func() events.DaemonStatus { return status },
			SetStatus: func(next events.DaemonStatus) { status = next },
		}}
		o.clearCrashErrorFor(config.Transition{Kind: c.kind})
		if cleared := status.State == "running"; cleared != c.clear {
			t.Errorf("%s: cleared = %v, want %v", c.kind, cleared, c.clear)
		}
	}
}
