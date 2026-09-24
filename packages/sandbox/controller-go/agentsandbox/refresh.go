package agentsandbox

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
	"github.com/decocms/studio/packages/sandbox/controller-go/store"
)

// withFreshCloneURL re-mints the repo's credential through Studio, falling
// back to the one it has: a mint failure must not block provisioning or
// recovery.
func (r *Runner) withFreshCloneURL(ctx context.Context, repo *protocol.EnsureRepo, buffer time.Duration) *protocol.EnsureRepo {
	if repo == nil || r.cfg.Studio == nil || (repo.ConnectionID == "" && repo.RepositoryID == "") {
		return repo
	}
	fresh, err := r.cfg.Studio.MintCloneURL(ctx, *repo, buffer.Milliseconds())
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

// withFreshCredentials re-mints both credentials a persisted options blob
// embeds: the clone token (~55min) and the org-fs API key (deleted at expiry).
// Every path that replays a persisted blob goes through here.
func (r *Runner) withFreshCredentials(ctx context.Context, opts protocol.EnsureOptions) protocol.EnsureOptions {
	opts.Repo = r.withFreshCloneURL(ctx, opts.Repo, 0)
	if opts.OrgFsConfigJSON != "" && opts.Tenant != nil && r.cfg.Studio != nil {
		fresh, err := r.cfg.Studio.MintOrgFsConfig(ctx, *opts.Tenant)
		if err != nil {
			slog.Warn("org-fs credential re-mint failed", "err", err)
		} else if fresh != "" {
			opts.OrgFsConfigJSON = fresh
		}
	}
	return opts
}

// RunCredentialRefresher keeps git alive in long-lived sandboxes until ctx
// ends. Recovery only re-mints on a claim event, so a pod edited continuously
// past the token's expiry would push a dead credential on shutdown and lose
// the user's work. Run it on one replica: refreshing an OAuth token rotates
// its refresh token, and two replicas refreshing one connection race.
func (r *Runner) RunCredentialRefresher(ctx context.Context) error {
	if r.cfg.Studio == nil {
		<-ctx.Done()
		return nil
	}
	ticker := time.NewTicker(credentialRefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := r.refreshAll(ctx); err != nil {
				slog.Warn("credential refresh: cannot list sandboxes", "err", err)
			}
		}
	}
}

// refreshAll groups rows by credential source: one connection's rows go in
// sequence (the first mints, the rest see a fresh token), distinct ones in
// parallel. One row's failure never stops the others.
func (r *Runner) refreshAll(ctx context.Context) error {
	rows, err := r.store.ListByRuntime(ctx, Name)
	if err != nil {
		return err
	}
	groups := map[string][]store.Record{}
	for _, row := range rows {
		var st persisted
		if json.Unmarshal(row.State, &st) != nil || st.EnsureOpts == nil || st.EnsureOpts.Repo == nil {
			continue
		}
		key := credentialSource(st.EnsureOpts.Repo)
		if key == "" {
			continue
		}
		groups[key] = append(groups[key], row)
	}
	var wg sync.WaitGroup
	for _, group := range groups {
		wg.Add(1)
		go func(group []store.Record) {
			defer wg.Done()
			for _, row := range group {
				if ctx.Err() != nil {
					return
				}
				r.refreshOne(ctx, row)
			}
		}(group)
	}
	wg.Wait()
	return nil
}

func credentialSource(repo *protocol.EnsureRepo) string {
	switch {
	case repo.ConnectionID != "":
		return "connection:" + repo.ConnectionID
	case repo.RepositoryID != "":
		return "repository:" + repo.RepositoryID
	}
	return ""
}

func (r *Runner) refreshOne(ctx context.Context, row store.Record) {
	var st persisted
	if json.Unmarshal(row.State, &st) != nil {
		return
	}
	repo := st.EnsureOpts.Repo
	fresh := r.withFreshCloneURL(ctx, repo, credentialRefreshBuffer)
	if fresh.CloneURL == repo.CloneURL {
		return
	}
	patch := gitCredentialRefreshPatch(fresh.CloneURL)
	if patch == nil {
		return
	}
	daemonURL, err := r.daemonURL(ctx, row.Handle, st.AdoptedSandboxName)
	if err != nil {
		return
	}
	if _, err := r.daemon.postConfig(ctx, daemonURL, st.Token, patch, ""); err != nil {
		slog.Warn("credential refresh push failed", "handle", row.Handle, "err", err)
		return
	}
	// The next sweep then sees the fresh token instead of re-deriving the stale one.
	if err := r.recordCloneURL(ctx, row.ID, row.Handle, fresh.CloneURL); err != nil {
		slog.Warn("credential refresh persist failed", "handle", row.Handle, "err", err)
	}
}
