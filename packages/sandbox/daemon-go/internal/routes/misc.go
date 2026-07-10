package routes

import (
	"io"
	"log"
	"net/http"

	"github.com/decocms/studio/sandbox-daemon/internal/activity"
	"github.com/decocms/studio/sandbox-daemon/internal/httpx"
	"github.com/decocms/studio/sandbox-daemon/internal/orgfs"
)

type HealthDeps struct {
	DaemonBootId    string
	GetReady        func() bool
	GetOrchestrator func() OrchestratorState
	GetConfigured   func() bool
}

func Health(deps HealthDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		orch := deps.GetOrchestrator()
		httpx.JSON(w, 200, map[string]any{
			"ready":        deps.GetReady(),
			"bootId":       deps.DaemonBootId,
			"configured":   deps.GetConfigured(),
			"orchestrator": orch,
			"setup":        map[string]any{"running": orch.Running, "done": !orch.Running},
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
}

func OrgFsConfig(deps OrgFsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			httpx.Error(w, 400, "invalid org-fs config")
			return
		}
		if orgfs.ParseConfig(raw) == nil {
			httpx.Error(w, 400, "invalid org-fs config")
			return
		}
		if deps.ConfigPath == "" {
			httpx.JSON(w, 200, map[string]any{"written": false})
			return
		}
		if err := orgfs.RelaySidecarConfig(deps.ConfigPath, raw); err != nil {
			log.Printf("[org-fs] sidecar config relay failed: %v", err)
			httpx.Error(w, 500, "relay failed")
			return
		}
		httpx.JSON(w, 200, map[string]any{"written": true})
	}
}
