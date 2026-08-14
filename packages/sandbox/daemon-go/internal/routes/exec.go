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

// resolveAwaitTimeoutMs bounds an await-mode exec's TimeoutMs. An await
// caller blocks on TaskManager.Finished, which waits on the task's done
// channel with no server-side deadline (ReadHeaderTimeout only covers
// reading the request). A script that never exits — or a caller who forgets
// timeoutMs — would otherwise hang the handler goroutine and the HTTP
// connection forever, so mirror bash.go's default+ceiling instead of
// trusting an unbounded/absent value.
func resolveAwaitTimeoutMs(timeoutMs int) int {
	if timeoutMs <= 0 {
		return bashDefaultTimeoutMs
	}
	if timeoutMs > bashAwaitCeilingMs {
		return bashAwaitCeilingMs
	}
	return timeoutMs
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
		if mode == "await" {
			body.TimeoutMs = resolveAwaitTimeoutMs(body.TimeoutMs)
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

		spec := proc.TaskSpec{
			Command:   rc.Cmd,
			Cwd:       cwd,
			Env:       env,
			Mode:      "pty",
			TimeoutMs: body.TimeoutMs,
			Label:     rc.Label,
			LogName:   name,
		}

		var task proc.TaskSummary
		if proc.IsWellKnownStarter(name) {
			// The dev server is already up — hand back the task that is running
			// it instead of starting a second one. An agent that runs `dev`
			// without checking (the common case in a sandbox that was warmed
			// for it) would otherwise put two Vite/Next builds on one pod's
			// memory limit and OOM the pod out from under itself. The
			// check-and-spawn must be atomic: two concurrent requests both
			// seeing "not running" and each spawning is exactly that race.
			existing, alreadyRunning := deps.TaskManager.SpawnUnlessLogNameRunning(spec)
			if alreadyRunning {
				httpx.JSON(w, 200, map[string]any{
					"taskId":         existing.ID,
					"status":         existing.Status,
					"alreadyRunning": true,
				})
				return
			}
			task = existing
			if deps.GetStatus().State == "error" {
				deps.SetStatus(events.DaemonStatus{State: "running"})
			}
			phase := deps.Lifecycle.Current().Phase
			if phase == events.PhaseIdle || phase == events.PhaseStartFailed || phase == events.PhaseCrashed {
				deps.Lifecycle.Transition(events.LifecycleState{Phase: events.PhaseStarting})
			}
		} else {
			task = deps.TaskManager.Spawn(spec)
		}

		if mode == "background" {
			httpx.JSON(w, 200, map[string]any{"taskId": task.ID, "status": task.Status})
			return
		}
		awaitTaskResponse(w, deps.TaskManager, task.ID, map[string]any{"taskId": task.ID}, nil)
	}
}
