package routes

import (
	"net/http"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
	"github.com/decocms/studio/sandbox-daemon/internal/events"
	"github.com/decocms/studio/sandbox-daemon/internal/httpx"
	"github.com/decocms/studio/sandbox-daemon/internal/lifecycle"
	"github.com/decocms/studio/sandbox-daemon/internal/paths"
	"github.com/decocms/studio/sandbox-daemon/internal/proc"
	"github.com/decocms/studio/sandbox-daemon/internal/setup"
)

type ExecDeps struct {
	RepoDir     string
	Store       *config.Store
	TaskManager *proc.TaskManager
	Lifecycle   *lifecycle.Manager
	GetStatus   func() events.DaemonStatus
	SetStatus   func(events.DaemonStatus)
}

func Exec(deps ExecDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// The router unescapes the {name} wildcard for us.
		name := r.PathValue("name")
		if name == "" {
			httpx.Error(w, 400, "missing script name")
			return
		}

		cfg := deps.Store.Read()
		pmName := ""
		if cfg != nil {
			pmName = cfg.PmName()
		}
		if pmName == "" {
			httpx.Error(w, 409, "no application configured; POST /config first")
			return
		}
		pmConf, ok := setup.PackageManagers[pmName]
		if !ok {
			httpx.Error(w, 500, "unknown package manager: "+pmName)
			return
		}

		cwd := paths.ResolvePmRoot(deps.RepoDir, cfg.PmPath())
		scripts := proc.DiscoverScripts(cwd, pmName)
		found := false
		for _, s := range scripts {
			if s == name {
				found = true
				break
			}
		}
		if !found {
			httpx.JSON(w, 404, map[string]any{
				"error":     "script \"" + name + "\" not found in package file",
				"available": scripts,
			})
			return
		}

		var body struct {
			Mode      string            `json:"mode"`
			TimeoutMs int               `json:"timeoutMs"`
			Env       map[string]string `json:"env"`
		}
		decodeBody(r, &body)
		mode := "background"
		if body.Mode == "await" {
			mode = "await"
		}

		overrides := map[string]string{}
		for k, v := range cfg.Env {
			overrides[k] = v
		}
		for k, v := range body.Env {
			overrides[k] = v
		}
		env := setup.BuildDevEnv(cfg, overrides)
		rc := setup.PmRunCommand(cfg.RuntimePathPrefix, cwd, pmConf.RunPrefix, name)

		if proc.IsWellKnownStarter(name) {
			if deps.GetStatus().State == "error" {
				deps.SetStatus(events.DaemonStatus{State: "running"})
			}
			phase := deps.Lifecycle.Current().Phase
			if phase == events.PhaseIdle || phase == events.PhaseStartFailed || phase == events.PhaseCrashed {
				deps.Lifecycle.Transition(events.LifecycleState{Phase: events.PhaseStarting})
			}
		}

		task := deps.TaskManager.Spawn(proc.TaskSpec{
			Command:   rc.Cmd,
			Cwd:       cwd,
			Env:       env,
			Mode:      "pty",
			TimeoutMs: body.TimeoutMs,
			Label:     rc.Label,
			LogName:   name,
		})

		if mode == "background" {
			httpx.JSON(w, 200, map[string]any{"taskId": task.ID, "status": task.Status})
			return
		}
		awaitTaskResponse(w, deps.TaskManager, task.ID, map[string]any{"taskId": task.ID}, nil)
	}
}
