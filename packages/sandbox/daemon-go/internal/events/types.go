package events

import (
	"encoding/json"
	"fmt"
)

const (
	PhaseIdle          = "idle"
	PhaseCloning       = "cloning"
	PhaseCheckingOut   = "checking-out"
	PhaseCloneFailed   = "clone-failed"
	PhaseInstalling    = "installing"
	PhaseInstallFailed = "install-failed"
	PhaseStarting      = "starting"
	PhaseRunning       = "running"
	PhaseStartFailed   = "start-failed"
	PhaseCrashed       = "crashed"
)

var AllPhases = []string{
	PhaseIdle, PhaseCloning, PhaseCheckingOut, PhaseCloneFailed,
	PhaseInstalling, PhaseInstallFailed, PhaseStarting, PhaseRunning,
	PhaseStartFailed, PhaseCrashed,
}

type LifecycleState struct {
	Phase       string
	To          string
	Error       string
	Port        int
	HtmlSupport bool
}

func (s LifecycleState) MarshalJSON() ([]byte, error) {
	switch s.Phase {
	case PhaseIdle, PhaseCloning, PhaseInstalling, PhaseStarting, PhaseCrashed:
		return json.Marshal(map[string]any{"phase": s.Phase})
	case PhaseCheckingOut:
		return json.Marshal(map[string]any{"phase": s.Phase, "to": s.To})
	case PhaseCloneFailed, PhaseInstallFailed, PhaseStartFailed:
		return json.Marshal(map[string]any{"phase": s.Phase, "error": s.Error})
	case PhaseRunning:
		return json.Marshal(map[string]any{
			"phase":       s.Phase,
			"port":        s.Port,
			"htmlSupport": s.HtmlSupport,
		})
	}
	return nil, fmt.Errorf("unknown lifecycle phase: %q", s.Phase)
}

type BranchMetaReady struct {
	Branch           string `json:"branch"`
	Base             string `json:"base"`
	WorkingTreeDirty bool   `json:"workingTreeDirty"`
	Unpushed         int    `json:"unpushed"`
	AheadOfBase      int    `json:"aheadOfBase"`
	BehindBase       int    `json:"behindBase"`
	HeadSha          string `json:"headSha"`
}

type BranchMeta struct {
	Kind  string
	Ready *BranchMetaReady
}

func (m BranchMeta) MarshalJSON() ([]byte, error) {
	if m.Kind == "ready" && m.Ready != nil {
		return json.Marshal(struct {
			Kind string `json:"kind"`
			BranchMetaReady
		}{Kind: "ready", BranchMetaReady: *m.Ready})
	}
	return json.Marshal(map[string]string{"kind": "unknown"})
}

type DaemonStatus struct {
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

type ActiveTaskSummary struct {
	ID      string `json:"id"`
	Command string `json:"command"`
	LogName string `json:"logName,omitempty"`
}
