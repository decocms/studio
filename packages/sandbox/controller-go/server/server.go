// Package server is the controller's claim API: JSON over HTTP, served only
// over mTLS with a client certificate from the configured CA.
package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
	"github.com/decocms/studio/packages/sandbox/controller-go/runtime"
	"github.com/decocms/studio/packages/sandbox/controller-go/store"
	"github.com/decocms/studio/packages/sandbox/controller-go/studio"
)

const maxBody = 1 << 20

type Server struct {
	Registry *runtime.Registry
	Store    store.Store
	// DeleteDeadline bounds DELETE: this is a request path, and an unbounded
	// wait turns one stuck finalizer into a hung Studio request.
	DeleteDeadline time.Duration
	// Heartbeat is the SSE keepalive interval on /events.
	Heartbeat time.Duration
}

// TLS requires a client certificate signed by clientCAFile: the one Studio
// holds. Transport auth is the only auth; there is no bearer fallback.
func TLS(certFile, keyFile, clientCAFile string) (*tls.Config, error) {
	if certFile == "" || keyFile == "" || clientCAFile == "" {
		return nil, errors.New("the claim API needs a server certificate, its key and the client CA")
	}
	pair, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("server certificate: %w", err)
	}
	pool, err := studio.LoadCAs(clientCAFile)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates: []tls.Certificate{pair},
		ClientCAs:    pool,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		MinVersion:   tls.VersionTLS12,
	}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+protocol.PathHealthz, func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, protocol.HealthzResponse{OK: true})
	})
	mux.HandleFunc("GET "+protocol.PathRuntimes, s.runtimes)
	mux.HandleFunc("GET "+protocol.PathCapacity, s.capacity)
	mux.HandleFunc("GET "+protocol.PathImages, s.images)
	mux.HandleFunc("POST "+protocol.PathSandboxes, s.ensure)
	mux.HandleFunc("GET "+protocol.PathSandbox, s.status)
	mux.HandleFunc("DELETE "+protocol.PathSandbox, s.delete)
	mux.HandleFunc("PATCH "+protocol.PathLifetime, s.lifetime)
	mux.HandleFunc("POST "+protocol.PathCredentials, s.credentials)
	mux.HandleFunc("GET "+protocol.PathEvents, s.events)
	return mux
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, code protocol.ErrorCode, msg string) {
	writeJSON(w, status, protocol.ErrorResponse{Error: msg, Code: code})
}

var statusOf = map[protocol.ErrorCode]int{
	protocol.ErrBadRequest:         http.StatusBadRequest,
	protocol.ErrUnknownHandle:      http.StatusNotFound,
	protocol.ErrHandleConflict:     http.StatusConflict,
	protocol.ErrRuntimeUnreachable: http.StatusServiceUnavailable,
	protocol.ErrNoRuntime:          http.StatusServiceUnavailable,
	protocol.ErrBootstrapRejected:  http.StatusBadGateway,
	protocol.ErrClaimFailed:        http.StatusBadGateway,
	protocol.ErrClaimStalled:       http.StatusGatewayTimeout,
	protocol.ErrDaemon:             http.StatusBadGateway,
}

func writeRuntimeError(w http.ResponseWriter, err error) {
	code, re := runtime.CodeOf(err)
	status, ok := statusOf[code]
	if !ok {
		status = http.StatusInternalServerError
	}
	body := protocol.ErrorResponse{Error: err.Error(), Code: code}
	if re != nil {
		body.Error, body.Status = re.Message, re.Status
	}
	writeJSON(w, status, body)
}

func decode(w http.ResponseWriter, r *http.Request, into any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(into); err != nil {
		writeError(w, http.StatusBadRequest, protocol.ErrBadRequest, "invalid JSON body: "+err.Error())
		return false
	}
	return true
}

func (s *Server) runtimes(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, protocol.RuntimesResponse{Runtimes: s.Registry.Describe(r.Context())})
}

// capacity is Studio's admission gate: true when any available runtime has
// room. Per-runtime detail lives in /runtimes.
func (s *Server) capacity(w http.ResponseWriter, r *http.Request) {
	out := protocol.CapacityResponse{}
	for _, rt := range s.Registry.All() {
		if ok, _ := s.Registry.Available(r.Context(), rt); ok && s.Registry.Schedulable(r.Context(), rt) {
			out.Schedulable = true
			break
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) images(w http.ResponseWriter, r *http.Request) {
	out := protocol.ImagesResponse{Runtimes: []protocol.RuntimeImages{}}
	for _, rt := range s.Registry.All() {
		if ok, _ := s.Registry.Available(r.Context(), rt); !ok {
			continue
		}
		images := s.Registry.Images(r.Context(), rt)
		if images == nil {
			images = []protocol.ImageInfo{}
		}
		out.Runtimes = append(out.Runtimes, protocol.RuntimeImages{Runtime: rt.Name, Images: images})
	}
	writeJSON(w, http.StatusOK, out)
}

// owner resolves the runtime a handle lives on. A recorded row wins, and one
// naming a runtime this build lacks is unreachable, never re-placed: the
// sandbox it points at is still out there. With no row (the claim can outlive
// it, and a lifecycle watch starts before it exists) it is wherever a new
// sandbox would go.
func (s *Server) owner(ctx context.Context, handle string) (*runtime.Runtime, *store.Record, error) {
	rec, err := s.Store.ByHandle(ctx, handle)
	if err != nil {
		return nil, nil, err
	}
	if rec != nil {
		rt := s.Registry.Get(rec.Runtime)
		if rt == nil {
			return nil, rec, &runtime.Error{Code: protocol.ErrRuntimeUnreachable, Message: fmt.Sprintf("sandbox %s is recorded on runtime %q, which this controller does not run", handle, rec.Runtime)}
		}
		return rt, rec, nil
	}
	p := runtime.Place(ctx, s.Registry, protocol.EnsureRequest{})
	if p.Runtime == nil {
		return nil, nil, &runtime.Error{Code: protocol.ErrNoRuntime, Message: "no runtime is available"}
	}
	return p.Runtime, nil, nil
}

func (s *Server) ensure(w http.ResponseWriter, r *http.Request) {
	var req protocol.EnsureRequest
	if !decode(w, r, &req) {
		return
	}
	if msg := validateEnsure(req); msg != "" {
		writeError(w, http.StatusBadRequest, protocol.ErrBadRequest, msg)
		return
	}
	opts := protocol.EnsureOptions{}
	if req.Opts != nil {
		opts = *req.Opts
	}
	// Detached: a Studio request giving up must not abandon a claim mid-start
	// (its retry joins it), and the ready wait is bounded on progress anyway.
	ctx := context.WithoutCancel(r.Context())

	// Idempotent by handle. A live sandbox is returned as-is even when the
	// request names another runtime: switching is DELETE + POST, never a side
	// effect of a flipped flag.
	byID, err := s.Store.GetAnyRuntime(ctx, req.ID)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	byHandle, err := s.Store.ByHandle(ctx, req.Handle)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	if byHandle != nil && byHandle.ID != req.ID {
		// One claim name for two sandboxes. (One sandbox under a new name is the
		// runtime's to reconcile: it drops the stale row and provisions.)
		writeError(w, http.StatusConflict, protocol.ErrHandleConflict, "the handle is recorded for another sandbox id")
		return
	}
	existing := byID
	if existing == nil {
		existing = byHandle
	}
	var chosen *runtime.Runtime
	if existing != nil {
		if chosen = s.Registry.Get(existing.Runtime); chosen == nil {
			writeError(w, http.StatusServiceUnavailable, protocol.ErrRuntimeUnreachable,
				fmt.Sprintf("sandbox is recorded on runtime %q, which this controller does not run", existing.Runtime))
			return
		}
	} else {
		p := runtime.Place(ctx, s.Registry, req)
		if p.Runtime == nil {
			writeJSON(w, http.StatusServiceUnavailable, protocol.ErrorResponse{
				Error: "no runtime can place this sandbox", Code: protocol.ErrNoRuntime, Reasons: p.Reasons,
			})
			return
		}
		chosen = p.Runtime
	}

	sb, err := chosen.Provider.Ensure(ctx, req.ID, req.Handle, opts)
	if err != nil {
		slog.Error("ensure failed", "handle", req.Handle, "runtime", chosen.Name, "err", err)
		writeRuntimeError(w, err)
		return
	}
	resp := protocol.EnsureResponse{
		Handle: sb.Handle, Workdir: sb.Workdir, PreviewURL: sb.PreviewURL, Daemon: sb.Daemon,
		Runtime: chosen.Name, Image: sb.Image, WarmPoolAdopted: sb.WarmPoolAdopted, Capabilities: chosen.Capabilities,
	}
	if existing != nil && req.Runtime != "" && req.Runtime != existing.Runtime {
		resp.RuntimeMismatch = existing.Runtime
	}
	writeJSON(w, http.StatusOK, resp)
}

var (
	handlePattern = regexp.MustCompile(`^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$`)
	imagePattern  = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	knownCaps     = map[protocol.Capability]bool{
		protocol.CapPreview: true, protocol.CapLifecyclePhases: true, protocol.CapWarmPool: true,
		protocol.CapTerminationReason: true, protocol.CapTTLExtend: true, protocol.CapCapacity: true,
	}
)

// validateEnsure returns what is wrong with req, or "".
func validateEnsure(req protocol.EnsureRequest) string {
	switch {
	case req.ID.UserID == "" || req.ID.ProjectRef == "":
		return "id.userId and id.projectRef are required"
	case !handlePattern.MatchString(req.Handle):
		return "handle must be a DNS-1035 label of at most 63 characters"
	}
	for _, c := range req.Requires {
		if !knownCaps[c] {
			return fmt.Sprintf("requires: unknown capability %q", c)
		}
	}
	o := req.Opts
	if o == nil {
		return ""
	}
	switch o.Purpose {
	case "", protocol.PurposeInteractive, protocol.PurposeHarnessRun:
	default:
		return fmt.Sprintf("opts.purpose: unknown purpose %q", o.Purpose)
	}
	if o.SandboxImage != "" && !imagePattern.MatchString(o.SandboxImage) {
		return "opts.sandboxImage must match ^[a-z][a-z0-9-]{0,31}$"
	}
	if w := o.Workload; w != nil {
		switch w.Runtime {
		case protocol.RuntimeNode, protocol.RuntimeBun, protocol.RuntimeDeno:
		default:
			return fmt.Sprintf("opts.workload.runtime: unknown runtime %q", w.Runtime)
		}
		switch w.PackageManager {
		case protocol.PackageManagerNpm, protocol.PackageManagerPnpm, protocol.PackageManagerYarn, protocol.PackageManagerBun, protocol.PackageManagerDeno:
		default:
			return fmt.Sprintf("opts.workload.packageManager: unknown package manager %q", w.PackageManager)
		}
		if w.DevPort < 0 || w.DevPort > 65535 {
			return "opts.workload.devPort must be a port number"
		}
	}
	if o.Repo != nil && o.Repo.CloneURL == "" {
		return "opts.repo.cloneUrl is required"
	}
	for i, extra := range o.ExtraRepos {
		if extra.CloneURL == "" {
			return fmt.Sprintf("opts.extraRepos[%d].cloneUrl is required", i)
		}
	}
	if o.Tenant != nil && (o.Tenant.OrgID == "" || o.Tenant.UserID == "") {
		return "opts.tenant.orgId and opts.tenant.userId are required"
	}
	for k := range o.Env {
		if k == "" {
			return "opts.env keys must be non-empty"
		}
	}
	return ""
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	handle := r.PathValue("handle")
	ctx := r.Context()
	rt, _, err := s.owner(ctx, handle)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	alive, err := rt.Provider.Alive(ctx, handle)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	// Preview traffic, where a fetch is the only sign anyone is here. Opt-in:
	// every other caller wants an observation, not a side effect.
	if !alive && r.URL.Query().Get("resurrect") == "1" {
		revived, err := rt.Provider.Resurrect(context.WithoutCancel(ctx), handle)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		alive = revived
	}
	desc, err := rt.Provider.Describe(ctx, handle)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	termination, _ := rt.Provider.LastTermination(ctx, handle)
	writeJSON(w, http.StatusOK, protocol.StatusResponse{
		Handle: handle, Alive: alive, PreviewURL: desc.PreviewURL, Daemon: desc.Daemon, Runtime: rt.Name,
		Image: desc.Image, Capabilities: rt.Capabilities, LastTermination: termination,
	})
}

// delete waits for the sandbox to be gone (204), up to DeleteDeadline (202
// draining, which means retry, not success).
func (s *Server) delete(w http.ResponseWriter, r *http.Request) {
	handle := r.PathValue("handle")
	rt, _, err := s.owner(r.Context(), handle)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), s.DeleteDeadline)
	defer cancel()
	if err := rt.Provider.Delete(ctx, handle); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			writeJSON(w, http.StatusAccepted, protocol.DrainingResponse{State: "draining"})
			return
		}
		writeRuntimeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) lifetime(w http.ResponseWriter, r *http.Request) {
	handle := r.PathValue("handle")
	var req protocol.LifetimeRequest
	if !decode(w, r, &req) {
		return
	}
	if req.ExtendToIdleWindow == (req.GraceMs != nil) {
		writeError(w, http.StatusBadRequest, protocol.ErrBadRequest, "exactly one of extendToIdleWindow or graceMs is required")
		return
	}
	if req.GraceMs != nil && *req.GraceMs < 0 {
		writeError(w, http.StatusBadRequest, protocol.ErrBadRequest, "graceMs must not be negative")
		return
	}
	rt, _, err := s.owner(r.Context(), handle)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	if req.GraceMs != nil {
		err = rt.Provider.ReleaseAfter(r.Context(), handle, time.Duration(*req.GraceMs)*time.Millisecond)
	} else {
		err = rt.Provider.RenewTTL(r.Context(), handle)
	}
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) credentials(w http.ResponseWriter, r *http.Request) {
	handle := r.PathValue("handle")
	var req protocol.CredentialsRequest
	if !decode(w, r, &req) {
		return
	}
	if req.CloneURL == "" {
		writeError(w, http.StatusBadRequest, protocol.ErrBadRequest, "cloneUrl is required")
		return
	}
	rt, rec, err := s.owner(r.Context(), handle)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	if rec == nil {
		writeError(w, http.StatusNotFound, protocol.ErrUnknownHandle, "no sandbox recorded under "+handle)
		return
	}
	if err := rt.Provider.RotateCredential(r.Context(), handle, req.CloneURL); err != nil {
		writeRuntimeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// events is SSE: one `data: <Phase>` per transition, ending after a terminal
// phase. Comments keep idle proxies from closing a long wait.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	handle := r.PathValue("handle")
	rt, _, err := s.owner(r.Context(), handle)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	phases, err := rt.Provider.Watch(r.Context(), handle)
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	w.Header().Set("content-type", "text/event-stream")
	w.Header().Set("cache-control", "no-cache")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	flush := func() {
		if flusher != nil {
			flusher.Flush()
		}
	}
	flush()
	heartbeat := s.Heartbeat
	if heartbeat <= 0 {
		heartbeat = 15 * time.Second
	}
	tick := time.NewTicker(heartbeat)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			flush()
		case p, ok := <-phases:
			if !ok {
				return
			}
			blob, err := json.Marshal(p)
			if err != nil {
				continue
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", blob); err != nil {
				return
			}
			flush()
		}
	}
}
