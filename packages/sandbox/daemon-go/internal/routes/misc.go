package routes

import (
	"io"
	"log/slog"
	"net/http"

	"github.com/decocms/studio/sandbox-daemon/internal/activity"
	"github.com/decocms/studio/sandbox-daemon/internal/httpx"
	"github.com/decocms/studio/sandbox-daemon/internal/orgfs"
	"github.com/decocms/studio/sandbox-daemon/pkg/protocol"
)

const (
	// maxOrgFsConfigBodyBytes bounds the POST /_sandbox/org-fs/config request body.
	// Org-fs config is small structured JSON (baseUrl, orgSlug, token, mounts array),
	// never a file transfer. Without a limit, io.ReadAll could buffer an unbounded
	// body into memory and crash the daemon, tearing down the sandbox pod on the next
	// missed health probe.
	maxOrgFsConfigBodyBytes = 64 * 1024
)

type HealthDeps struct {
	DaemonBootId    string
	GetReady        func() bool
	GetOrchestrator func() OrchestratorState
	GetConfigured   func() bool
}

// healthResponse is the wire contract plus the daemon-internal queue detail the
// e2e suite and operators read.
type healthResponse struct {
	protocol.Health
	Orchestrator OrchestratorState `json:"orchestrator"`
}

func Health(deps HealthDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		orch := deps.GetOrchestrator()
		httpx.JSON(w, 200, healthResponse{
			Health: protocol.Health{
				Ready:      deps.GetReady(),
				BootId:     deps.DaemonBootId,
				Configured: deps.GetConfigured(),
				Setup:      protocol.SetupState{Running: orch.Running, Done: !orch.Running},
			},
			Orchestrator: orch,
		})
	}
}

func Idle() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		httpx.JSON(w, 200, activity.Idle())
	}
}

func Scripts(getScripts func() []string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		scripts := getScripts()
		if scripts == nil {
			scripts = []string{}
		}
		httpx.JSON(w, 200, map[string]any{"scripts": scripts})
	}
}

func Setup(step string, resumeFrom func(step string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		resumeFrom(step)
		httpx.JSON(w, 200, map[string]any{"enqueued": step})
	}
}

type OrgFsDeps struct {
	ConfigPath string
	// OnConfig receives the validated org-fs endpoint. Called before the relay so
	// the credential is available even on a pod with no sidecar config path.
	OnConfig func(baseUrl, orgSlug, token string)
}

func OrgFsConfig(deps OrgFsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxOrgFsConfigBodyBytes))
		if err != nil {
			httpx.Error(w, 400, "invalid org-fs config")
			return
		}
		cfg := orgfs.ParseConfig(raw)
		if cfg == nil {
			httpx.Error(w, 400, "invalid org-fs config")
			return
		}
		if deps.OnConfig != nil {
			deps.OnConfig(cfg.BaseUrl, cfg.OrgSlug, cfg.Token)
		}
		if deps.ConfigPath == "" {
			httpx.JSON(w, 200, map[string]any{"written": false})
			return
		}
		if err := orgfs.RelaySidecarConfig(deps.ConfigPath, raw); err != nil {
			slog.Error("org-fs sidecar config relay failed", "err", err)
			httpx.Error(w, 500, "relay failed")
			return
		}
		httpx.JSON(w, 200, map[string]any{"written": true})
	}
}
