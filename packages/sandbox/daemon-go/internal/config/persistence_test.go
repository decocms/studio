package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadDiskConfigNoFile(t *testing.T) {
	cfg, found, err := ReadDiskConfig(t.TempDir())
	if cfg != nil || found || err != nil {
		t.Fatalf("ReadDiskConfig() = (%v, %v, %v), want (nil, false, nil)", cfg, found, err)
	}
}

func TestReadDiskConfigMalformedJson(t *testing.T) {
	repoDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(repoDir, ".decocms"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, ".decocms", "daemon.json"), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, found, err := ReadDiskConfig(repoDir)
	if cfg != nil || !found || err == nil {
		t.Fatalf("ReadDiskConfig() = (%v, %v, %v), want (nil, true, non-nil error)", cfg, found, err)
	}
}

func TestReadDiskConfigValid(t *testing.T) {
	repoDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(repoDir, ".decocms"), 0o755); err != nil {
		t.Fatal(err)
	}
	raw := `{"orgId":"org_123"}`
	if err := os.WriteFile(filepath.Join(repoDir, ".decocms", "daemon.json"), []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, found, err := ReadDiskConfig(repoDir)
	if err != nil || !found || cfg == nil || cfg.OrgId != "org_123" {
		t.Fatalf("ReadDiskConfig() = (%+v, %v, %v), want a valid config", cfg, found, err)
	}
}
