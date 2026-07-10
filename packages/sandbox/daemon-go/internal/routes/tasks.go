package routes

import (
	"net/http"
	"strings"
	"syscall"

	"github.com/decocms/studio/sandbox-daemon/internal/events"
	"github.com/decocms/studio/sandbox-daemon/internal/httpx"
	"github.com/decocms/studio/sandbox-daemon/internal/proc"
)

type TasksDeps struct {
	TaskManager *proc.TaskManager
}

func taskIdFrom(path, prefix, suffix string) string {
	idx := strings.Index(path, prefix)
	if idx < 0 {
		return ""
	}
	id := path[idx+len(prefix):]
	if suffix != "" && strings.HasSuffix(id, suffix) {
		id = id[:len(id)-len(suffix)]
	}
	if id == "" || strings.Contains(id, "/") {
		return ""
	}
	return id
}

func TasksList(deps TasksDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var statuses []string
		if raw := r.URL.Query().Get("status"); raw != "" {
			for _, s := range strings.Split(raw, ",") {
				if proc.ValidStatuses[s] {
					statuses = append(statuses, s)
				}
			}
		}
		httpx.JSON(w, 200, map[string]any{"tasks": deps.TaskManager.List(statuses)})
	}
}

func TasksGet(deps TasksDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := taskIdFrom(r.URL.Path, "/tasks/", "")
		if id == "" {
			httpx.Error(w, 400, "missing task id")
			return
		}
		summary, ok := deps.TaskManager.Get(id)
		if !ok {
			httpx.Error(w, 404, "task not found")
			return
		}
		out, _ := deps.TaskManager.Output(id)
		httpx.JSON(w, 200, map[string]any{
			"id": summary.ID, "command": summary.Command, "status": summary.Status,
			"exitCode": summary.ExitCode, "startedAt": summary.StartedAt,
			"finishedAt": summary.FinishedAt, "timedOut": summary.TimedOut,
			"logName": omitEmpty(summary.LogName), "intentional": summary.Intentional,
			"stdout": out.Stdout, "stderr": out.Stderr, "truncated": out.Truncated,
		})
	}
}

func omitEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func TasksKill(deps TasksDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := taskIdFrom(r.URL.Path, "/tasks/", "/kill")
		if id == "" {
			httpx.Error(w, 400, "missing task id")
			return
		}
		sig := syscall.SIGTERM
		if r.URL.Query().Get("signal") == "SIGKILL" {
			sig = syscall.SIGKILL
		}
		if !deps.TaskManager.Kill(id, sig) {
			httpx.Error(w, 400, "task not running")
			return
		}
		httpx.JSON(w, 200, map[string]any{"ok": true})
	}
}

func TasksKillAll(deps TasksDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		count := deps.TaskManager.KillAll()
		httpx.JSON(w, 200, map[string]any{"ok": true, "killed": count})
	}
}

func TasksDelete(deps TasksDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := taskIdFrom(r.URL.Path, "/tasks/", "")
		if id == "" {
			httpx.Error(w, 400, "missing task id")
			return
		}
		if !deps.TaskManager.Delete(id) {
			httpx.Error(w, 400, "task not found or still running")
			return
		}
		httpx.JSON(w, 200, map[string]any{"ok": true})
	}
}

func TasksStream(deps TasksDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := taskIdFrom(r.URL.Path, "/tasks/", "/stream")
		if id == "" {
			httpx.Error(w, 400, "missing task id")
			return
		}
		summary, ok := deps.TaskManager.Get(id)
		if !ok {
			httpx.Error(w, 404, "task not found")
			return
		}

		h := w.Header()
		h.Set("Content-Type", "text/event-stream")
		h.Set("Cache-Control", "no-cache")
		h.Set("Connection", "keep-alive")
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("X-Accel-Buffering", "no")
		w.WriteHeader(200)
		flusher, _ := w.(http.Flusher)

		send := func(event string, payload any) {
			w.Write(events.SseFrame(event, payload))
			if flusher != nil {
				flusher.Flush()
			}
		}

		out, _ := deps.TaskManager.Output(id)
		if out.Stdout != "" {
			send("stdout", map[string]string{"data": out.Stdout})
		}
		if out.Stderr != "" {
			send("stderr", map[string]string{"data": out.Stderr})
		}
		if summary.Status != proc.StatusRunning {
			send("end", map[string]any{
				"status": summary.Status, "exitCode": summary.ExitCode, "timedOut": summary.TimedOut,
			})
			return
		}

		chunks := make(chan proc.OutputChunk, 256)
		unsubscribe, ok := deps.TaskManager.Subscribe(id, func(c proc.OutputChunk) {
			select {
			case chunks <- c:
			default:
			}
		})
		if !ok {
			send("end", map[string]any{"status": summary.Status})
			return
		}
		defer unsubscribe()

		finished := make(chan proc.TaskResult, 1)
		go func() {
			result, ok := deps.TaskManager.Finished(id)
			if ok {
				finished <- result
			}
		}()

		for {
			select {
			case c := <-chunks:
				send(c.Stream, map[string]string{"data": c.Data})
			case result := <-finished:
				for {
					select {
					case c := <-chunks:
						send(c.Stream, map[string]string{"data": c.Data})
						continue
					default:
					}
					break
				}
				send("end", map[string]any{
					"status": result.Status, "exitCode": result.ExitCode, "timedOut": result.TimedOut,
				})
				return
			case <-r.Context().Done():
				return
			}
		}
	}
}
