package agentsandbox

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/decocms/studio/packages/sandbox/controller-go/api/v1alpha1"
	"github.com/decocms/studio/packages/sandbox/controller-go/daemonclient"
	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
	"github.com/decocms/studio/packages/sandbox/controller-go/runtime"
	"github.com/decocms/studio/packages/sandbox/controller-go/store"
)

func (r *Runner) row(ctx context.Context, handle string) (*store.Record, *persisted, error) {
	rec, err := r.store.ByHandle(ctx, handle)
	if err != nil || rec == nil || rec.Runtime != Name {
		return nil, nil, err
	}
	var st persisted
	if err := json.Unmarshal(rec.State, &st); err != nil {
		return rec, nil, err
	}
	return rec, &st, nil
}

// Delete removes the route first so traffic stops resolving, then the claim,
// then the row, and waits for the claim to be collected until ctx's deadline.
func (r *Runner) Delete(ctx context.Context, handle string) error {
	if r.cfg.PreviewGateway != nil {
		// A stale route backed by a deleted Service just 502s; the
		// housekeeper's sweep collects it.
		if err := r.kube.deleteHTTPRoute(ctx, handle); err != nil {
			slog.Warn("HTTPRoute delete failed", "handle", handle, "err", err)
		}
	}
	if err := r.kube.deleteClaim(ctx, handle); err != nil {
		return err
	}
	r.fwd.close(handle)
	if err := r.store.DeleteByHandle(ctx, Name, handle); err != nil {
		return err
	}
	for {
		c, err := r.kube.getClaim(ctx, handle)
		if err == nil && c == nil {
			return nil
		}
		if err := daemonclient.Sleep(ctx, r.timing.gonePoll); err != nil {
			return err
		}
	}
}

// Alive: the claim exists. A missing claim is normal (idle TTL, the
// housekeeper), never corruption.
func (r *Runner) Alive(ctx context.Context, handle string) (bool, error) {
	c, err := r.kube.getClaim(ctx, handle)
	return c != nil, err
}

func (r *Runner) Describe(ctx context.Context, handle string) (*runtime.Described, error) {
	_, st, err := r.row(ctx, handle)
	if err != nil || st == nil {
		return &runtime.Described{}, err
	}
	adopted := st.AdoptedSandboxName
	if adopted == "" {
		adopted = st.PodName
	}
	out := &runtime.Described{Image: st.Image}
	daemonURL, err := r.daemonURL(ctx, handle, adopted)
	if err != nil {
		// A dead forward is not an error to report here: Studio resurrects.
		slog.Warn("daemon address unavailable", "handle", handle, "err", err)
		return out, nil
	}
	out.Daemon = &protocol.Daemon{URL: daemonURL, Token: st.Token}
	out.PreviewURL = r.previewURL(handle, daemonURL)
	return out, nil
}

// Resurrect re-provisions a sandbox the idle TTL reaped, replaying its
// persisted options with re-minted credentials (the persisted ones carry
// first-provision tokens, long expired). False without options: an empty pod
// with no repo is worse than a 404, which sends Studio to SANDBOX_START.
func (r *Runner) Resurrect(ctx context.Context, handle string) (bool, error) {
	rec, st, err := r.row(ctx, handle)
	if err != nil || st == nil || st.EnsureOpts == nil {
		return false, err
	}
	slog.Info("resurrecting evicted sandbox", "handle", handle)
	if _, err := r.Ensure(ctx, rec.ID, rec.Handle, daemonclient.FreshCredentials(ctx, r.cfg.Studio, *st.EnsureOpts)); err != nil {
		return false, err
	}
	return true, nil
}

func (r *Runner) LastTermination(ctx context.Context, handle string) (*protocol.PodTermination, error) {
	return r.kube.lastTermination(ctx, handle), nil
}

// RenewTTL pushes shutdown out to a full idle window; never earlier. A claim
// already gone is left gone: one recreated from here would carry none of the
// env a working sandbox needs.
func (r *Runner) RenewTTL(ctx context.Context, handle string) error {
	c, err := r.kube.getClaim(ctx, handle)
	if err != nil || c == nil {
		return err
	}
	next := r.now().Add(r.cfg.IdleTTL)
	if cur := shutdownOf(c); cur != nil && !cur.Before(next) {
		return nil
	}
	// Best-effort: a missed renewal costs one reprovision, and the next
	// heartbeat retries well inside the TTL.
	if err := r.kube.patchShutdown(ctx, handle, next); err != nil {
		slog.Warn("TTL renew failed", "handle", handle, "err", err)
	}
	return nil
}

// ReleaseAfter brings shutdown forward once work settles; never later, because
// a concurrent turn may have just adopted the pod and pushed it out. A patch,
// not a delete: the grace lets a follow-up turn reuse the running pod.
func (r *Runner) ReleaseAfter(ctx context.Context, handle string, grace time.Duration) error {
	c, err := r.kube.getClaim(ctx, handle)
	if err != nil || c == nil {
		return err
	}
	next := r.now().Add(grace)
	if cur := shutdownOf(c); cur != nil && !cur.After(next) {
		return nil
	}
	if err := r.kube.patchShutdown(ctx, handle, next); err != nil {
		slog.Warn("release failed", "handle", handle, "err", err)
	}
	return nil
}

func shutdownOf(c *Claim) *time.Time {
	if c.Spec.Lifecycle == nil || c.Spec.Lifecycle.ShutdownTime == nil {
		return nil
	}
	t := c.Spec.Lifecycle.ShutdownTime.Time
	return &t
}

// RotateCredential pushes a new credential for the checkout the sandbox
// already has, and records it for recovery. A different repository is a
// rebind, not a rotation.
func (r *Runner) RotateCredential(ctx context.Context, handle, cloneURL string) error {
	rec, st, err := r.row(ctx, handle)
	if err != nil {
		return err
	}
	if st == nil {
		return &runtime.Error{Code: protocol.ErrUnknownHandle, Message: "no sandbox recorded under " + handle}
	}
	if st.EnsureOpts == nil || st.EnsureOpts.Repo == nil || daemonclient.StripURLCredentials(st.EnsureOpts.Repo.CloneURL) != daemonclient.StripURLCredentials(cloneURL) || daemonclient.StripURLCredentials(cloneURL) == "" {
		return &runtime.Error{Code: protocol.ErrBadRequest, Message: "cloneUrl must name the sandbox's own repository"}
	}
	patch := daemonclient.CredentialRefreshPatch(cloneURL)
	if patch == nil {
		return nil
	}
	daemonURL, err := r.daemonURL(ctx, handle, st.AdoptedSandboxName)
	if err != nil {
		return err
	}
	if _, err := r.daemon.PostConfig(ctx, daemonURL, st.Token, patch, ""); err != nil {
		return daemonclient.DaemonError(err)
	}
	return r.recordCloneURL(ctx, rec.ID, handle, cloneURL)
}

// recordCloneURL updates the row under the sandbox's lock, re-read so a
// concurrent ensure's write is not lost.
func (r *Runner) recordCloneURL(ctx context.Context, id protocol.SandboxID, handle, cloneURL string) error {
	return r.store.WithLock(ctx, id, Name, func(ctx context.Context) error {
		rec, err := r.store.Get(ctx, id, Name)
		if err != nil || rec == nil || rec.Handle != handle {
			return err
		}
		var st persisted
		if err := json.Unmarshal(rec.State, &st); err != nil || st.EnsureOpts == nil || st.EnsureOpts.Repo == nil {
			return err
		}
		repo := *st.EnsureOpts.Repo
		repo.CloneURL = cloneURL
		opts := *st.EnsureOpts
		opts.Repo = &repo
		st.EnsureOpts = &opts
		return r.store.Put(ctx, id, Name, handle, st)
	})
}

func daemonError(err error) error {
	out := &runtime.Error{Code: protocol.ErrDaemon, Message: "sandbox daemon rejected the call", Err: err}
	var cfgErr *daemonclient.ConfigRequestError
	if errors.As(err, &cfgErr) {
		out.Status = cfgErr.Status
	}
	return out
}

func (r *Runner) Schedulable(ctx context.Context) (bool, error) {
	return r.kube.schedulable(ctx)
}

// Images are the Ready SandboxVariants built on this runtime's base template.
func (r *Runner) Images(ctx context.Context) ([]protocol.ImageInfo, error) {
	if r.cfg.Variants == nil {
		return nil, nil
	}
	variants, err := r.cfg.Variants(ctx)
	if err != nil {
		return nil, err
	}
	out := []protocol.ImageInfo{}
	for _, v := range variants {
		if v.Spec.BaseTemplate != r.cfg.TemplateName || len(v.Name) <= len(v.Spec.BaseTemplate)+1 {
			continue
		}
		ready := false
		for _, c := range v.Status.Conditions {
			if c.Type == v1alpha1.ConditionReady && c.Status == metav1.ConditionTrue {
				ready = true
			}
		}
		if ready {
			out = append(out, protocol.ImageInfo{Name: v.Variant(), BaseTag: v.Spec.BaseTag, DefaultTemplateTag: v.Status.DefaultTemplateTag})
		}
	}
	return out, nil
}
