// Package protocol is the controller's claim API: MCP tools Studio calls, and
// the HTTP callbacks the controller makes into Studio. The TypeScript types in
// packages/sandbox/controller-types/sandbox-api.ts are generated from this
// file (cmd/tsgen), so a field changed here breaks Studio's build.
//
// Field rules the generator relies on: `omitempty` means optional in
// TypeScript; a pointer without it is `T | null`.
package protocol

// PathMCP serves the tools as stateless streamable HTTP. A failed call is a
// result with isError set and an ErrorResponse, as JSON, in its text content.
const PathMCP = "/mcp"

// GET → HealthzResponse. Needs a client certificate like the tools.
const PathHealthz = "/healthz"

// EnsureRequest → EnsureResponse, once the daemon is healthy and configured.
const ToolEnsure = "SANDBOX_ENSURE"

// StatusRequest → StatusResponse.
const ToolStatus = "SANDBOX_STATUS"

// HandleRequest → DeleteResponse.
const ToolDelete = "SANDBOX_DELETE"

// LifetimeRequest → Empty.
const ToolLifetime = "SANDBOX_LIFETIME"

// CredentialsRequest → Empty.
const ToolCredentials = "SANDBOX_CREDENTIALS_ROTATE"

// HandleRequest → the terminal Phase. With a progress token, every phase,
// terminal included, is also a progress notification whose message is the
// Phase as JSON.
const ToolWatch = "SANDBOX_WATCH"

// Empty → ImagesResponse.
const ToolImages = "SANDBOX_IMAGES"

// Empty → RuntimesResponse.
const ToolRuntimes = "SANDBOX_RUNTIMES"

// CapacityRequest → CapacityResponse.
const ToolCapacity = "SANDBOX_CAPACITY"

// TenantPoolsPushRequest → TenantPoolsPushResponse.
const ToolTenantPoolsPush = "SANDBOX_TENANT_POOLS_PUSH"

// Empty is the input or output of a tool that takes or returns nothing.
type Empty struct{}

// HandleRequest names one sandbox by its claim handle.
type HandleRequest struct {
	Handle string `json:"handle"`
}

// SandboxID is Studio's tenant-scoped identity for a sandbox. The controller
// never parses ProjectRef: it is an opaque key.
type SandboxID struct {
	UserID     string `json:"userId"`
	ProjectRef string `json:"projectRef"`
}

// Capability names an optional provider behaviour, declared as data so Studio
// branches on it instead of on a runtime's name.
type Capability string

const (
	// A preview URL is served for the sandbox.
	CapPreview Capability = "preview"
	// SANDBOX_WATCH reports the pre-ready phases, not only "ready".
	CapLifecyclePhases Capability = "lifecycle-phases"
	// Claims may bind prewarmed pods.
	CapWarmPool Capability = "warm-pool"
	// lastTermination can say why the sandbox stopped (OOM, eviction).
	CapTerminationReason Capability = "termination-reason"
	// SANDBOX_LIFETIME moves shutdown.
	CapTTLExtend Capability = "ttl-extend"
	// The runtime answers the capacity probe; without it, it always admits.
	CapCapacity Capability = "capacity"
)

// Purpose decides the template size and pool; it survives into the persisted
// options a resurrected sandbox is rebuilt from.
type Purpose string

const (
	PurposeInteractive Purpose = "interactive"
	PurposeHarnessRun  Purpose = "harness-run"
)

type WorkloadRuntime string

const (
	RuntimeNode WorkloadRuntime = "node"
	RuntimeBun  WorkloadRuntime = "bun"
	RuntimeDeno WorkloadRuntime = "deno"
)

type PackageManager string

const (
	PackageManagerNpm  PackageManager = "npm"
	PackageManagerPnpm PackageManager = "pnpm"
	PackageManagerYarn PackageManager = "yarn"
	PackageManagerBun  PackageManager = "bun"
	PackageManagerDeno PackageManager = "deno"
)

// Workload is what the daemon runs once the checkout lands. Absent means no
// dev server is requested (the daemon may still autodetect one unless
// cloneOnly is set).
type Workload struct {
	Runtime        WorkloadRuntime `json:"runtime"`
	PackageManager PackageManager  `json:"packageManager"`
	// User-pinned dev port; the default (3000) when absent.
	DevPort int `json:"devPort,omitempty"`
	// Subdirectory holding the package manager manifest (e.g. `apps/web`).
	PackageManagerPath string `json:"packageManagerPath,omitempty"`
}

// SubmoduleCredential is a per-host PAT for a private submodule the clone
// token cannot reach.
type SubmoduleCredential struct {
	Host  string `json:"host"`
	Token string `json:"token"`
}

// EnsureRepo is one repository a sandbox checks out: the primary (`repo`) or
// a secondary (`extraRepos`).
type EnsureRepo struct {
	// May embed a short-lived credential as userinfo. Studio passes a freshly
	// minted URL on every ensure; the controller re-mints it for long-lived
	// sandboxes through the clone-url callback.
	CloneURL string `json:"cloneUrl"`
	// Connection the credential is minted from; echoed back on the callback.
	ConnectionID string `json:"connectionId,omitempty"`
	// First-class repository the credential is minted from; echoed back on the
	// callback. Set instead of connectionId for Studio-owned credentials.
	RepositoryID string `json:"repositoryId,omitempty"`
	UserName     string `json:"userName"`
	UserEmail    string `json:"userEmail"`
	Branch       string `json:"branch,omitempty"`
	// Human-readable label; no functional effect.
	DisplayName          string                `json:"displayName,omitempty"`
	SubmoduleCredentials []SubmoduleCredential `json:"submoduleCredentials,omitempty"`
	// Directory for a secondary checkout. A secondary without one is dropped.
	DirectoryName string `json:"directoryName,omitempty"`
}

// Tenant is cost-attribution identity: IDs become pod labels, the rest
// annotations.
type Tenant struct {
	OrgID     string `json:"orgId"`
	UserID    string `json:"userId"`
	OrgSlug   string `json:"orgSlug,omitempty"`
	OrgName   string `json:"orgName,omitempty"`
	UserEmail string `json:"userEmail,omitempty"`
	UserName  string `json:"userName,omitempty"`
}

// EnsureOptions is what Studio's ensure() takes.
type EnsureOptions struct {
	// Defaults to interactive.
	Purpose Purpose `json:"purpose,omitempty"`
	// The image the primary repository asked for; absent or "default" is the
	// base image. A preference: a runtime that cannot serve it degrades to the
	// default and reports it in the response's image.served.
	SandboxImage string `json:"sandboxImage,omitempty"`
	// The synthetic isolation key, recorded as the claim's git-branch
	// annotation. Not an identity input.
	Branch string      `json:"branch,omitempty"`
	Repo   *EnsureRepo `json:"repo,omitempty"`
	// Checkouts beside repo; ignored without a repo.
	ExtraRepos []EnsureRepo `json:"extraRepos,omitempty"`
	Workload   *Workload    `json:"workload,omitempty"`
	// Prepare the checkout only: no install, no dev server.
	CloneOnly bool `json:"cloneOnly,omitempty"`
	// Frozen for the sandbox's lifetime.
	Env    map[string]string `json:"env,omitempty"`
	Tenant *Tenant           `json:"tenant,omitempty"`
	// org-fs mount config (a JSON OrgFsMountConfig) relayed to the pod's
	// sidecar.
	OrgFsConfigJSON string `json:"orgFsConfigJson,omitempty"`
}

// EnsureRequest is SANDBOX_ENSURE's input.
type EnsureRequest struct {
	ID SandboxID `json:"id"`
	// Studio-derived claim name, so preview routing can recompute it without a
	// database read. The controller never derives one; it rejects a handle
	// recorded for another id.
	Handle string         `json:"handle"`
	Opts   *EnsureOptions `json:"opts,omitempty"`
	// A named runtime is a hard constraint: unavailable, incapable or full is
	// a no-runtime error, never a silent placement elsewhere, unless
	// allowFallback.
	Runtime       string       `json:"runtime,omitempty"`
	Requires      []Capability `json:"requires,omitempty"`
	AllowFallback bool         `json:"allowFallback,omitempty"`
}

// Daemon is where the sandbox's daemon is and the bearer that opens it. The
// controller never carries daemon bytes.
type Daemon struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

// Image is the image a sandbox asked for and the one it got. They differ when
// the cluster lacks the variant: the sandbox runs on the default image.
type Image struct {
	Requested string `json:"requested"`
	Served    string `json:"served"`
}

// EnsureResponse returns once the daemon is healthy and configured.
type EnsureResponse struct {
	Handle     string  `json:"handle"`
	Workdir    string  `json:"workdir"`
	PreviewURL *string `json:"previewUrl"`
	Daemon     Daemon  `json:"daemon"`
	Runtime    string  `json:"runtime"`
	Image      Image   `json:"image"`
	// The pod came from the tenant's warm pool: cloned, installed and serving
	// already. False for a cold pod and for a resumed or adopted sandbox.
	WarmPoolAdopted bool         `json:"warmPoolAdopted"`
	Capabilities    []Capability `json:"capabilities"`
	// Set when the handle already lived on another runtime than the one
	// requested; the live sandbox is returned unchanged.
	RuntimeMismatch string `json:"runtimeMismatch,omitempty"`
}

// PodTermination is how the infrastructure, not the daemon, saw a sandbox
// stop. An OOM kill exists only here.
type PodTermination struct {
	// Kubelet terminated.reason, e.g. OOMKilled, Error, Evicted.
	Reason    string `json:"reason"`
	OOMKilled bool   `json:"oomKilled"`
	ExitCode  *int32 `json:"exitCode,omitempty"`
	// The limit that was hit, as Kubernetes spells it (`4Gi`).
	MemoryLimit string `json:"memoryLimit,omitempty"`
	// The kubelet's eviction message when reason is Evicted, verbatim.
	EvictionMessage string `json:"evictionMessage,omitempty"`
}

// StatusRequest is SANDBOX_STATUS's input. With resurrect, a sandbox whose
// claim is gone is re-provisioned from its persisted options first: preview
// traffic, where a fetch is the only sign anyone is here.
type StatusRequest struct {
	Handle    string `json:"handle"`
	Resurrect bool   `json:"resurrect,omitempty"`
}

type StatusResponse struct {
	Handle          string          `json:"handle"`
	Alive           bool            `json:"alive"`
	PreviewURL      *string         `json:"previewUrl"`
	Daemon          *Daemon         `json:"daemon"`
	Runtime         string          `json:"runtime"`
	Image           *Image          `json:"image"`
	Capabilities    []Capability    `json:"capabilities"`
	LastTermination *PodTermination `json:"lastTermination"`
}

type DeleteState string

const (
	DeleteStateDeleted DeleteState = "deleted"
	// The claim outlived the controller's deadline and is not gone yet. It
	// means retry, not success; a caller rebinding must not ensure on it.
	DeleteStateDraining DeleteState = "draining"
)

type DeleteResponse struct {
	State DeleteState `json:"state"`
}

// LifetimeRequest takes exactly one of extendToIdleWindow, which only moves
// shutdown later, and graceMs, which only moves it earlier.
type LifetimeRequest struct {
	Handle             string `json:"handle"`
	ExtendToIdleWindow bool   `json:"extendToIdleWindow,omitempty"`
	GraceMs            *int64 `json:"graceMs,omitempty"`
}

// CredentialsRequest rotates the primary checkout's clone credential in place
// (same repository, new token).
type CredentialsRequest struct {
	Handle   string `json:"handle"`
	CloneURL string `json:"cloneUrl"`
}

// TenantPoolsPushRequest says a GitHub push landed, so
// the tenant pools warmed on that repo and branch refresh their unbound pods
// now instead of at their next periodic refresh.
type TenantPoolsPushRequest struct {
	// `owner/name`, case-insensitive.
	Repo string `json:"repo"`
	// The pushed ref, e.g. `refs/heads/main`.
	Ref string `json:"ref"`
}

// TenantPoolsPushResponse names the pools the push marked stale.
type TenantPoolsPushResponse struct {
	Pools []string `json:"pools"`
}

// PhaseKind is one pre-ready lifecycle phase. Runtimes without an equivalent
// emit a single "ready".
type PhaseKind string

const (
	PhaseClaiming           PhaseKind = "claiming"
	PhaseWaitingForCapacity PhaseKind = "waiting-for-capacity"
	PhasePullingImage       PhaseKind = "pulling-image"
	PhaseStartingContainer  PhaseKind = "starting-container"
	PhaseWarmingDaemon      PhaseKind = "warming-daemon"
	PhaseReady              PhaseKind = "ready"
	PhaseFailed             PhaseKind = "failed"
)

type FailureReason string

const (
	FailureImagePullBackoff  FailureReason = "image-pull-backoff"
	FailureCrashLoopBackoff  FailureReason = "crash-loop-backoff"
	FailureSchedulingTimeout FailureReason = "scheduling-timeout"
)

// Phase is one lifecycle transition SANDBOX_WATCH reports; the watch ends
// after "ready" or "failed".
type Phase struct {
	Kind PhaseKind `json:"kind"`
	// Epoch ms the watch started; absent on terminal phases.
	Since   int64  `json:"since,omitempty"`
	Message string `json:"message,omitempty"`
	// Karpenter nodeclaim being provisioned, on waiting-for-capacity.
	NodeClaim string `json:"nodeClaim,omitempty"`
	// Set on failed.
	Reason FailureReason `json:"reason,omitempty"`
}

// ImageInfo is one variant a runtime can serve.
type ImageInfo struct {
	// The value Studio stores in repositories.sandbox_image.
	Name string `json:"name"`
	// Base image tag the variant was built from.
	BaseTag string `json:"baseTag,omitempty"`
	// Tag the default template runs now; differs from baseTag on skew.
	DefaultTemplateTag string `json:"defaultTemplateTag,omitempty"`
}

type RuntimeImages struct {
	Runtime string      `json:"runtime"`
	Images  []ImageInfo `json:"images"`
}

// ImagesResponse is SANDBOX_IMAGES's output.
type ImagesResponse struct {
	Runtimes []RuntimeImages `json:"runtimes"`
}

// Capacity is "nothing is currently unplaceable", never a reservation.
type Capacity struct {
	Schedulable bool `json:"schedulable"`
	// RFC 3339.
	ObservedAt string `json:"observedAt"`
}

// RuntimeInfo is one entry of SANDBOX_RUNTIMES.
type RuntimeInfo struct {
	Name      string `json:"name"`
	Available bool   `json:"available"`
	// Why it is unavailable.
	Reason       string       `json:"reason,omitempty"`
	Priority     int          `json:"priority"`
	Capacity     *Capacity    `json:"capacity,omitempty"`
	Capabilities []Capability `json:"capabilities"`
}

// RuntimesResponse is SANDBOX_RUNTIMES's output.
type RuntimesResponse struct {
	Runtimes []RuntimeInfo `json:"runtimes"`
}

// CapacityRequest names the image whose variant's nodes to judge; absent is
// the default image.
type CapacityRequest struct {
	SandboxImage string `json:"sandboxImage,omitempty"`
}

// CapacityResponse is Studio's admission gate: true when any available
// runtime has room.
type CapacityResponse struct {
	Schedulable bool `json:"schedulable"`
}

// HealthzResponse is GET /healthz.
type HealthzResponse struct {
	OK bool `json:"ok"`
}

// ErrorCode says what failed, so Studio can word and retry it without
// matching messages.
type ErrorCode string

const (
	// The request failed validation; message says which field.
	ErrBadRequest ErrorCode = "bad-request"
	// No sandbox is recorded under the handle.
	ErrUnknownHandle ErrorCode = "unknown-handle"
	// The handle is recorded for another sandbox id.
	ErrHandleConflict ErrorCode = "handle-conflict"
	// The recorded runtime is not in this build: the sandbox is left alone.
	ErrRuntimeUnreachable ErrorCode = "runtime-unreachable"
	// Nothing could place the sandbox; reasons has one entry per runtime.
	ErrNoRuntime ErrorCode = "no-runtime"
	// The pod's daemon rejected the bootstrap handshake; the claim was
	// released and a retry gets a different pod. status is the daemon's.
	ErrBootstrapRejected ErrorCode = "bootstrap-rejected"
	// The claim reached a terminal failure (image pull, crash loop,
	// unschedulable) and was released.
	ErrClaimFailed ErrorCode = "claim-failed"
	// The claim stopped making progress and was released.
	ErrClaimStalled ErrorCode = "claim-stalled"
	// The daemon of a live sandbox refused or failed a control call.
	ErrDaemon   ErrorCode = "daemon-error"
	ErrInternal ErrorCode = "internal"
)

// ErrorResponse is every failed tool call's text content, and every non-2xx
// callback body.
type ErrorResponse struct {
	Error string    `json:"error"`
	Code  ErrorCode `json:"code"`
	// Per-runtime placement reasons, on no-runtime.
	Reasons map[string]string `json:"reasons,omitempty"`
	// The daemon's HTTP status, on bootstrap-rejected and daemon-error.
	Status int `json:"status,omitempty"`
}

// CloneURLPath is the controller's credential callback into Studio, over mTLS.
// Studio mints only for a connection or repository of the tenant's org, whose
// user is a member there, or for a configured warm pool: an unverified
// endpoint mints a token for any connection in the deployment.
const CloneURLPath = "/api/_sandbox-controller/clone-url"

type CloneURLRequest struct {
	ConnectionID string `json:"connectionId,omitempty"`
	RepositoryID string `json:"repositoryId,omitempty"`
	CloneURL     string `json:"cloneUrl"`
	// The sandbox's tenant; absent only for a warm-pool pod, which has none.
	Tenant *Tenant `json:"tenant,omitempty"`
	// Re-mint when the current token has less than this much life left.
	BufferMs int64 `json:"bufferMs,omitempty"`
}

type CloneURLResponse struct {
	// Null when Studio cannot mint; the controller keeps the URL it has.
	CloneURL *string `json:"cloneUrl"`
}

// OrgFsConfigPath re-mints the org-fs mount config, whose API key Better Auth
// deletes at expiry, before a persisted config is replayed.
const OrgFsConfigPath = "/api/_sandbox-controller/org-fs-config"

type OrgFsConfigRequest struct {
	Tenant Tenant `json:"tenant"`
}

type OrgFsConfigResponse struct {
	// Null when Studio cannot mint; the controller keeps the config it has.
	OrgFsConfigJSON *string `json:"orgFsConfigJson"`
}
