package setup

// Provenance for a node-local golden, so a consumer OUTSIDE the pod can tell
// whose dependency tree it is.
//
// The golden's own path carries only a repo hash: `golden/<repoHash>/<pm>-<lockHash>/`.
// That is enough while the store is node-local, because a node's cache is
// already one trust domain. It is NOT enough for a store shared across nodes:
// the hash is derived from the clone URL, so two organizations cloning the same
// public template land on the same key, and an archive published by one would
// restore into the other's sandbox.
//
// The daemon is the only process that knows both facts at once — it holds the
// org from Studio's config push and it is what writes the golden. So it records
// them here at publish time, and the uploader keys the shared archive by org
// without having to correlate anything after the fact.
//
// Best-effort in both directions: a golden with no meta is simply not eligible
// for upload, which is the safe default (a shared archive with an unknown owner
// is exactly what must not exist).

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// goldenMetaName sits INSIDE the golden's own directory, next to node_modules,
// so it is removed by the same prune that drops the golden and can never
// outlive what it describes.
const goldenMetaName = ".golden-meta.json"

// GoldenMeta is provenance, not cache content. Fields are additive: an older
// daemon's meta must stay readable by a newer uploader.
type GoldenMeta struct {
	// Owning organization. Empty means unknown, which makes the golden
	// ineligible for a shared store.
	OrgId string `json:"orgId"`
	// Clone URL WITHOUT credentials. Not used for keying — the repo hash in the
	// path is — but a hash is unreadable in an incident, and this is the only
	// place the mapping exists outside the pod that wrote it.
	//
	// WriteGoldenMeta strips it, and that is load-bearing rather than tidy: a
	// clone URL carries a GitHub App token, this file lives on a hostPath shared
	// by every sandbox on the node, and it is chowned to the same uid the tenant
	// runs as. Persisting the raw URL hands one tenant another tenant's token.
	CloneUrl string `json:"cloneUrl,omitempty"`
	// Package manager the tree was installed with, mirroring the directory name.
	// Redundant on purpose: it makes a meta file self-describing when read alone.
	Pm string `json:"pm,omitempty"`
	// Environment (sandbox-env's envName) that produced this tree. The node-local
	// store is per NODE, not per environment, and prod and stg sandboxes share
	// one NodePool — so a node's goldens are a mix. Recording it lets each
	// environment's uploader forward only what its own boots produced, instead of
	// compressing and shipping a neighbour's tree that nothing will ever read.
	Env string `json:"env,omitempty"`
}

// goldenMetaPath is the meta path for a golden's node_modules path.
func goldenMetaPath(goldenNodeModules string) string {
	return filepath.Join(filepath.Dir(goldenNodeModules), goldenMetaName)
}

// WriteGoldenMeta records provenance beside a freshly published golden.
// Best-effort: the golden is already usable node-locally without it, and the
// only consequence of failure is that this tree is not eligible for the shared
// tier.
func WriteGoldenMeta(goldenNodeModules string, meta GoldenMeta) {
	if meta.OrgId == "" {
		return // nothing worth recording; absence is the signal
	}
	// Strip here, not at every call site: this is the only place the URL is
	// persisted, so one guard covers every caller present and future.
	meta.CloneUrl = stripCredentials(meta.CloneUrl)
	buf, err := json.Marshal(meta)
	if err != nil {
		return
	}
	// 0o644, not 0o600: the uploader runs as a different identity than the
	// sandbox uid that wrote it.
	os.WriteFile(goldenMetaPath(goldenNodeModules), buf, 0o644)
}

// ReadGoldenMeta returns the provenance for a golden, and false when it is
// absent or unusable. A golden without a readable org is not eligible for a
// shared store — an archive whose owner is unknown is the one thing that must
// not be published.
func ReadGoldenMeta(goldenNodeModules string) (GoldenMeta, bool) {
	buf, err := os.ReadFile(goldenMetaPath(goldenNodeModules))
	if err != nil {
		return GoldenMeta{}, false
	}
	var meta GoldenMeta
	if err := json.Unmarshal(buf, &meta); err != nil {
		return GoldenMeta{}, false
	}
	if meta.OrgId == "" {
		return GoldenMeta{}, false
	}
	return meta, true
}
