package setup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sync"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

type InstallState struct {
	mu          sync.Mutex
	fingerprint string
	ok          bool
}

func NewInstallState() *InstallState {
	return &InstallState{}
}

func Fingerprint(cfg *config.Enriched, branchHead string) string {
	slice := map[string]any{
		"pm":         orNil(cfg.PmName()),
		"pmPath":     orNil(cfg.PmPath()),
		"runtime":    orNil(cfg.Runtime()),
		"branchHead": orNil(branchHead),
	}
	raw, _ := json.Marshal(slice)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])[:16]
}

func orNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (s *InstallState) Mark(fingerprint string, ok bool) {
	s.mu.Lock()
	s.fingerprint = fingerprint
	s.ok = ok
	s.mu.Unlock()
}

func (s *InstallState) IsInstalledFor(cfg *config.Enriched, branchHead string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ok && s.fingerprint == Fingerprint(cfg, branchHead)
}

func (s *InstallState) Clear() {
	s.mu.Lock()
	s.fingerprint = ""
	s.ok = false
	s.mu.Unlock()
}
