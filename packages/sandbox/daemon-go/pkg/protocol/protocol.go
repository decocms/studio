// Package protocol is the daemon's wire contract: the shapes that cross
// /_sandbox/config and /health. It is the daemon's only exported package, so
// the sandbox controller can compile against the same definitions instead of
// re-deriving them — one definition of the boot contract, checked on both ends.
package protocol

// SubmoduleCredential is a PAT for fetching git submodules whose remotes the
// main clone token can't reach (a different repo/org). The daemon writes the
// token to a git-only credentials file and rewrites `git@<host>:` SSH submodule
// URLs to HTTPS so it authenticates.
//
// ⚠️ SECURITY: Token is a credential. It never enters the process env bag the
// dev server sees, never appears in argv, and is redacted from every
// `/_sandbox/config` response (see routes.stripSubmoduleTokens).
type SubmoduleCredential struct {
	Host  string `json:"host"`
	Token string `json:"token"`
}

type GitRepository struct {
	CloneUrl *string `json:"cloneUrl,omitempty"`
	Branch   *string `json:"branch,omitempty"`
	RepoName *string `json:"repoName,omitempty"`
	// Credentials for private submodules, keyed by host. Absent/empty means
	// submodules are fetched with only the ambient (no-credential) git config —
	// public submodules work, private ones on other hosts fail auth.
	SubmoduleCredentials []SubmoduleCredential `json:"submoduleCredentials,omitempty"`
}

type GitIdentity struct {
	UserName  *string `json:"userName,omitempty"`
	UserEmail *string `json:"userEmail,omitempty"`
}

type GitConfig struct {
	Repository *GitRepository `json:"repository,omitempty"`
	Identity   *GitIdentity   `json:"identity,omitempty"`
}

type Operator struct {
	UserName  *string `json:"userName,omitempty"`
	UserEmail *string `json:"userEmail,omitempty"`
}

type PackageManagerConfig struct {
	Name *string `json:"name,omitempty"`
	Path *string `json:"path,omitempty"`
}

type Application struct {
	PackageManager *PackageManagerConfig `json:"packageManager,omitempty"`
	Runtime        *string               `json:"runtime,omitempty"`
	Port           *float64              `json:"port,omitempty"`
}

type TenantConfig struct {
	Git      *GitConfig `json:"git,omitempty"`
	Operator *Operator  `json:"operator,omitempty"`
	// CloneOnly: prepare the checkout and stop — no dependency install, no dev
	// server. For a consumer that only needs the files (the sandbox-hosted
	// harness dispatch path), where an install is pure latency competing with
	// the run for the pod's CPU.
	//
	// It has to be explicit. Omitting `application` does NOT mean "no app":
	// `fillApplicationDefaults` deliberately autodetects a package manager from
	// the lockfile so a tenant who configured nothing still gets a dev server,
	// and that autodetect is what silently reinstated the install this flag
	// exists to skip.
	CloneOnly   *bool             `json:"cloneOnly,omitempty"`
	Application *Application      `json:"application,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
	// Owning organization, stamped by Studio. Nothing in the boot path reads it;
	// it exists so artifacts that outlive the pod can record whose they are.
	//
	// Concretely: the golden dependency cache. A repo hash does not isolate two
	// organizations cloning the same URL (a public template), so a store shared
	// across nodes must key by org — otherwise one org's dependency tree can be
	// restored into another's sandbox. See setup.WriteGoldenMeta.
	OrgId string `json:"orgId,omitempty"`
}

// IsCloneOnly reports whether this sandbox should stop after the checkout.
func (c *TenantConfig) IsCloneOnly() bool {
	return c != nil && c.CloneOnly != nil && *c.CloneOnly
}

func (c *TenantConfig) CloneUrl() string {
	if c == nil || c.Git == nil || c.Git.Repository == nil || c.Git.Repository.CloneUrl == nil {
		return ""
	}
	return *c.Git.Repository.CloneUrl
}

func (c *TenantConfig) HasCloneUrl() bool {
	return c != nil && c.Git != nil && c.Git.Repository != nil && c.Git.Repository.CloneUrl != nil
}

func (c *TenantConfig) Branch() string {
	if c == nil || c.Git == nil || c.Git.Repository == nil || c.Git.Repository.Branch == nil {
		return ""
	}
	return *c.Git.Repository.Branch
}

func (c *TenantConfig) RepoName() string {
	if c == nil || c.Git == nil || c.Git.Repository == nil || c.Git.Repository.RepoName == nil {
		return ""
	}
	return *c.Git.Repository.RepoName
}

// SubmoduleCredentials returns the configured per-host submodule PATs, nil when
// none. ⚠️ SECURITY: the tokens in the result are credentials. Never log them.
func (c *TenantConfig) SubmoduleCredentials() []SubmoduleCredential {
	if c == nil || c.Git == nil || c.Git.Repository == nil {
		return nil
	}
	return c.Git.Repository.SubmoduleCredentials
}

func (c *TenantConfig) HasBranch() bool {
	return c != nil && c.Git != nil && c.Git.Repository != nil && c.Git.Repository.Branch != nil
}

func (c *TenantConfig) PmName() string {
	if c == nil || c.Application == nil || c.Application.PackageManager == nil || c.Application.PackageManager.Name == nil {
		return ""
	}
	return *c.Application.PackageManager.Name
}

func (c *TenantConfig) PmPath() string {
	if c == nil || c.Application == nil || c.Application.PackageManager == nil || c.Application.PackageManager.Path == nil {
		return ""
	}
	return *c.Application.PackageManager.Path
}

func (c *TenantConfig) Runtime() string {
	if c == nil || c.Application == nil || c.Application.Runtime == nil {
		return ""
	}
	return *c.Application.Runtime
}

func (c *TenantConfig) Port() (int, bool) {
	if c == nil || c.Application == nil || c.Application.Port == nil {
		return 0, false
	}
	return int(*c.Application.Port), true
}

// Str is a pointer helper for the many optional wire fields.
func Str(s string) *string { return &s }

// ConfigAuth travels alongside a config patch and is stripped daemon-side.
type ConfigAuth struct {
	// RotateToken replaces the daemon's in-memory bearer, authorized by the
	// CURRENT token on the request. This is how a warm-pool pod's shared
	// SandboxTemplate sentinel becomes a per-claim secret without a second
	// endpoint — and why a recycled pod stops honouring the previous tenant's
	// credential.
	RotateToken string `json:"rotateToken,omitempty"`
}

// ConfigRequest is the POST /_sandbox/config body: a TenantConfig patch with
// the optional auth block inlined alongside it.
type ConfigRequest struct {
	TenantConfig
	Auth *ConfigAuth `json:"auth,omitempty"`
}

// SetupState is the orchestrator's view of the boot sequence.
type SetupState struct {
	Running bool `json:"running"`
	Done    bool `json:"done"`
}

// Health is GET /health — unauthenticated, and the only endpoint studio polls
// before it holds a per-claim token.
type Health struct {
	Ready      bool       `json:"ready"`
	BootId     string     `json:"bootId"`
	Configured bool       `json:"configured"`
	Setup      SetupState `json:"setup"`
}
