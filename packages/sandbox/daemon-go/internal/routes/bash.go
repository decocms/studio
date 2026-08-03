package routes

import (
	"net/http"

	"github.com/decocms/studio/sandbox-daemon/internal/httpx"
	"github.com/decocms/studio/sandbox-daemon/internal/proc"
)

const (
	bashDefaultTimeoutMs    = 30_000
	bashAwaitCeilingMs      = 120_000
	bashBackgroundCeilingMs = 15 * 60 * 1000
)

type BashDeps struct {
	RepoDir     string
	TaskManager *proc.TaskManager
}

func awaitTaskResponse(w http.ResponseWriter, tm *proc.TaskManager, id string, extra map[string]any, timedOutExitCode *int) {
	result, ok := tm.Finished(id)
	if !ok {
		httpx.Error(w, 500, "task vanished before completion")
		return
	}
	out, _ := tm.Output(id)
	exitCode := result.ExitCode
	if timedOutExitCode != nil && result.TimedOut {
		exitCode = *timedOutExitCode
	}
	resp := map[string]any{
		"stdout":    out.Stdout,
		"stderr":    out.Stderr,
		"exitCode":  exitCode,
		"timedOut":  result.TimedOut,
		"truncated": out.Truncated,
	}
	for k, v := range extra {
		resp[k] = v
	}
	httpx.JSON(w, 200, resp)
}

func Bash(deps BashDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Command string            `json:"command"`
			Timeout int               `json:"timeout"`
			Cwd     string            `json:"cwd"`
			Env     map[string]string `json:"env"`
			Mode    string            `json:"mode"`
		}
		if err := decodeBody(r, &body); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		if body.Command == "" {
			httpx.Error(w, 400, "command is required")
			return
		}
		mode := "await"
		if body.Mode == "background" {
			mode = "background"
		}
		timeout := bashDefaultTimeoutMs
		if body.Timeout > 0 {
			timeout = body.Timeout
		}
		ceiling := bashAwaitCeilingMs
		if mode == "background" {
			ceiling = bashBackgroundCeilingMs
		}
		if timeout > ceiling {
			timeout = ceiling
		}
		cwd := deps.RepoDir
		if body.Cwd != "" {
			cwd = body.Cwd
		}

		task := deps.TaskManager.Spawn(proc.TaskSpec{
			Command:   body.Command,
			Cwd:       cwd,
			Env:       body.Env,
			Mode:      "pipe",
			TimeoutMs: timeout,
			Label:     "$ " + body.Command,
		})

		if mode == "background" {
			httpx.JSON(w, 200, map[string]any{"taskId": task.ID, "status": task.Status})
			return
		}
		timedOut := -1
		awaitTaskResponse(w, deps.TaskManager, task.ID, nil, &timedOut)
	}
}
