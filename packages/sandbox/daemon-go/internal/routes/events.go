package routes

import (
	"net/http"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/events"
)

const (
	MaxSseClients       = 100
	heartbeatInterval   = 15 * time.Second
	ReplayBytesCapacity = 256 * 1024
)

type EventsDeps struct {
	Broadcaster          *events.Broadcaster
	GetLifecycle         func() events.LifecycleState
	GetDiscoveredScripts func() ([]string, bool)
	GetActiveTasks       func() []events.ActiveTaskSummary
	GetStatus            func() events.DaemonStatus
	GetBranchMeta        func() events.BranchMeta
	// GetDecofileVersion returns the last announced draft decofile version,
	// ok=false when none has been computed yet this boot.
	GetDecofileVersion func() (string, bool)
	// OnDecofileVersionUnknown is called (after this client is registered) when
	// GetDecofileVersion reports none cached, so a daemon restarted over an
	// already-cloned tree computes and broadcasts one instead of leaving a
	// connecting client waiting forever.
	OnDecofileVersionUnknown func()
}

// EventsStream serves the daemon SSE stream. Handshake order is contract:
// lifecycle → per-source log replay → scripts → tasks → status → branch →
// decofile.
func EventsStream(deps EventsDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if deps.Broadcaster.Size() >= MaxSseClients {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.WriteHeader(429)
			w.Write([]byte("Too many connections"))
			return
		}

		h := w.Header()
		h.Set("Content-Type", "text/event-stream")
		h.Set("Cache-Control", "no-cache")
		h.Set("Connection", "keep-alive")
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("X-Accel-Buffering", "no")
		h.Set("Content-Encoding", "identity")
		w.WriteHeader(200)
		flusher, _ := w.(http.Flusher)
		flush := func() {
			if flusher != nil {
				flusher.Flush()
			}
		}

		write := func(frame []byte) bool {
			_, err := w.Write(frame)
			return err == nil
		}

		if !write(events.SseFrame("lifecycle", map[string]any{"state": deps.GetLifecycle()})) {
			return
		}
		for _, entry := range deps.Broadcaster.ReplaySnapshot() {
			if !write(events.SseFrame("log", map[string]string{"source": entry.Source, "data": entry.Data})) {
				return
			}
		}
		if scripts, ok := deps.GetDiscoveredScripts(); ok {
			if !write(events.SseFrame("scripts", map[string]any{"scripts": scripts})) {
				return
			}
		}
		tasks := deps.GetActiveTasks()
		if tasks == nil {
			tasks = []events.ActiveTaskSummary{}
		}
		if !write(events.SseFrame("tasks", map[string]any{"active": tasks})) {
			return
		}
		if !write(events.SseFrame("status", deps.GetStatus())) {
			return
		}
		if !write(events.SseFrame("branch", map[string]any{"meta": deps.GetBranchMeta()})) {
			return
		}

		// Register before checking the decofile version: when none is cached
		// yet, OnDecofileVersionUnknown triggers an async recompute+broadcast,
		// and this client must already be a registered listener to receive it —
		// otherwise the announcement is fired before anyone can hear it.
		client := deps.Broadcaster.Register()
		defer deps.Broadcaster.Unregister(client)

		if version, ok := deps.GetDecofileVersion(); ok {
			if !write(events.SseFrame("decofile", map[string]any{"version": version})) {
				return
			}
		} else {
			deps.OnDecofileVersionUnknown()
		}
		flush()

		heartbeat := time.NewTicker(heartbeatInterval)
		defer heartbeat.Stop()

		for {
			select {
			case frame, ok := <-client.Ch:
				if !ok {
					return
				}
				if !write(frame) {
					return
				}
				flush()
			case <-heartbeat.C:
				if !write(events.SseFrame("lifecycle", map[string]any{"state": deps.GetLifecycle()})) {
					return
				}
				flush()
			case <-r.Context().Done():
				return
			}
		}
	}
}
