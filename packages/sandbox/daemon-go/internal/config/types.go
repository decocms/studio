package config

import (
	"encoding/json"

	"github.com/decocms/studio/sandbox-daemon/pkg/protocol"
)

// The wire types live in pkg/protocol so the sandbox controller compiles
// against the same definitions. Aliases, not copies: their accessor methods
// come along, and a shape change is a compile error on both sides.
type (
	SubmoduleCredential  = protocol.SubmoduleCredential
	GitRepository        = protocol.GitRepository
	GitIdentity          = protocol.GitIdentity
	GitConfig            = protocol.GitConfig
	Operator             = protocol.Operator
	PackageManagerConfig = protocol.PackageManagerConfig
	Application          = protocol.Application
	TenantConfig         = protocol.TenantConfig
)

// Str is re-exported so existing call sites keep working.
var Str = protocol.Str

// Patch mirrors ConfigPatch: env values may be null (per-key delete).
type Patch struct {
	Git         *GitConfig
	Operator    *Operator
	CloneOnly   *bool
	Application *Application
	Env         map[string]*string
	HasEnv      bool
	// Pointer, not string: DeepMerge rebuilds TenantConfig field by field, so a
	// field absent from BOTH the patch and the merge is silently dropped on every
	// apply. Nil here means "not in this patch, keep current".
	OrgId *string
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
	if v, ok := raw["orgId"]; ok && !isNull(v) {
		if err := json.Unmarshal(v, &p.OrgId); err != nil {
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
