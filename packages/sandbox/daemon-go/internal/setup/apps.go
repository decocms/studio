package setup

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
	"github.com/decocms/studio/sandbox-daemon/internal/paths"
	"github.com/decocms/studio/sandbox-daemon/internal/proc"
)

// Extra apps share the main app's install: a monorepo installs its workspaces
// together. Each runs its own dev script, outside the main dev lifecycle.
const (
	extraAppLogPrefix = "app-"
	extraAppFirstPort = 3101
	// A stopped app restarts when its preview is reloaded, at most this often.
	extraAppRestartBackoff = 10 * time.Second
)

type extraApp struct {
	path string
	// PORT handed to the dev script; a port the script announces wins.
	port      int
	sniffer   *proc.PortSniffer
	taskID    string
	spawnedAt time.Time
	// Why the app could not start, when it has no dev script.
	err string
}

// ExtraAppState is what the preview needs to route to an app.
type ExtraAppState struct {
	Path string
	Port int
	// Stopped is set once the dev script exited; Reason says why.
	Stopped bool
	Reason  string
	Log     string
}

func extraAppLogName(slug string) string { return extraAppLogPrefix + slug }

// SyncExtraApps runs a dev server for every configured extra app and stops the
// ones no longer configured. Idempotent: a running app with the same command
// keeps its process.
func (o *Orchestrator) SyncExtraApps() {
	o.appsMu.Lock()
	defer o.appsMu.Unlock()
	cfg := o.deps.Store.Read()
	var want []config.ExtraApp
	if cfg != nil && !cfg.IsCloneOnly() && o.deps.InstallState.IsInstalledFor(cfg, o.branchHead()) {
		want = cfg.ExtraApps()
	}
	wanted := map[string]bool{}
	for _, a := range want {
		wanted[config.AppSlug(a.Path)] = true
	}
	for slug := range o.apps {
		if !wanted[slug] {
			o.deps.TaskManager.KillByLogName(extraAppLogName(slug), true, 15)
			delete(o.apps, slug)
			o.setAppSniffer(slug, nil)
		}
	}
	for _, a := range want {
		o.startExtraApp(cfg, config.AppSlug(a.Path), a.Path)
	}
}

func (o *Orchestrator) startExtraApp(cfg *config.Enriched, slug, path string) {
	cwd := paths.ResolvePmRoot(o.deps.RepoDir, path)
	command, ok := buildStartCommandAt(cfg, cwd)
	if !ok {
		o.apps[slug] = &extraApp{path: path, err: fmt.Sprintf("no dev or start script in %s/package.json", path)}
		return
	}
	logName := extraAppLogName(slug)
	if prev, ok := o.apps[slug]; ok && prev.taskID != "" {
		runningCmd, runningCwd, found := o.deps.TaskManager.RunningCommandByLogName(logName)
		if found && runningCmd == command.Cmd && runningCwd == command.Cwd {
			return
		}
	}
	port := o.freeExtraAppPort(slug)
	env := map[string]string{}
	for k, v := range DenoCacheEnv(cfg, o.deps.RepoDir) {
		env[k] = v
	}
	for k, v := range cfg.Env {
		env[k] = v
	}
	env["PORT"] = strconv.Itoa(port)
	app := &extraApp{
		path:      path,
		port:      port,
		sniffer:   proc.NewSourcePortSniffer(logName),
		spawnedAt: time.Now(),
	}
	o.apps[slug] = app
	// Before the spawn, so the sniffer sees the first output.
	o.setAppSniffer(slug, app.sniffer)
	o.chunk(fmt.Sprintf("[orchestrator] starting %s (%s)\r\n", path, command.Source))
	task := o.deps.TaskManager.Spawn(proc.TaskSpec{
		Command:          command.Cmd,
		Cwd:              command.Cwd,
		Env:              BuildDevEnv(cfg, env),
		Label:            command.Label,
		Mode:             "pty",
		LogName:          logName,
		ReplaceByLogName: true,
	})
	app.taskID = task.ID
}

// freeExtraAppPort keeps an app's port across restarts and never reuses another's.
func (o *Orchestrator) freeExtraAppPort(slug string) int {
	if prev, ok := o.apps[slug]; ok && prev.port != 0 {
		return prev.port
	}
	used := map[int]bool{}
	for _, a := range o.apps {
		used[a.port] = true
	}
	port := extraAppFirstPort
	for used[port] {
		port++
	}
	return port
}

func (o *Orchestrator) stopExtraApps() {
	o.appsMu.Lock()
	defer o.appsMu.Unlock()
	names := make([]string, 0, len(o.apps))
	for slug := range o.apps {
		name := extraAppLogName(slug)
		o.deps.TaskManager.KillByLogName(name, true, 15)
		names = append(names, name)
		o.setAppSniffer(slug, nil)
	}
	o.deps.TaskManager.WaitForLogNamesIdle(names)
	o.apps = map[string]*extraApp{}
}

// Sniffers sit behind their own lock: Spawn broadcasts output synchronously
// while appsMu is held, and that output lands in ObserveExtraAppChunk.
func (o *Orchestrator) setAppSniffer(slug string, sniffer *proc.PortSniffer) {
	o.sniffersMu.Lock()
	defer o.sniffersMu.Unlock()
	if sniffer == nil {
		delete(o.sniffers, slug)
	} else {
		o.sniffers[slug] = sniffer
	}
}

// ObserveExtraAppChunk feeds an app's dev-script output to its port sniffer.
func (o *Orchestrator) ObserveExtraAppChunk(source, data string) {
	if !strings.HasPrefix(source, extraAppLogPrefix) {
		return
	}
	o.sniffersMu.Lock()
	sniffer := o.sniffers[strings.TrimPrefix(source, extraAppLogPrefix)]
	o.sniffersMu.Unlock()
	if sniffer != nil {
		sniffer.Observe(source, data)
	}
}

// ExtraApp reports where an app serves. False for a slug that is not configured.
func (o *Orchestrator) ExtraApp(slug string) (ExtraAppState, bool) {
	o.appsMu.Lock()
	defer o.appsMu.Unlock()
	app, ok := o.apps[slug]
	if !ok {
		return ExtraAppState{}, false
	}
	state := ExtraAppState{Path: app.path, Port: app.port}
	if app.err != "" {
		state.Stopped, state.Reason = true, app.err
		return state, true
	}
	if sniffed := app.sniffer.Current(); sniffed != 0 {
		state.Port = sniffed
	}
	task, found := o.deps.TaskManager.Get(app.taskID)
	if found && task.Status != proc.StatusRunning {
		state.Stopped = true
		state.Reason = "the dev script exited"
		if task.ExitCode != nil {
			state.Reason = fmt.Sprintf("the dev script exited with code %d", *task.ExitCode)
		}
		if out, ok := o.deps.TaskManager.Output(app.taskID); ok {
			state.Log = out.Stdout + out.Stderr
		}
	}
	return state, true
}

// RestartExtraApp respawns a stopped app, at most once per backoff window.
// True when it restarted.
func (o *Orchestrator) RestartExtraApp(slug string) bool {
	o.appsMu.Lock()
	defer o.appsMu.Unlock()
	app, ok := o.apps[slug]
	if !ok || app.err != "" || time.Since(app.spawnedAt) < extraAppRestartBackoff {
		return false
	}
	cfg := o.deps.Store.Read()
	if cfg == nil {
		return false
	}
	app.taskID = ""
	o.startExtraApp(cfg, slug, app.path)
	return true
}
