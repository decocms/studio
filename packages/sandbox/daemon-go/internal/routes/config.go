package routes

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"github.com/decocms/studio/sandbox-daemon/internal/activity"
	"github.com/decocms/studio/sandbox-daemon/internal/config"
	"github.com/decocms/studio/sandbox-daemon/internal/httpx"
	"github.com/decocms/studio/sandbox-daemon/internal/proc"
)

const (
	tokenMinLength = 32
	tokenMaxLength = 256
)

type OrchestratorState struct {
	Running bool `json:"running"`
	Pending int  `json:"pending"`
}

type ConfigDeps struct {
	DaemonBootId    string
	Store           *config.Store
	SetDaemonToken  func(next string)
	GetOrchestrator func() OrchestratorState
	GetReady        func() bool
	GetTasks        func() []proc.Phase
	RepoDir         string
}

func stripDerived(c *config.Enriched) *config.TenantConfig {
	if c == nil {
		return nil
	}
	// Redact resolved submodule PATs — see stripSubmoduleTokens. `env` is
	// likewise never returned here (only `envKeys`, in the read handler).
	return stripSubmoduleTokens(&config.TenantConfig{
		Git:         c.Git,
		Operator:    c.Operator,
		CloneOnly:   c.CloneOnly,
		Application: c.Application,
	})
}

// stripSubmoduleTokens returns a copy of the config without the resolved
// submodule PATs, for use before it crosses an HTTP boundary. The daemon keeps
// them in its in-memory store (the clone step reads them there); they must never
// appear in a `/config` response, which is browser-reachable — otherwise any
// referenceable org secret becomes readable. Mirrors how `env` values never leave
// the daemon (only `envKeys` do).
//
// Copies rather than mutates: the input aliases the live store's config, so
// clearing the field in place would disarm the clone step itself.
func stripSubmoduleTokens(c *config.TenantConfig) *config.TenantConfig {
	if c == nil || c.Git == nil || c.Git.Repository == nil ||
		c.Git.Repository.SubmoduleCredentials == nil {
		return c
	}
	repo := *c.Git.Repository
	repo.SubmoduleCredentials = nil
	git := *c.Git
	git.Repository = &repo
	out := *c
	out.Git = &git
	return &out
}

func ConfigRead(deps ConfigDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant := deps.Store.Read()
		envKeys := []string{}
		if tenant != nil {
			for k := range tenant.Env {
				envKeys = append(envKeys, k)
			}
			sort.Strings(envKeys)
		}
		resp := map[string]any{
			"bootId":  deps.DaemonBootId,
			"config":  stripDerived(tenant),
			"envKeys": envKeys,
			"ready":   deps.GetReady(),
			"repoDir": deps.RepoDir,
		}
		if deps.GetOrchestrator != nil {
			resp["orchestrator"] = deps.GetOrchestrator()
		}
		if deps.GetTasks != nil {
			resp["tasks"] = deps.GetTasks()
		}
		httpx.JSON(w, 200, resp)
	}
}

func ConfigUpdate(deps ConfigDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw, err := readLimitedBody(r, maxConfigBytes)
		if err != nil {
			httpx.Error(w, 400, "bad body: "+err.Error())
			return
		}
		var wire map[string]json.RawMessage
		if err := json.Unmarshal(raw, &wire); err != nil {
			httpx.Error(w, 400, "bad body: "+err.Error())
			return
		}
		if wire == nil {
			httpx.Error(w, 400, "payload must be an object")
			return
		}
		if authRaw, ok := wire["auth"]; ok && string(authRaw) != "null" {
			if rejected := handleAuthPatch(w, authRaw, deps.SetDaemonToken); rejected {
				return
			}
		}
		patch, err := config.ParsePatch(wire)
		if err != nil {
			httpx.Error(w, 400, "bad body: "+err.Error())
			return
		}
		result := deps.Store.Apply(patch)
		if !result.Applied {
			activityGuard := result.Reason
			status := 400
			if strings.Contains(activityGuard, "immutable") {
				status = 409
			}
			msg := result.Reason
			if result.Detail != "" {
				msg = result.Reason + ": " + result.Detail
			}
			httpx.Error(w, status, msg)
			return
		}
		if patchHasUserIdentity(patch) {
			activity.MarkClaimed()
		} else {
			activity.MarkPrewarmed()
		}
		httpx.JSON(w, 200, map[string]any{
			"bootId":     deps.DaemonBootId,
			"transition": result.Transition.Kind,
			// Both GET /config and this echo are proxied to the browser. Never let
			// the resolved submodule PATs back out — they're needed only in the
			// in-memory store for the clone step.
			"config": stripSubmoduleTokens(result.After),
		})
	}
}

// A config belongs to a user when it carries a git author or an operator.
// Blank strings count as absent: a tenant warm-pool bootstrap goes through the
// same payload builder as a real claim, which always emits the identity object
// — with empty fields when there is no user.
func patchHasUserIdentity(p *config.Patch) bool {
	if p == nil {
		return false
	}
	if p.Operator != nil && (nonBlank(p.Operator.UserName) || nonBlank(p.Operator.UserEmail)) {
		return true
	}
	if p.Git != nil && p.Git.Identity != nil {
		return nonBlank(p.Git.Identity.UserName) || nonBlank(p.Git.Identity.UserEmail)
	}
	return false
}

func nonBlank(s *string) bool {
	return s != nil && strings.TrimSpace(*s) != ""
}

func handleAuthPatch(w http.ResponseWriter, authRaw json.RawMessage, setter func(string)) bool {
	var authObj map[string]json.RawMessage
	if err := json.Unmarshal(authRaw, &authObj); err != nil || authObj == nil {
		httpx.Error(w, 400, "auth must be an object")
		return true
	}
	rotateRaw, ok := authObj["rotateToken"]
	if !ok || string(rotateRaw) == "null" {
		return false
	}
	if setter == nil {
		httpx.Error(w, 400, "auth.rotateToken not supported on this endpoint")
		return true
	}
	var token string
	if err := json.Unmarshal(rotateRaw, &token); err != nil {
		httpx.Error(w, 400, "auth.rotateToken must be a string")
		return true
	}
	if len(token) < tokenMinLength || len(token) > tokenMaxLength {
		httpx.Error(w, 400, "auth.rotateToken length must be 32..256")
		return true
	}
	setter(token)
	return false
}
