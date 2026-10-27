package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// ReadDiskConfig reads the read-only boot fallback
// <repoDir>/.decocms/daemon.json. The daemon never writes it.
//
// err is non-nil only when the file is present but not valid JSON — a repo
// that simply has no such file is the common case and reports found=false,
// err=nil so callers don't warn about it.
func ReadDiskConfig(repoDir string) (cfg *TenantConfig, found bool, err error) {
	raw, readErr := os.ReadFile(filepath.Join(repoDir, ".decocms", "daemon.json"))
	if readErr != nil {
		return nil, false, nil
	}
	var c TenantConfig
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, true, err
	}
	return &c, true, nil
}
