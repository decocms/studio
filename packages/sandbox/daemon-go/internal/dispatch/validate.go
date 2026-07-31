package dispatch

import (
	"encoding/json"
	"fmt"
)

// ValidateHarnessInput structurally checks the wire input against the
// required fields of harnessStreamInputSchema (packages/sandbox/dispatch/
// schemas.ts). Returns "" when valid.
func ValidateHarnessInput(input json.RawMessage) string {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(input, &obj); err != nil || obj == nil {
		return "input must be an object"
	}
	if reason := requireString(obj, "threadId"); reason != "" {
		return reason
	}
	if reason := requireObject(obj, "userMessage"); reason != "" {
		return reason
	}
	if reason := requireObject(obj, "harness"); reason != "" {
		return reason
	}
	if reason := validateWorkspace(obj["workspace"]); reason != "" {
		return reason
	}
	if reason := validateModels(obj["models"]); reason != "" {
		return reason
	}
	if reason := validateMcp(obj["mcp"]); reason != "" {
		return reason
	}
	if reason := requireEnum(obj, "mode", []string{"default", "plan", "web-search", "gen-image"}); reason != "" {
		return reason
	}
	if reason := requireNumber(obj, "temperature"); reason != "" {
		return reason
	}
	if reason := requireEnum(obj, "toolApprovalLevel", []string{"auto", "readonly"}); reason != "" {
		return reason
	}
	if reason := validateUser(obj["user"]); reason != "" {
		return reason
	}
	if reason := requireString(obj, "organizationId"); reason != "" {
		return reason
	}
	if reason := validateAgent(obj["agent"]); reason != "" {
		return reason
	}
	return ""
}

// runInfoOf pulls the workspace-preparation fields off a harness input. Lenient
// by design: it runs on already-validated input, and a missing field just means
// the corresponding preparation step is skipped.
func runInfoOf(raw json.RawMessage) RunInfo {
	var in struct {
		ThreadId string `json:"threadId"`
		Mcp      struct {
			URL       string            `json:"url"`
			Headers   map[string]string `json:"headers"`
			ExpiresAt float64           `json:"expiresAt"`
		} `json:"mcp"`
	}
	if json.Unmarshal(raw, &in) != nil {
		return RunInfo{}
	}
	return RunInfo{
		ThreadId:     in.ThreadId,
		McpURL:       in.Mcp.URL,
		McpHeaders:   in.Mcp.Headers,
		McpExpiresAt: int64(in.Mcp.ExpiresAt),
	}
}

func requireString(obj map[string]json.RawMessage, key string) string {
	raw, ok := obj[key]
	if !ok {
		return fmt.Sprintf("%s: required", key)
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return fmt.Sprintf("%s: expected string", key)
	}
	return ""
}

func requireNumber(obj map[string]json.RawMessage, key string) string {
	raw, ok := obj[key]
	if !ok {
		return fmt.Sprintf("%s: required", key)
	}
	var n float64
	if err := json.Unmarshal(raw, &n); err != nil {
		return fmt.Sprintf("%s: expected number", key)
	}
	return ""
}

func requireObject(obj map[string]json.RawMessage, key string) string {
	raw, ok := obj[key]
	if !ok {
		return fmt.Sprintf("%s: required", key)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return fmt.Sprintf("%s: expected object", key)
	}
	return ""
}

func requireEnum(obj map[string]json.RawMessage, key string, allowed []string) string {
	raw, ok := obj[key]
	if !ok {
		return fmt.Sprintf("%s: required", key)
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return fmt.Sprintf("%s: expected string", key)
	}
	for _, a := range allowed {
		if s == a {
			return ""
		}
	}
	return fmt.Sprintf("%s: invalid value %q", key, s)
}

func validateWorkspace(raw json.RawMessage) string {
	if raw == nil {
		return "workspace: required"
	}
	var ws struct {
		Cwd  *string `json:"cwd"`
		Repo *struct {
			Owner           *string `json:"owner"`
			Name            *string `json:"name"`
			ConnectedGithub *bool   `json:"connectedGithub"`
		} `json:"repo"`
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil || probe == nil {
		return "workspace: expected object"
	}
	if _, ok := probe["cwd"]; !ok {
		return "workspace.cwd: required"
	}
	if err := json.Unmarshal(raw, &ws); err != nil {
		return "workspace: invalid"
	}
	if ws.Cwd == nil {
		return ""
	}
	if *ws.Cwd != "/repo" {
		return "workspace.cwd: must be \"/repo\" or null"
	}
	if ws.Repo == nil || ws.Repo.Owner == nil || ws.Repo.Name == nil || ws.Repo.ConnectedGithub == nil {
		return "workspace.repo: required"
	}
	if _, ok := probe["branch"]; !ok {
		return "workspace.branch: required"
	}
	return ""
}

func validateModels(raw json.RawMessage) string {
	if raw == nil {
		return "models: required"
	}
	var models struct {
		Thinking *struct {
			ID           *string `json:"id"`
			Title        *string `json:"title"`
			CredentialID *string `json:"credentialId"`
		} `json:"thinking"`
	}
	if err := json.Unmarshal(raw, &models); err != nil {
		return "models: expected object"
	}
	if models.Thinking == nil || models.Thinking.ID == nil ||
		models.Thinking.Title == nil || models.Thinking.CredentialID == nil {
		return "models.thinking: required"
	}
	return ""
}

func validateMcp(raw json.RawMessage) string {
	if raw == nil {
		return "mcp: required"
	}
	var mcp struct {
		URL       *string            `json:"url"`
		Headers   *map[string]string `json:"headers"`
		ExpiresAt *float64           `json:"expiresAt"`
	}
	if err := json.Unmarshal(raw, &mcp); err != nil {
		return "mcp: expected object"
	}
	if mcp.URL == nil || mcp.Headers == nil || mcp.ExpiresAt == nil || *mcp.ExpiresAt <= 0 {
		return "mcp: url, headers and expiresAt required"
	}
	return ""
}

func validateUser(raw json.RawMessage) string {
	if raw == nil {
		return "user: required"
	}
	var user struct {
		ID    *string `json:"id"`
		Email *string `json:"email"`
	}
	if err := json.Unmarshal(raw, &user); err != nil {
		return "user: expected object"
	}
	if user.ID == nil || user.Email == nil {
		return "user.id and user.email required"
	}
	return ""
}

func validateAgent(raw json.RawMessage) string {
	if raw == nil {
		return "agent: required"
	}
	var agent struct {
		ID *string `json:"id"`
	}
	if err := json.Unmarshal(raw, &agent); err != nil {
		return "agent: expected object"
	}
	if agent.ID == nil {
		return "agent.id required"
	}
	return ""
}
