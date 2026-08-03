package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// ReadDiskConfig reads the read-only boot fallback
// <repoDir>/.decocms/daemon.json. The daemon never writes it.
func ReadDiskConfig(repoDir string) (*TenantConfig, bool) {
	raw, err := os.ReadFile(filepath.Join(repoDir, ".decocms", "daemon.json"))
	if err != nil {
		return nil, false
	}
	var c TenantConfig
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, false
	}
	return &c, true
}
