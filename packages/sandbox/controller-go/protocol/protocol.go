// Package protocol is the wire contract between studio and this controller.
// It mirrors packages/sandbox/server/provider/remote/protocol.ts — and, for
// the payload types those envelopes carry, server/provider/types.ts — field
// for field. contract_test.go fails if either side drifts.
package protocol

// SandboxID is studio's tenant-scoped identity for a sandbox. The controller
// never parses ProjectRef — it is an opaque routing key.
type SandboxID struct {
	UserID     string `json:"userId"`
	ProjectRef string `json:"projectRef"`
}

// Capability names an optional SandboxProvider method, declared as data
// instead of discovered by calling and getting undefined.
type Capability string

const (
	CapPreview           Capability = "preview"
	CapLifecyclePhases   Capability = "lifecycle-phases"
	CapWarmPool          Capability = "warm-pool"
	CapTerminationReason Capability = "termination-reason"
	CapTTLExtend         Capability = "ttl-extend"
	CapCapacity          Capability = "capacity"
)

// Workload is what the daemon should run once the checkout lands.
type Workload struct {
	Runtime            string `json:"runtime,omitempty"`
	PackageManager     string `json:"packageManager,omitempty"`
	DevPort            int    `json:"devPort,omitempty"`
	PackageManagerPath string `json:"packageManagerPath,omitempty"`
}

// SubmoduleCredential is a per-host PAT for a private submodule remote the
// main clone's per-repo token cannot reach.
type SubmoduleCredential struct {
	Host  string `json:"host"`
	Token string `json:"token"`
}

// Repo is the optional first-provisioning clone.
type Repo struct {
	// CloneURL may embed a short-lived credential via userinfo. Callers pass a
	// freshly minted URL on every ensure; the controller re-mints it for
	// long-lived sandboxes through studio's callback.
	CloneURL             string                `json:"cloneUrl"`
	ConnectionID         string                `json:"connectionId,omitempty"`
	UserName             string                `json:"userName,omitempty"`
	UserEmail            string                `json:"userEmail,omitempty"`
	Branch               string                `json:"branch,omitempty"`
	DisplayName          string                `json:"displayName,omitempty"`
	SubmoduleCredentials []SubmoduleCredential `json:"submoduleCredentials,omitempty"`
}

// Tenant is cost-attribution identity. IDs become pod labels (charset
// restricted); the human-readable fields become annotations.
type Tenant struct {
	OrgID     string `json:"orgId"`
	UserID    string `json:"userId"`
	OrgSlug   string `json:"orgSlug,omitempty"`
	OrgName   string `json:"orgName,omitempty"`
	UserEmail string `json:"userEmail,omitempty"`
	UserName  string `json:"userName,omitempty"`
}

// EnsureOptions mirrors the TS EnsureOptions. Fields a runtime does not
// understand are ignored, never an error.
type EnsureOptions struct {
	// Purpose is "interactive" (default) or "harness-run"; it decides the
	// template's memory ceiling and the warm pool, so it must survive into the
	// persisted opts a resurrected claim is rebuilt from.
	Purpose string `json:"purpose,omitempty"`
	// Branch is recorded as the claim's git-branch annotation. NOT an identity
	// input — the handle derives from ProjectRef alone.
	Branch string `json:"branch,omitempty"`
	Repo   *Repo  `json:"repo,omitempty"`
	Image  string `json:"image,omitempty"`

	Workload *Workload `json:"workload,omitempty"`
	// CloneOnly prepares the checkout and nothing else. Must be explicit: the
	// daemon autodetects a package manager from the lockfile otherwise.
	CloneOnly bool              `json:"cloneOnly,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Tenant    *Tenant           `json:"tenant,omitempty"`

	OffloadAllowedHosts  []string `json:"offloadAllowedHosts,omitempty"`
	OffloadAllowSameHost bool     `json:"offloadAllowSameHostDev,omitempty"`
	OrgFsConfigJSON      string   `json:"orgFsConfigJson,omitempty"`
}

// EnsureRequest is POST /sandboxes.
type EnsureRequest struct {
	ID   SandboxID      `json:"id"`
	Opts *EnsureOptions `json:"opts,omitempty"`
	// Runtime is a HARD constraint when set: unavailable means 503 with the
	// reason, never a silent placement somewhere else.
	Runtime       string       `json:"runtime,omitempty"`
	Requires      []Capability `json:"requires,omitempty"`
	AllowFallback bool         `json:"allowFallback,omitempty"`
}

// Daemon is where the daemon is and what token opens it. The controller never
// carries daemon bytes; studio's own fetch code talks to this address.
type Daemon struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

// EnsureResponse returns only once the daemon is healthy and configured.
type EnsureResponse struct {
	Handle       string       `json:"handle"`
	Workdir      string       `json:"workdir"`
	PreviewURL   *string      `json:"previewUrl"`
	Daemon       Daemon       `json:"daemon"`
	Runtime      string       `json:"runtime"`
	Capabilities []Capability `json:"capabilities"`
	// RuntimeMismatch is set when the handle already existed on a different
	// runtime than the one asked for. The live sandbox is returned as-is;
	// switching is the caller's explicit DELETE + POST.
	RuntimeMismatch string `json:"runtimeMismatch,omitempty"`
}

// PodTermination is how the infrastructure — not the daemon — saw a sandbox
// stop. An OOM kill exists only here.
type PodTermination struct {
	Reason      string `json:"reason"`
	OOMKilled   bool   `json:"oomKilled"`
	ExitCode    *int32 `json:"exitCode,omitempty"`
	MemoryLimit string `json:"memoryLimit,omitempty"`
}

// StatusResponse is GET /sandboxes/:handle.
type StatusResponse struct {
	Handle          string          `json:"handle"`
	Alive           bool            `json:"alive"`
	PreviewURL      *string         `json:"previewUrl"`
	Daemon          *Daemon         `json:"daemon"`
	Runtime         string          `json:"runtime"`
	Capabilities    []Capability    `json:"capabilities"`
	LastTermination *PodTermination `json:"lastTermination"`
}

// LifetimeRequest is PATCH /sandboxes/:handle/lifetime. Exactly one field is
// set: ExtendToIdleWindow only ever moves shutdown later, GraceMs only earlier.
type LifetimeRequest struct {
	ExtendToIdleWindow bool   `json:"extendToIdleWindow,omitempty"`
	GraceMs            *int64 `json:"graceMs,omitempty"`
}

// Capacity is "nothing is currently unplaceable", never a reservation.
type Capacity struct {
	Schedulable bool   `json:"schedulable"`
	ObservedAt  string `json:"observedAt"`
}

// RuntimeInfo is one entry of GET /runtimes.
type RuntimeInfo struct {
	Name         string       `json:"name"`
	Available    bool         `json:"available"`
	Reason       string       `json:"reason,omitempty"`
	Capacity     *Capacity    `json:"capacity,omitempty"`
	Capabilities []Capability `json:"capabilities"`
	Priority     int          `json:"priority"`
}

type RuntimesResponse struct {
	Runtimes []RuntimeInfo `json:"runtimes"`
}

type CapacityResponse struct {
	Schedulable bool `json:"schedulable"`
}

type AdoptRequest struct {
	ID SandboxID `json:"id"`
}

type AdoptResponse struct {
	Adopted bool `json:"adopted"`
}

// ErrorResponse carries per-runtime placement reasons on a 503.
type ErrorResponse struct {
	Error   string            `json:"error"`
	Reasons map[string]string `json:"reasons,omitempty"`
}

// CloneURLRequest is the controller's one callback into studio. Minting needs
// studio's DB and vault, so it cannot move here.
//
// Studio MUST verify (ConnectionID, CloneURL) belongs to a sandbox that exists
// before minting: buildCloneInfo carries no org scope, so an unverified
// endpoint is a credential oracle for every connection in the deployment.
type CloneURLRequest struct {
	ConnectionID string `json:"connectionId"`
	CloneURL     string `json:"cloneUrl"`
	BufferMs     int64  `json:"bufferMs,omitempty"`
}

type CloneURLResponse struct {
	CloneURL string `json:"cloneUrl"`
}

const CloneURLPath = "/api/_sandbox-controller/clone-url"
