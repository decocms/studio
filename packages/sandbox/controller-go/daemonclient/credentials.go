package daemonclient

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"time"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
	"github.com/decocms/studio/packages/sandbox/controller-go/runtime"
)

// Studio is the controller's callbacks into Studio, which owns the database
// and vault credentials are minted from. An empty result means Studio
// declined; the caller keeps what it has.
type Studio interface {
	MintCloneURL(ctx context.Context, repo protocol.EnsureRepo, bufferMs int64) (string, error)
	MintOrgFsConfig(ctx context.Context, tenant protocol.Tenant) (string, error)
}

// FreshCloneURL re-mints the repo's credential through Studio, falling back
// to the one it has: a mint failure must not block provisioning or recovery.
func FreshCloneURL(ctx context.Context, studio Studio, repo *protocol.EnsureRepo, buffer time.Duration) *protocol.EnsureRepo {
	if repo == nil || studio == nil || (repo.ConnectionID == "" && repo.RepositoryID == "") {
		return repo
	}
	fresh, err := studio.MintCloneURL(ctx, *repo, buffer.Milliseconds())
	if err != nil {
		slog.Warn("clone credential re-mint failed", "err", err)
		return repo
	}
	if fresh == "" {
		return repo
	}
	out := *repo
	out.CloneURL = fresh
	return &out
}

// FreshCredentials re-mints both credentials a persisted options blob embeds:
// the clone token (~55min) and the org-fs API key (deleted at expiry). Every
// path that replays a persisted blob goes through here.
func FreshCredentials(ctx context.Context, studio Studio, opts protocol.EnsureOptions) protocol.EnsureOptions {
	opts.Repo = FreshCloneURL(ctx, studio, opts.Repo, 0)
	if opts.OrgFsConfigJSON != "" && opts.Tenant != nil && studio != nil {
		fresh, err := studio.MintOrgFsConfig(ctx, *opts.Tenant)
		if err != nil {
			slog.Warn("org-fs credential re-mint failed", "err", err)
		} else if fresh != "" {
			opts.OrgFsConfigJSON = fresh
		}
	}
	return opts
}

// NewToken is a per-sandbox daemon bearer: 32 bytes hex, as Studio generated
// them; the daemon wants 32..256 chars.
func NewToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// NewBootID is a v4 UUID the daemon echoes on /health, so a restart shows.
func NewBootID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// DaemonError is a live sandbox's daemon refusing or failing a control call.
func DaemonError(err error) error {
	out := &runtime.Error{Code: protocol.ErrDaemon, Message: "sandbox daemon rejected the call", Err: err}
	var cfgErr *ConfigRequestError
	if errors.As(err, &cfgErr) {
		out.Status = cfgErr.Status
	}
	return out
}
