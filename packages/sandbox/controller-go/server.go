package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/decocms/studio/sandbox-controller/protocol"
	"github.com/decocms/studio/sandbox-controller/runtime"
	"github.com/decocms/studio/sandbox-controller/store"
)

type server struct {
	registry *runtime.Registry
	store    *store.Store
	// bearer is the fallback where mTLS is not configured. With client certs
	// the handshake has already rejected an unknown peer.
	bearer string
	// mTLS is set when the listener verifies client certificates, which makes
	// the bearer redundant rather than absent.
	mTLS bool
	// drainDeadline bounds DELETE. This is a request path: an unbounded wait
	// turns one stuck claim into a hung studio request and a burnt DBOS step.
	drainDeadline time.Duration
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	if body != nil {
		_ = json.NewEncoder(w).Encode(body)
	}
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, protocol.ErrorResponse{Error: msg})
}

// authorized gates every route but /healthz. mTLS is the intended posture and
// the bearer the fallback; with neither configured run() refuses to start.
func (s *server) authorized(r *http.Request) bool {
	if s.mTLS {
		// RequireAndVerifyClientCert already ran in the handshake.
		return true
	}
	if s.bearer == "" {
		// Neither configured: run() only reaches here under
		// SANDBOX_CONTROLLER_INSECURE=1, which means serve anonymously. Without
		// this the opt-out boots and then 401s every request.
		return true
	}
	header := r.Header.Get("authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(header, "Bearer ")), []byte(s.bearer)) == 1
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /runtimes", s.guard(s.handleRuntimes))
	mux.HandleFunc("GET /capacity", s.guard(s.handleCapacity))
	mux.HandleFunc("POST /sandboxes", s.guard(s.handleEnsure))
	mux.HandleFunc("GET /sandboxes/{handle}", s.guard(s.handleStatus))
	mux.HandleFunc("DELETE /sandboxes/{handle}", s.guard(s.handleDelete))
	mux.HandleFunc("PATCH /sandboxes/{handle}/lifetime", s.guard(s.handleLifetime))
	mux.HandleFunc("POST /sandboxes/{handle}/adopt", s.guard(s.handleAdopt))
	mux.HandleFunc("GET /sandboxes/{handle}/events", s.guard(s.handleEvents))
	return mux
}

func (s *server) guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			writeErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	}
}

func (s *server) handleRuntimes(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, protocol.RuntimesResponse{Runtimes: s.registry.Describe(r.Context())})
}

// handleCapacity is what studio's admission gate reads: an aggregate, true if
// ANY runtime that could serve the request has room. Per-runtime detail lives
// in /runtimes.
func (s *server) handleCapacity(w http.ResponseWriter, r *http.Request) {
	for _, rt := range s.registry.All() {
		if ok, _ := s.registry.Available(r.Context(), rt); ok && s.registry.Schedulable(r.Context(), rt) {
			writeJSON(w, http.StatusOK, protocol.CapacityResponse{Schedulable: true})
			return
		}
	}
	writeJSON(w, http.StatusOK, protocol.CapacityResponse{Schedulable: false})
}

// ownerOf resolves the runtime that owns a handle.
//
// A recorded row always wins, and a row naming a runtime this build does not
// know is reported unreachable rather than re-placed: that means a rollback,
// and the sandbox it points at is still out there.
//
// No row at all is a different, normal case — the lifecycle watch starts
// before the claim exists, and alive/delete outlive the row — so it falls back
// to where a sandbox would be placed now.
func (s *server) ownerOf(ctx context.Context, handle string) (*runtime.Runtime, bool) {
	rec, err := s.store.ByHandle(ctx, handle)
	if err == nil && rec != nil {
		rt := s.registry.Get(rec.Runtime)
		return rt, rt != nil
	}
	placement := runtime.Place(ctx, s.registry, protocol.EnsureRequest{})
	return placement.Runtime, placement.Runtime != nil
}

func (s *server) handleEnsure(w http.ResponseWriter, r *http.Request) {
	var req protocol.EnsureRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.ID.UserID == "" || req.ID.ProjectRef == "" {
		writeErr(w, http.StatusBadRequest, "id.userId and id.projectRef are required")
		return
	}
	// Handles stay studio-derived and are passed in: studio recomputes them
	// without a database read to route preview traffic, and a handle that can
	// disagree with itself is a bug this codebase has already paid for.
	handle := r.URL.Query().Get("handle")
	if handle == "" {
		writeErr(w, http.StatusBadRequest, "handle query parameter is required")
		return
	}
	ctx := r.Context()

	// Idempotent by handle. An existing sandbox comes back as-is even when the
	// request names another runtime — switching is the caller's explicit
	// DELETE + POST, never implicit, or a flag flip would kill a live dev
	// server to satisfy a routine ensure.
	var owner *runtime.Runtime
	if rec, err := s.store.GetAnyRuntime(ctx, req.ID); err == nil && rec != nil {
		owner = s.registry.Get(rec.Runtime)
	}
	if owner == nil {
		if rec, err := s.store.ByHandle(ctx, handle); err == nil && rec != nil {
			owner = s.registry.Get(rec.Runtime)
		}
	}

	chosen := owner
	if chosen == nil {
		placement := runtime.Place(ctx, s.registry, req)
		if placement.Runtime == nil {
			writeJSON(w, http.StatusServiceUnavailable, protocol.ErrorResponse{
				Error:   "no runtime can place this sandbox",
				Reasons: placement.Reasons,
			})
			return
		}
		chosen = placement.Runtime
	}

	sandbox, err := chosen.Provider.Ensure(ctx, req.ID, handle, req.Opts)
	if err != nil {
		slog.Error("ensure failed", "handle", handle, "runtime", chosen.Name, "err", err)
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	resp := protocol.EnsureResponse{
		Handle:       sandbox.Handle,
		Workdir:      sandbox.Workdir,
		PreviewURL:   sandbox.PreviewURL,
		Daemon:       sandbox.Daemon,
		Runtime:      chosen.Name,
		Capabilities: chosen.Capabilities,
	}
	// Only an EXISTING handle elsewhere is a mismatch; a fallback placement is not.
	if owner != nil && req.Runtime != "" && req.Runtime != owner.Name {
		resp.RuntimeMismatch = owner.Name
	}
	writeJSON(w, http.StatusOK, resp)
}

// resurrector brings an evicted sandbox back from its persisted options.
// Optional, not part of Provider: no idle reaper means nothing to resurrect.
type resurrector interface {
	Resurrect(ctx context.Context, handle string) (bool, error)
}

func (s *server) handleStatus(w http.ResponseWriter, r *http.Request) {
	handle := r.PathValue("handle")
	ctx := r.Context()
	rt, ok := s.ownerOf(ctx, handle)
	if !ok {
		writeErr(w, http.StatusNotFound, "unknown handle")
		return
	}
	alive, err := rt.Provider.Alive(ctx, handle)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// `?resurrect=1` is preview traffic, where a fetch is the only sign anyone
	// is here. Opt-in: every other caller wants an observation, not a side effect.
	if !alive && r.URL.Query().Get("resurrect") == "1" {
		if rr, canRevive := rt.Provider.(resurrector); canRevive {
			revived, err := rr.Resurrect(ctx, handle)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, err.Error())
				return
			}
			alive = revived
		}
	}
	preview, _ := rt.Provider.PreviewURL(ctx, handle)
	daemon, _ := rt.Provider.Daemon(ctx, handle)
	termination, _ := rt.Provider.LastTermination(ctx, handle)
	writeJSON(w, http.StatusOK, protocol.StatusResponse{
		Handle:          handle,
		Alive:           alive,
		PreviewURL:      preview,
		Daemon:          daemon,
		Runtime:         rt.Name,
		Capabilities:    rt.Capabilities,
		LastTermination: termination,
	})
}

// handleDelete blocks until the sandbox is gone, then 204. On the deadline it
// answers 202 {"state":"draining"} — which means retry, NOT success: a caller
// mid-rebind must not POST on it, or two daemons end up on one git branch.
func (s *server) handleDelete(w http.ResponseWriter, r *http.Request) {
	handle := r.PathValue("handle")
	rt, ok := s.ownerOf(r.Context(), handle)
	if !ok {
		writeErr(w, http.StatusNotFound, "unknown handle")
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), s.drainDeadline)
	defer cancel()
	if err := rt.Provider.Delete(ctx, handle); err != nil {
		if ctx.Err() != nil {
			writeJSON(w, http.StatusAccepted, map[string]string{"state": "draining"})
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleLifetime(w http.ResponseWriter, r *http.Request) {
	handle := r.PathValue("handle")
	var req protocol.LifetimeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	rt, ok := s.ownerOf(r.Context(), handle)
	if !ok {
		writeErr(w, http.StatusNotFound, "unknown handle")
		return
	}
	var err error
	switch {
	case req.GraceMs != nil:
		err = rt.Provider.ReleaseAfter(r.Context(), handle, time.Duration(*req.GraceMs)*time.Millisecond)
	case req.ExtendToIdleWindow:
		err = rt.Provider.RenewTTL(r.Context(), handle)
	default:
		writeErr(w, http.StatusBadRequest, "one of extendToIdleWindow or graceMs is required")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleAdopt(w http.ResponseWriter, r *http.Request) {
	handle := r.PathValue("handle")
	var req protocol.AdoptRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	rt, ok := s.ownerOf(r.Context(), handle)
	if !ok {
		writeErr(w, http.StatusNotFound, "unknown handle")
		return
	}
	adopted, err := rt.Provider.Adopt(r.Context(), req.ID, handle)
	if err != nil {
		slog.Warn("adopt failed", "handle", handle, "err", err)
	}
	writeJSON(w, http.StatusOK, protocol.AdoptResponse{Adopted: adopted})
}

func (s *server) handleEvents(w http.ResponseWriter, r *http.Request) {
	handle := r.PathValue("handle")
	rt, ok := s.ownerOf(r.Context(), handle)
	if !ok {
		writeErr(w, http.StatusNotFound, "unknown handle")
		return
	}
	phases, err := rt.Provider.Watch(r.Context(), handle)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("content-type", "text/event-stream")
	w.Header().Set("cache-control", "no-cache")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	for phase := range phases {
		blob, err := json.Marshal(phase)
		if err != nil {
			continue
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", blob); err != nil {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
	}
}
