package orgfs

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

type VolumeMount struct {
	Volume   string `json:"volume"`
	Path     string `json:"path"`
	Readonly *bool  `json:"readonly,omitempty"`
}

type MountConfig struct {
	BaseUrl string        `json:"baseUrl"`
	OrgSlug string        `json:"orgSlug"`
	Token   string        `json:"token"`
	Mounts  []VolumeMount `json:"mounts"`
}

// ParseConfig validates an OrgFsMountConfig payload; nil for
// absent/malformed/empty (mounting is then skipped).
func ParseConfig(raw []byte) *MountConfig {
	if len(raw) == 0 {
		return nil
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil
	}
	var c MountConfig
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil
	}
	if c.BaseUrl == "" || c.OrgSlug == "" || c.Token == "" || len(c.Mounts) == 0 {
		return nil
	}
	valid := c.Mounts[:0]
	for _, m := range c.Mounts {
		if m.Volume != "" && m.Path != "" {
			valid = append(valid, m)
		}
	}
	if len(valid) == 0 {
		return nil
	}
	c.Mounts = valid
	return &c
}

// RelaySidecarConfig atomically writes the raw config onto the shared
// control volume the privileged sidecar watches.
func RelaySidecarConfig(configPath string, raw []byte) error {
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(filepath.Dir(configPath), fmt.Sprintf(".config-%d.tmp", os.Getpid()))
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, configPath)
}
