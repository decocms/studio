package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

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

// Delete stops and removes the container, then the row. The row goes last: a
// DELETE that runs out of time must still route its retry here.
func (r *Runner) Delete(ctx context.Context, handle string) error {
	r.disarm(handle)
	if err := r.remove(ctx, handle); err != nil {
		return err
	}
	return r.store.DeleteByHandle(ctx, Name, handle)
}

// Alive: the container is running. A missing one is normal (idle TTL, a
// restarted engine), never corruption.
func (r *Runner) Alive(ctx context.Context, handle string) (bool, error) {
	c, err := r.inspect(ctx, handle)
	if err != nil {
		return false, err
	}
	return c != nil && c.State.Running && r.owns(c), nil
}

func (r *Runner) Describe(ctx context.Context, handle string) (*runtime.Described, error) {
	_, st, err := r.row(ctx, handle)
	if err != nil || st == nil {
		return &runtime.Described{}, err
	}
	image := st.Image
	out := &runtime.Described{Image: &image}
	c, err := r.inspect(ctx, handle)
	if err != nil || c == nil || !c.State.Running || !r.owns(c) {
		// Gone is not an error to report here: Studio resurrects.
		return out, nil
	}
	if port := c.hostPort(daemonclient.Port); port != "" {
		url := "http://127.0.0.1:" + port
		out.Daemon = &protocol.Daemon{URL: url, Token: st.Token}
		out.PreviewURL = previewURL(url)
	}
	return out, nil
}

// Resurrect re-provisions a sandbox the idle TTL removed, replaying its
// persisted options with re-minted credentials. False without options.
func (r *Runner) Resurrect(ctx context.Context, handle string) (bool, error) {
	rec, st, err := r.row(ctx, handle)
	if err != nil || st == nil || st.EnsureOpts == nil {
		return false, err
	}
	slog.Info("resurrecting removed sandbox", "handle", handle)
	if _, err := r.Ensure(ctx, rec.ID, rec.Handle, daemonclient.FreshCredentials(ctx, r.cfg.Studio, *st.EnsureOpts)); err != nil {
		return false, err
	}
	return true, nil
}

// LastTermination reads a stopped container's state, spelled the way the
// kubelet spells it so Studio words both runtimes alike. Nil while it runs
// and once it is removed.
func (r *Runner) LastTermination(ctx context.Context, handle string) (*protocol.PodTermination, error) {
	c, err := r.inspect(ctx, handle)
	if err != nil || c == nil || !r.owns(c) {
		return nil, err
	}
	return termination(c), nil
}

func termination(c *container) *protocol.PodTermination {
	if c.State.Running || c.State.Status == "created" {
		return nil
	}
	exit := c.State.ExitCode
	out := &protocol.PodTermination{ExitCode: &exit, OOMKilled: c.State.OOMKilled}
	switch {
	case c.State.OOMKilled:
		out.Reason = "OOMKilled"
	case exit == 0:
		out.Reason = "Completed"
	default:
		out.Reason = "Error"
	}
	if c.HostConfig.Memory > 0 {
		out.MemoryLimit = quantity(c.HostConfig.Memory)
	}
	return out
}

// quantity spells bytes as Kubernetes does (`4Gi`), exact or not at all.
func quantity(bytes int64) string {
	for _, u := range []struct {
		suffix string
		size   int64
	}{{"Ti", 1 << 40}, {"Gi", 1 << 30}, {"Mi", 1 << 20}, {"Ki", 1 << 10}} {
		if bytes%u.size == 0 {
			return fmt.Sprintf("%d%s", bytes/u.size, u.suffix)
		}
	}
	return fmt.Sprint(bytes)
}

// RenewTTL pushes shutdown out to a full idle window; never earlier. A
// container already gone is left gone.
func (r *Runner) RenewTTL(ctx context.Context, handle string) error {
	next := r.now().Add(r.cfg.IdleTTL)
	if cur, ok := r.deadline(handle); ok && !cur.Before(next) {
		return nil
	}
	return r.rearmIfPresent(ctx, handle, next)
}

// ReleaseAfter brings shutdown forward once work settles; never later,
// because a concurrent turn may have just pushed it out.
func (r *Runner) ReleaseAfter(ctx context.Context, handle string, grace time.Duration) error {
	next := r.now().Add(grace)
	if cur, ok := r.deadline(handle); ok && !cur.After(next) {
		return nil
	}
	return r.rearmIfPresent(ctx, handle, next)
}

func (r *Runner) rearmIfPresent(ctx context.Context, handle string, at time.Time) error {
	c, err := r.inspect(ctx, handle)
	if err != nil || c == nil || !r.owns(c) {
		return err
	}
	r.arm(handle, at)
	return nil
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
	c, err := r.inspect(ctx, handle)
	if err != nil {
		return err
	}
	port := ""
	if c != nil && c.State.Running {
		port = c.hostPort(daemonclient.Port)
	}
	if port == "" {
		return &runtime.Error{Code: protocol.ErrUnknownHandle, Message: "the sandbox container is not running"}
	}
	if _, err := r.daemon.PostConfig(ctx, "http://127.0.0.1:"+port, st.Token, patch, ""); err != nil {
		return daemonclient.DaemonError(err)
	}
	// Under the lock, re-read so a concurrent ensure's write is not lost.
	return r.store.WithLock(ctx, rec.ID, Name, func(ctx context.Context) error {
		row, st, err := r.row(ctx, handle)
		if err != nil || st == nil || row.ID != rec.ID || st.EnsureOpts == nil || st.EnsureOpts.Repo == nil {
			return err
		}
		repo := *st.EnsureOpts.Repo
		repo.CloneURL = cloneURL
		opts := *st.EnsureOpts
		opts.Repo = &repo
		st.EnsureOpts = &opts
		return r.store.Put(ctx, row.ID, Name, handle, st)
	})
}

// Watch: a started container is one health probe from ready, and ensure
// already waited for it.
func (r *Runner) Watch(context.Context, string) (<-chan protocol.Phase, error) {
	ch := make(chan protocol.Phase, 1)
	ch <- protocol.Phase{Kind: protocol.PhaseReady}
	close(ch)
	return ch, nil
}

func (r *Runner) Schedulable(context.Context, string) (bool, error) { return true, nil }

// Images are the configured variants besides the default.
func (r *Runner) Images(context.Context) ([]protocol.ImageInfo, error) {
	out := []protocol.ImageInfo{}
	for name := range r.cfg.Images {
		if name != "default" {
			out = append(out, protocol.ImageInfo{Name: name})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// Close stops the idle timers. Containers outlive the controller; the next
// one re-arms them with RearmIdle.
func (r *Runner) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	for handle, t := range r.idle {
		t.timer.Stop()
		delete(r.idle, handle)
	}
}

// RearmIdle gives every container of ours a fresh idle window: the timers
// died with the previous process, and a full window never ends a sandbox
// early. Without it a container left by a restart would run forever.
func (r *Runner) RearmIdle(ctx context.Context) error {
	args := []string{"container", "ls", "--all", "--format", "{{.Names}}", "--filter", "label=" + labelRuntime + "=" + Name}
	for _, k := range sortedKeys(r.cfg.Labels) {
		args = append(args, "--filter", "label="+k+"="+r.cfg.Labels[k])
	}
	res, err := r.run(ctx, nil, args...)
	if err != nil {
		return err
	}
	if res.Code != 0 {
		return failure(res, "container ls")
	}
	at := r.now().Add(r.cfg.IdleTTL)
	for _, name := range strings.Fields(res.Stdout) {
		if _, armed := r.deadline(name); !armed {
			r.arm(name, at)
		}
	}
	return nil
}

func (r *Runner) deadline(handle string) (time.Time, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.idle[handle]
	if !ok {
		return time.Time{}, false
	}
	return t.deadline, true
}

// arm sets the handle's shutdown to at, replacing any earlier setting.
func (r *Runner) arm(handle string, at time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	if old, ok := r.idle[handle]; ok {
		old.timer.Stop()
	}
	r.gen++
	gen := r.gen
	r.idle[handle] = &idleTimer{
		deadline: at,
		gen:      gen,
		timer:    time.AfterFunc(at.Sub(r.now()), func() { r.expire(handle, gen) }),
	}
}

func (r *Runner) disarm(handle string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if t, ok := r.idle[handle]; ok {
		t.timer.Stop()
		delete(r.idle, handle)
	}
}

// expire removes an idle container under the sandbox's lock, so it cannot
// pull the container from under an ensure resuming it; an ensure that won
// the lock re-armed the timer, and this generation no longer holds. The row
// stays, for Resurrect.
func (r *Runner) expire(handle string, gen uint64) {
	ctx, cancel := context.WithTimeout(context.Background(), r.cfg.StopGrace+30*time.Second)
	defer cancel()
	removeIfCurrent := func(ctx context.Context) error {
		r.mu.Lock()
		t, ok := r.idle[handle]
		current := ok && t.gen == gen
		if current {
			delete(r.idle, handle)
		}
		r.mu.Unlock()
		if !current {
			return nil
		}
		slog.Info("idle TTL reached; removing sandbox container", "handle", handle)
		if err := r.remove(ctx, handle); err != nil {
			slog.Warn("removing an idle sandbox container failed; retrying", "handle", handle, "err", err)
			r.retryExpiry(handle, gen)
		}
		return nil
	}
	row, err := r.store.ByHandle(ctx, handle)
	if err != nil {
		slog.Warn("idle expiry: cannot read the row; retrying", "handle", handle, "err", err)
		r.retryExpiry(handle, gen)
		return
	}
	if row == nil || row.Runtime != Name {
		_ = removeIfCurrent(ctx)
		return
	}
	if err := r.store.WithLock(ctx, row.ID, Name, removeIfCurrent); err != nil {
		slog.Warn("idle expiry: lock failed; retrying", "handle", handle, "err", err)
		r.retryExpiry(handle, gen)
	}
}

// retryExpiry re-arms a failed expiry, unless an ensure or renewal armed the
// handle since: that newer deadline stands.
func (r *Runner) retryExpiry(handle string, gen uint64) {
	r.mu.Lock()
	t, ok := r.idle[handle]
	newer := ok && t.gen != gen
	r.mu.Unlock()
	if !newer {
		r.arm(handle, r.now().Add(expiryRetry))
	}
}
