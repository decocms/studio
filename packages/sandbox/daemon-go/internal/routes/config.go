package routes

import (
	"encoding/json"
	"io"
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
	return &config.TenantConfig{
		Git:         c.Git,
		Operator:    c.Operator,
		CloneOnly:   c.CloneOnly,
		Application: c.Application,
	}
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
		raw, err := io.ReadAll(r.Body)
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
		activity.MarkClaimed()
		httpx.JSON(w, 200, map[string]any{
			"bootId":     deps.DaemonBootId,
			"transition": result.Transition.Kind,
			"config":     result.After,
		})
	}
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
