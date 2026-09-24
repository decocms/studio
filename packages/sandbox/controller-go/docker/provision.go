package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"reflect"

	"github.com/decocms/studio/packages/sandbox/controller-go/daemonclient"
	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
	"github.com/decocms/studio/packages/sandbox/controller-go/runtime"
	"github.com/decocms/studio/packages/sandbox/controller-go/store"
)

func requestedImage(opts protocol.EnsureOptions) string {
	if runtime.IsDefaultImage(opts.SandboxImage) {
		return "default"
	}
	return opts.SandboxImage
}

// resolveImage degrades an image this runtime lacks to the default: image is
// a preference, and the default image's skill says what is missing.
func (r *Runner) resolveImage(opts protocol.EnsureOptions) (string, protocol.Image) {
	requested := requestedImage(opts)
	if ref, ok := r.cfg.Images[requested]; ok {
		return ref, protocol.Image{Requested: requested, Served: requested}
	}
	return r.cfg.Images["default"], protocol.Image{Requested: requested, Served: "default"}
}

func (r *Runner) owns(c *container) bool {
	if c.Config.Labels[labelRuntime] != Name {
		return false
	}
	for k, v := range r.cfg.Labels {
		if c.Config.Labels[k] != v {
			return false
		}
	}
	return true
}

func (r *Runner) finish(ctx context.Context, rec *record, persist bool) (*runtime.Sandbox, error) {
	if persist {
		if err := r.store.Put(ctx, rec.id, Name, rec.handle, rec.state); err != nil {
			return nil, err
		}
	}
	r.arm(rec.handle, r.now().Add(r.cfg.IdleTTL))
	return &runtime.Sandbox{
		Handle:     rec.handle,
		Workdir:    rec.state.Workdir,
		PreviewURL: previewURL(rec.daemonURL),
		Daemon:     protocol.Daemon{URL: rec.daemonURL, Token: rec.state.Token},
		Image:      rec.state.Image,
	}, nil
}

// previewURL is the daemon's own port, never the dev server's: the daemon's
// proxy strips CSP/X-Frame and injects the HMR bootstrap the Studio iframe
// needs.
func previewURL(daemonURL string) *string {
	u := daemonURL + "/"
	return &u
}

func (r *Runner) provision(ctx context.Context, id protocol.SandboxID, handle string, opts protocol.EnsureOptions) (*record, error) {
	ref, image := r.resolveImage(opts)
	token, bootID := r.newToken(), daemonclient.NewBootID()
	env, dropped := daemonclient.BootEnv(opts.Env, token, bootID, defaultWorkdir)
	if len(dropped) > 0 {
		slog.Warn("opts.env keys overlap reserved bootstrap names and were dropped", "keys", dropped)
	}
	// The pod's hardening, translated: no capabilities, no privilege
	// escalation, a read-only root with the writable paths as anonymous
	// volumes, which `rm --volumes` collects.
	args := []string{
		"run", "--detach", "--name", handle, "--init",
		"--read-only", "--volume", "/app", "--volume", "/tmp", "--volume", "/home/sandbox",
		"--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=4096",
		"--publish", fmt.Sprintf("127.0.0.1::%d", daemonclient.Port),
		"--label", labelRuntime + "=" + Name,
		"--label", labelHandle + "=" + handle,
		"--label", labelImage + "=" + image.Served,
	}
	if r.cfg.Memory != "" {
		args = append(args, "--memory", r.cfg.Memory, "--memory-swap", r.cfg.Memory)
	}
	if r.cfg.CPUs != "" {
		args = append(args, "--cpus", r.cfg.CPUs)
	}
	for _, k := range sortedKeys(r.cfg.Labels) {
		args = append(args, "--label", k+"="+r.cfg.Labels[k])
	}
	for _, k := range sortedKeys(env) {
		args = append(args, "--env", k)
	}
	args = append(args, ref)

	res, err := r.run(ctx, env, args...)
	if err != nil {
		return nil, err
	}
	if res.Code != 0 {
		// A half-created container (pull succeeded, start failed) still holds
		// the name.
		_ = r.remove(context.WithoutCancel(ctx), handle)
		return nil, &runtime.Error{Code: protocol.ErrClaimFailed, Message: failure(res, "run "+ref).Error()}
	}
	rec := &record{id: id, handle: handle, state: persisted{
		Token: token, Workdir: defaultWorkdir, DaemonBootID: bootID, Image: image, EnsureOpts: persistable(opts),
	}}
	release := func(cause error) (*record, error) {
		if err := r.remove(context.WithoutCancel(ctx), handle); err != nil {
			slog.Warn("removing a failed sandbox container failed", "handle", handle, "err", err)
		}
		return nil, cause
	}
	if rec.daemonURL, err = r.waitHealthy(ctx, handle); err != nil {
		return release(err)
	}
	if payload := daemonclient.WorkloadConfig(&opts, false); payload != nil {
		if _, err := r.daemon.PostConfig(ctx, rec.daemonURL, token, payload, ""); err != nil {
			return release(bootstrapError(err))
		}
	}
	r.relayOrgFs(ctx, rec, opts.OrgFsConfigJSON)
	return rec, nil
}

// waitHealthy polls until the daemon answers /health on its published port.
// A container that exits fails at once, with its exit code and log tail.
func (r *Runner) waitHealthy(ctx context.Context, handle string) (string, error) {
	deadline := r.now().Add(r.cfg.ReadyWait)
	for {
		c, err := r.inspect(ctx, handle)
		if err != nil {
			return "", err
		}
		if c == nil || !c.State.Running {
			msg := fmt.Sprintf("sandbox container %s exited before its daemon answered", handle)
			if c != nil {
				msg += fmt.Sprintf(" (exit %d)", c.State.ExitCode)
			}
			if tail := r.logsTail(ctx, handle); tail != "" {
				msg += ":\n" + tail
			}
			return "", &runtime.Error{Code: protocol.ErrClaimFailed, Message: msg}
		}
		if port := c.hostPort(daemonclient.Port); port != "" {
			url := "http://127.0.0.1:" + port
			if r.daemon.ProbeHealth(ctx, url) != nil {
				return url, nil
			}
		}
		if !r.now().Before(deadline) {
			return "", &runtime.Error{Code: protocol.ErrClaimStalled, Message: fmt.Sprintf("the daemon in sandbox container %s did not answer /health within %s", handle, r.cfg.ReadyWait)}
		}
		if err := daemonclient.Sleep(ctx, r.poll); err != nil {
			return "", err
		}
	}
}

func bootstrapError(err error) error {
	var cfgErr *daemonclient.ConfigRequestError
	if !errors.As(err, &cfgErr) {
		return err
	}
	return &runtime.Error{
		Code:    protocol.ErrBootstrapRejected,
		Message: fmt.Sprintf("sandbox provisioning failed: the sandbox container rejected the bootstrap handshake (HTTP %d). The container was removed; retrying starts a new one.", cfgErr.Status),
		Status:  cfgErr.Status,
		Err:     err,
	}
}

// liveDaemon is the daemon URL of a running container of ours whose daemon
// answers, and what /health said; "" otherwise.
func (r *Runner) liveDaemon(ctx context.Context, c *container) (string, string) {
	if c == nil || !c.State.Running || !r.owns(c) {
		return "", ""
	}
	port := c.hostPort(daemonclient.Port)
	if port == "" {
		return "", ""
	}
	url := "http://127.0.0.1:" + port
	h := r.daemon.ProbeHealth(ctx, url)
	if h == nil {
		return "", ""
	}
	return url, h.BootId
}

// resume rebuilds a record from its row, or nil when the container is not
// serving (the caller removes it and provisions).
func (r *Runner) resume(ctx context.Context, id protocol.SandboxID, row *store.Record) *record {
	var st persisted
	if json.Unmarshal(row.State, &st) != nil || st.Token == "" {
		return nil
	}
	c, err := r.inspect(ctx, row.Handle)
	if err != nil {
		slog.Warn("inspecting a recorded sandbox container failed", "handle", row.Handle, "err", err)
		return nil
	}
	url, bootID := r.liveDaemon(ctx, c)
	if url == "" {
		return nil
	}
	rec := &record{id: id, handle: row.Handle, daemonURL: url, state: st}
	// The env token survives a daemon restart and the daemon resumes on its
	// own; only the recorded boot id is stale.
	if st.DaemonBootID != bootID {
		slog.Warn("daemon restart detected", "handle", row.Handle, "storedBootId", st.DaemonBootID, "liveBootId", bootID)
		rec.state.DaemonBootID, rec.dirty = bootID, true
	}
	if rec.state.Workdir == "" {
		rec.state.Workdir = defaultWorkdir
	}
	return rec
}

// adopt takes over a running container of ours with no row (a crash between
// run and persist, or a wiped table). Its token is in its env.
func (r *Runner) adopt(ctx context.Context, id protocol.SandboxID, handle string, opts protocol.EnsureOptions, c *container) *record {
	token := c.env("DAEMON_TOKEN")
	if token == "" {
		return nil
	}
	url, bootID := r.liveDaemon(ctx, c)
	if url == "" {
		return nil
	}
	workdir := c.env("APP_ROOT")
	if workdir == "" {
		workdir = defaultWorkdir
	}
	served := c.Config.Labels[labelImage]
	if served == "" {
		served = "default"
	}
	return &record{id: id, handle: handle, daemonURL: url, state: persisted{
		Token: token, Workdir: workdir, DaemonBootID: bootID, EnsureOpts: persistable(opts),
		Image: protocol.Image{Requested: requestedImage(opts), Served: served},
	}}
}

func (r *Runner) refreshGitCredential(ctx context.Context, rec *record, opts protocol.EnsureOptions) {
	if opts.Repo == nil {
		return
	}
	patch := daemonclient.CredentialRefreshPatch(opts.Repo.CloneURL)
	if patch == nil {
		return
	}
	if _, err := r.daemon.PostConfig(ctx, rec.daemonURL, rec.state.Token, patch, ""); err != nil {
		slog.Warn("git credential refresh failed", "handle", rec.handle, "err", err)
		return
	}
	// So a resurrect replays the credential the daemon now has.
	if st := rec.state.EnsureOpts; st != nil && st.Repo != nil {
		repo := *st.Repo
		repo.CloneURL = opts.Repo.CloneURL
		o := *st
		o.Repo = &repo
		rec.state.EnsureOpts, rec.dirty = &o, true
	}
}

// relayOrgFs is best-effort: mounts are additive, and a relay failure must
// not fail provisioning or recovery.
func (r *Runner) relayOrgFs(ctx context.Context, rec *record, configJSON string) {
	if configJSON == "" {
		return
	}
	if err := r.daemon.PostOrgFsConfig(ctx, rec.daemonURL, rec.state.Token, configJSON); err != nil {
		slog.Warn("org-fs sidecar config relay failed", "handle", rec.handle, "err", err)
	}
}

// persistable is what a row keeps for Resurrect: nil for no options, since an
// empty sandbox with no repo is worse than a 404, which sends Studio to
// SANDBOX_START.
func persistable(opts protocol.EnsureOptions) *protocol.EnsureOptions {
	if len(opts.Env) == 0 {
		opts.Env = nil
	}
	if len(opts.ExtraRepos) == 0 {
		opts.ExtraRepos = nil
	}
	if reflect.DeepEqual(opts, protocol.EnsureOptions{}) {
		return nil
	}
	return &opts
}
