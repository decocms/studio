// Package server is the controller's claim API: MCP tools over streamable
// HTTP, served only over mTLS with a client certificate from the configured CA.
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

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
	"github.com/decocms/studio/packages/sandbox/controller-go/runtime"
	"github.com/decocms/studio/packages/sandbox/controller-go/store"
	"github.com/decocms/studio/packages/sandbox/controller-go/studio"
)

const maxBody = 1 << 20

type Server struct {
	Registry *runtime.Registry
	Store    store.Store
	// DeleteDeadline bounds SANDBOX_DELETE: this is a request path, and an
	// unbounded wait turns one stuck finalizer into a hung Studio request.
	DeleteDeadline time.Duration
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

// Handler serves the tools at PathMCP and a health check.
func (s *Server) Handler() http.Handler {
	tools := mcp.NewServer(&mcp.Implementation{Name: "sandbox-controller"}, nil)
	addTool(tools, protocol.ToolEnsure, "Provision a sandbox, or return the live one, once its daemon is ready.", s.ensure)
	addTool(tools, protocol.ToolStatus, "Whether a sandbox is alive, where its daemon is, and why it last stopped.", s.status)
	addTool(tools, protocol.ToolDelete, "Delete a sandbox and wait for it to be gone.", s.delete)
	addTool(tools, protocol.ToolLifetime, "Move a sandbox's idle shutdown.", s.lifetime)
	addTool(tools, protocol.ToolCredentials, "Rotate a sandbox's clone credential in place.", s.credentials)
	addTool(tools, protocol.ToolWatch, "Report a sandbox's lifecycle phases until ready or failed.", s.watch)
	addTool(tools, protocol.ToolImages, "The sandbox images each available runtime serves.", s.images)
	addTool(tools, protocol.ToolRuntimes, "Every runtime, its availability and capabilities.", s.runtimes)
	addTool(tools, protocol.ToolCapacity, "Whether any available runtime has room for the image.", s.capacity)
	addTool(tools, protocol.ToolTenantPoolsPush, "Refresh the tenant pools warmed on a pushed repo and branch now.", s.tenantPoolsPush)

	mux := http.NewServeMux()
	mux.HandleFunc("GET "+protocol.PathHealthz, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(protocol.HealthzResponse{OK: true})
	})
	mux.Handle(protocol.PathMCP, mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return tools },
		&mcp.StreamableHTTPOptions{Stateless: true},
	))
	return http.MaxBytesHandler(mux, maxBody)
}

// toolError is a failure whose ErrorResponse is already worded.
type toolError struct{ body protocol.ErrorResponse }

func (e *toolError) Error() string { return e.body.Error }

func fail(code protocol.ErrorCode, msg string) error {
	return &toolError{protocol.ErrorResponse{Error: msg, Code: code}}
}

// errorResult carries the ErrorResponse as the text content, not as
// structuredContent: clients validate that against the output schema.
func errorResult(err error) *mcp.CallToolResult {
	var te *toolError
	body := protocol.ErrorResponse{Error: err.Error()}
	if errors.As(err, &te) {
		body = te.body
	} else {
		code, re := runtime.CodeOf(err)
		body.Code = code
		if re != nil {
			body.Error, body.Status = re.Message, re.Status
		}
	}
	blob, _ := json.Marshal(body)
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: string(blob)}}}
}

// addTool registers fn with schemas inferred from In and Out. Inputs accept
// unknown fields, as the JSON API did, so a newer Studio can talk to an older
// controller during a rollout.
func addTool[In, Out any](srv *mcp.Server, name, description string, fn func(context.Context, *mcp.CallToolRequest, In) (Out, error)) {
	in, err := jsonschema.For[In](nil)
	if err != nil {
		panic(fmt.Sprintf("%s input schema: %v", name, err))
	}
	openObjects(in)
	out, err := jsonschema.For[Out](nil)
	if err != nil {
		panic(fmt.Sprintf("%s output schema: %v", name, err))
	}
	mcp.AddTool(srv, &mcp.Tool{Name: name, Description: description, InputSchema: in, OutputSchema: out},
		func(ctx context.Context, req *mcp.CallToolRequest, args In) (*mcp.CallToolResult, any, error) {
			v, err := fn(ctx, req, args)
			if err != nil {
				return errorResult(err), nil, nil
			}
			blob, err := json.Marshal(v)
			if err != nil {
				return nil, nil, err
			}
			return &mcp.CallToolResult{
				StructuredContent: json.RawMessage(blob),
				Content:           []mcp.Content{&mcp.TextContent{Text: string(blob)}},
			}, nil, nil
		})
}

func openObjects(s *jsonschema.Schema) {
	if s == nil {
		return
	}
	if s.Properties != nil {
		s.AdditionalProperties = nil
	}
	for _, p := range s.Properties {
		openObjects(p)
	}
	openObjects(s.Items)
	openObjects(s.AdditionalProperties)
}

func (s *Server) runtimes(ctx context.Context, _ *mcp.CallToolRequest, _ protocol.Empty) (protocol.RuntimesResponse, error) {
	return protocol.RuntimesResponse{Runtimes: s.Registry.Describe(ctx)}, nil
}

// capacity is Studio's admission gate: true when any available runtime has
// room for the image. Per-runtime detail lives in SANDBOX_RUNTIMES.
func (s *Server) capacity(ctx context.Context, _ *mcp.CallToolRequest, req protocol.CapacityRequest) (protocol.CapacityResponse, error) {
	if req.SandboxImage != "" && !imagePattern.MatchString(req.SandboxImage) {
		return protocol.CapacityResponse{}, fail(protocol.ErrBadRequest, "sandboxImage must match "+imagePattern.String())
	}
	for _, rt := range s.Registry.All() {
		if ok, _ := s.Registry.Available(ctx, rt); ok && s.Registry.Schedulable(ctx, rt, req.SandboxImage) {
			return protocol.CapacityResponse{Schedulable: true}, nil
		}
	}
	return protocol.CapacityResponse{}, nil
}

func (s *Server) images(ctx context.Context, _ *mcp.CallToolRequest, _ protocol.Empty) (protocol.ImagesResponse, error) {
	out := protocol.ImagesResponse{Runtimes: []protocol.RuntimeImages{}}
	for _, rt := range s.Registry.All() {
		if ok, _ := s.Registry.Available(ctx, rt); !ok {
			continue
		}
		images := s.Registry.Images(ctx, rt)
		if images == nil {
			images = []protocol.ImageInfo{}
		}
		out.Runtimes = append(out.Runtimes, protocol.RuntimeImages{Runtime: rt.Name, Images: images})
	}
	return out, nil
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

func (s *Server) ensure(ctx context.Context, _ *mcp.CallToolRequest, req protocol.EnsureRequest) (protocol.EnsureResponse, error) {
	var none protocol.EnsureResponse
	if msg := validateEnsure(req); msg != "" {
		return none, fail(protocol.ErrBadRequest, msg)
	}
	opts := protocol.EnsureOptions{}
	if req.Opts != nil {
		opts = *req.Opts
	}
	// Detached: a Studio request giving up must not abandon a claim mid-start
	// (its retry joins it), and the ready wait is bounded on progress anyway.
	ctx = context.WithoutCancel(ctx)

	// Idempotent by handle. A live sandbox is returned as-is even when the
	// request names another runtime: switching is delete + ensure, never a
	// side effect of a flipped flag.
	byID, err := s.Store.GetAnyRuntime(ctx, req.ID)
	if err != nil {
		return none, err
	}
	byHandle, err := s.Store.ByHandle(ctx, req.Handle)
	if err != nil {
		return none, err
	}
	if byHandle != nil && byHandle.ID != req.ID {
		// One claim name for two sandboxes. (One sandbox under a new name is the
		// runtime's to reconcile: it drops the stale row and provisions.)
		return none, fail(protocol.ErrHandleConflict, "the handle is recorded for another sandbox id")
	}
	existing := byID
	if existing == nil {
		existing = byHandle
	}
	var chosen *runtime.Runtime
	if existing != nil {
		if chosen = s.Registry.Get(existing.Runtime); chosen == nil {
			return none, fail(protocol.ErrRuntimeUnreachable,
				fmt.Sprintf("sandbox is recorded on runtime %q, which this controller does not run", existing.Runtime))
		}
	} else {
		p := runtime.Place(ctx, s.Registry, req)
		if p.Runtime == nil {
			return none, &toolError{protocol.ErrorResponse{
				Error: "no runtime can place this sandbox", Code: protocol.ErrNoRuntime, Reasons: p.Reasons,
			}}
		}
		chosen = p.Runtime
	}

	sb, err := chosen.Provider.Ensure(ctx, req.ID, req.Handle, opts)
	if err != nil {
		slog.Error("ensure failed", "handle", req.Handle, "runtime", chosen.Name, "err", err)
		return none, err
	}
	resp := protocol.EnsureResponse{
		Handle: sb.Handle, Workdir: sb.Workdir, PreviewURL: sb.PreviewURL, Daemon: sb.Daemon,
		Runtime: chosen.Name, Image: sb.Image, WarmPoolAdopted: sb.WarmPoolAdopted, Capabilities: chosen.Capabilities,
	}
	if existing != nil && req.Runtime != "" && req.Runtime != existing.Runtime {
		resp.RuntimeMismatch = existing.Runtime
	}
	return resp, nil
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

func (s *Server) status(ctx context.Context, _ *mcp.CallToolRequest, req protocol.StatusRequest) (protocol.StatusResponse, error) {
	var none protocol.StatusResponse
	rt, _, err := s.owner(ctx, req.Handle)
	if err != nil {
		return none, err
	}
	alive, err := rt.Provider.Alive(ctx, req.Handle)
	if err != nil {
		return none, err
	}
	if !alive && req.Resurrect {
		if alive, err = rt.Provider.Resurrect(context.WithoutCancel(ctx), req.Handle); err != nil {
			return none, err
		}
	}
	desc, err := rt.Provider.Describe(ctx, req.Handle)
	if err != nil {
		return none, err
	}
	termination, _ := rt.Provider.LastTermination(ctx, req.Handle)
	return protocol.StatusResponse{
		Handle: req.Handle, Alive: alive, PreviewURL: desc.PreviewURL, Daemon: desc.Daemon, Runtime: rt.Name,
		Image: desc.Image, Capabilities: rt.Capabilities, LastTermination: termination,
	}, nil
}

// delete waits for the sandbox to be gone, up to DeleteDeadline; past it the
// answer is draining, which means retry, not success.
func (s *Server) delete(ctx context.Context, _ *mcp.CallToolRequest, req protocol.HandleRequest) (protocol.DeleteResponse, error) {
	rt, _, err := s.owner(ctx, req.Handle)
	if err != nil {
		return protocol.DeleteResponse{}, err
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.DeleteDeadline)
	defer cancel()
	if err := rt.Provider.Delete(ctx, req.Handle); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return protocol.DeleteResponse{State: protocol.DeleteStateDraining}, nil
		}
		return protocol.DeleteResponse{}, err
	}
	return protocol.DeleteResponse{State: protocol.DeleteStateDeleted}, nil
}

func (s *Server) lifetime(ctx context.Context, _ *mcp.CallToolRequest, req protocol.LifetimeRequest) (protocol.Empty, error) {
	var none protocol.Empty
	if req.ExtendToIdleWindow == (req.GraceMs != nil) {
		return none, fail(protocol.ErrBadRequest, "exactly one of extendToIdleWindow or graceMs is required")
	}
	if req.GraceMs != nil && *req.GraceMs < 0 {
		return none, fail(protocol.ErrBadRequest, "graceMs must not be negative")
	}
	rt, _, err := s.owner(ctx, req.Handle)
	if err != nil {
		return none, err
	}
	if req.GraceMs != nil {
		return none, rt.Provider.ReleaseAfter(ctx, req.Handle, time.Duration(*req.GraceMs)*time.Millisecond)
	}
	return none, rt.Provider.RenewTTL(ctx, req.Handle)
}

func (s *Server) credentials(ctx context.Context, _ *mcp.CallToolRequest, req protocol.CredentialsRequest) (protocol.Empty, error) {
	var none protocol.Empty
	if req.CloneURL == "" {
		return none, fail(protocol.ErrBadRequest, "cloneUrl is required")
	}
	rt, rec, err := s.owner(ctx, req.Handle)
	if err != nil {
		return none, err
	}
	if rec == nil {
		return none, fail(protocol.ErrUnknownHandle, "no sandbox recorded under "+req.Handle)
	}
	return none, rt.Provider.RotateCredential(ctx, req.Handle, req.CloneURL)
}

func (s *Server) tenantPoolsPush(_ context.Context, _ *mcp.CallToolRequest, req protocol.TenantPoolsPushRequest) (protocol.TenantPoolsPushResponse, error) {
	out := protocol.TenantPoolsPushResponse{Pools: []string{}}
	if req.Repo == "" || req.Ref == "" {
		return out, fail(protocol.ErrBadRequest, "repo and ref are required")
	}
	for _, rt := range s.Registry.All() {
		if pools, ok := rt.Provider.(runtime.TenantPools); ok {
			out.Pools = append(out.Pools, pools.MarkTenantPoolsDirty(req.Repo, req.Ref)...)
		}
	}
	return out, nil
}

// watch relays each phase as a progress notification when the caller sent a
// progress token, and returns the terminal one.
func (s *Server) watch(ctx context.Context, call *mcp.CallToolRequest, req protocol.HandleRequest) (protocol.Phase, error) {
	var none protocol.Phase
	rt, _, err := s.owner(ctx, req.Handle)
	if err != nil {
		return none, err
	}
	phases, err := rt.Provider.Watch(ctx, req.Handle)
	if err != nil {
		return none, err
	}
	token := call.Params.GetProgressToken()
	for n := 1; ; n++ {
		select {
		case <-ctx.Done():
			return none, ctx.Err()
		case p, ok := <-phases:
			if !ok {
				return none, fail(protocol.ErrInternal, "the lifecycle watch ended before ready or failed")
			}
			if token != nil {
				blob, _ := json.Marshal(p)
				if err := call.Session.NotifyProgress(ctx, &mcp.ProgressNotificationParams{
					ProgressToken: token, Progress: float64(n), Message: string(blob),
				}); err != nil {
					return none, err
				}
			}
			if p.Kind == protocol.PhaseReady || p.Kind == protocol.PhaseFailed {
				return p, nil
			}
		}
	}
}
