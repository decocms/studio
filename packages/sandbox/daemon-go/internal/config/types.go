package config

import "encoding/json"

type GitRepository struct {
	CloneUrl *string `json:"cloneUrl,omitempty"`
	Branch   *string `json:"branch,omitempty"`
	RepoName *string `json:"repoName,omitempty"`
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

// Patch mirrors ConfigPatch: env values may be null (per-key delete).
type Patch struct {
	Git         *GitConfig
	Operator    *Operator
	CloneOnly   *bool
	Application *Application
	Env         map[string]*string
	HasEnv      bool
}

func ParsePatch(raw map[string]json.RawMessage) (*Patch, error) {
	p := &Patch{}
	if v, ok := raw["git"]; ok && !isNull(v) {
		if err := json.Unmarshal(v, &p.Git); err != nil {
			return nil, err
		}
	}
	if v, ok := raw["operator"]; ok && !isNull(v) {
		if err := json.Unmarshal(v, &p.Operator); err != nil {
			return nil, err
		}
	}
	if v, ok := raw["cloneOnly"]; ok && !isNull(v) {
		if err := json.Unmarshal(v, &p.CloneOnly); err != nil {
			return nil, err
		}
	}
	if v, ok := raw["application"]; ok && !isNull(v) {
		if err := json.Unmarshal(v, &p.Application); err != nil {
			return nil, err
		}
	}
	if v, ok := raw["env"]; ok && !isNull(v) {
		p.HasEnv = true
		if err := json.Unmarshal(v, &p.Env); err != nil {
			return nil, err
		}
	}
	return p, nil
}

func isNull(raw json.RawMessage) bool {
	return string(raw) == "null"
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

func Str(s string) *string { return &s }
