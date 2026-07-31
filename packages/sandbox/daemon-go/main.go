package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/activity"
	"github.com/decocms/studio/sandbox-daemon/internal/auth"
	"github.com/decocms/studio/sandbox-daemon/internal/config"
	"github.com/decocms/studio/sandbox-daemon/internal/dispatch"
	"github.com/decocms/studio/sandbox-daemon/internal/events"
	"github.com/decocms/studio/sandbox-daemon/internal/gitx"
	"github.com/decocms/studio/sandbox-daemon/internal/httpx"
	"github.com/decocms/studio/sandbox-daemon/internal/lifecycle"
	"github.com/decocms/studio/sandbox-daemon/internal/orgfs"
	"github.com/decocms/studio/sandbox-daemon/internal/probe"
	"github.com/decocms/studio/sandbox-daemon/internal/proc"
	"github.com/decocms/studio/sandbox-daemon/internal/proxy"
	"github.com/decocms/studio/sandbox-daemon/internal/routes"
	"github.com/decocms/studio/sandbox-daemon/internal/setup"
	"github.com/decocms/studio/sandbox-daemon/internal/toolscatalog"
)

const (
	sandboxPrefix       = "/_sandbox"
	legacySandboxPrefix = "/_decopilot_vm"
)

func randomUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b)
	return fmt.Sprintf("%s-%s-%s-%s-%s", s[0:8], s[8:12], s[12:16], s[16:20], s[20:32])
}

// The workspace-touching routes, and the reason they are one map: they are also
// the set that resolves relative `org/...` paths, so the org-fs link hook and
// the handler lookup must never drift apart.
var fsRoutes = map[string]string{
	"/read": "read", "/write": "write", "/unlink": "unlink", "/mkdir": "mkdir",
	"/rename": "rename", "/edit": "edit", "/grep": "grep", "/glob": "glob",
	"/write_from_url": "write_from_url", "/upload_to_url": "upload_to_url",
	"/bash": "bash",
}

func isFsRoute(vmPath string) bool {
	_, ok := fsRoutes[vmPath]
	return ok
}

type daemon struct {
	mu              sync.Mutex
	token           string
	bootId          string
	appRoot         string
	repoDir         string
	tmpDir          string
	currentStatus   events.DaemonStatus
	lastRunningPort int
	baselineTimer   *time.Timer
	firstWorkLogged bool

	broadcaster   *events.Broadcaster
	sniffer       *proc.PortSniffer
	store         *config.Store
	installState  *setup.InstallState
	lifecycle     *lifecycle.Manager
	phases        *proc.PhaseManager
	tasks         *proc.TaskManager
	branchStatus  *gitx.BranchStatusMonitor
	orchestrator  *setup.Orchestrator
	prober        *probe.Prober
	proxyHandler  *proxy.Handler
	dispatchReg   *dispatch.Registry
	dispatchDeps  dispatch.Deps
	harnessRunner *dispatch.Runner
	orgFsLinks    *orgfs.Links

	fileChangedMu    sync.Mutex
	fileChangedTimer *time.Timer
	pendingPaths     map[string]struct{}

	shuttingDown bool

	handlers map[string]http.HandlerFunc
}

func (d *daemon) getToken() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.token
}

func (d *daemon) setToken(next string) {
	d.mu.Lock()
	d.token = next
	d.mu.Unlock()
	os.Setenv("DAEMON_TOKEN", next)
}

func (d *daemon) setStatus(next events.DaemonStatus) {
	d.mu.Lock()
	d.currentStatus = next
	d.mu.Unlock()
	d.broadcaster.Emit("status", next)
}

func (d *daemon) getStatus() events.DaemonStatus {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.currentStatus
}

func (d *daemon) getDevPort() int {
	if port := d.sniffer.Current(); port != 0 {
		return port
	}
	if cfg := d.store.Read(); cfg != nil {
		if port, ok := cfg.Port(); ok {
			return port
		}
	}
	return 0
}

func (d *daemon) getActiveTasks() []events.ActiveTaskSummary {
	running := d.tasks.List([]string{proc.StatusRunning})
	out := make([]events.ActiveTaskSummary, 0, len(running))
	for _, t := range running {
		out = append(out, events.ActiveTaskSummary{ID: t.ID, Command: t.Command, LogName: t.LogName})
	}
	return out
}

const fileChangedDebounce = 300 * time.Millisecond

func (d *daemon) emitFileChanged(path string) {
	d.fileChangedMu.Lock()
	defer d.fileChangedMu.Unlock()
	d.pendingPaths[path] = struct{}{}
	if d.fileChangedTimer != nil {
		d.fileChangedTimer.Stop()
	}
	d.fileChangedTimer = time.AfterFunc(fileChangedDebounce, func() {
		d.fileChangedMu.Lock()
		paths := d.pendingPaths
		d.pendingPaths = map[string]struct{}{}
		d.fileChangedTimer = nil
		d.fileChangedMu.Unlock()
		for p := range paths {
			d.broadcaster.Emit("file-changed", map[string]string{"path": p})
		}
	})
}

func (d *daemon) onProbeChange(s probe.State) {
	phase := d.lifecycle.Current().Phase
	if s.Status == probe.StatusOnline && s.Port != 0 {
		d.mu.Lock()
		isCrashedRecovery := phase == events.PhaseCrashed && s.Port == d.lastRunningPort
		d.mu.Unlock()
		if phase != events.PhaseStarting && phase != events.PhaseRunning && !isCrashedRecovery {
			return
		}
		d.mu.Lock()
		d.lastRunningPort = s.Port
		d.mu.Unlock()
		wasDown := phase == events.PhaseStarting || phase == events.PhaseCrashed
		d.lifecycle.Transition(events.LifecycleState{
			Phase: events.PhaseRunning, Port: s.Port, HtmlSupport: s.HtmlSupport,
		})
		if wasDown {
			d.broadcaster.Emit("reload", map[string]any{})
			go d.orchestrator.PublishPendingGolden()
		}
		d.mu.Lock()
		if d.baselineTimer == nil {
			d.baselineTimer = time.AfterFunc(3*time.Second, func() {
				d.mu.Lock()
				d.baselineTimer = nil
				d.mu.Unlock()
				d.branchStatus.ArmBaseline()
			})
		}
		d.mu.Unlock()
	} else if s.Status == probe.StatusOffline {
		if phase != events.PhaseRunning {
			return
		}
		d.lifecycle.Transition(events.LifecycleState{Phase: events.PhaseCrashed})
		d.sniffer.Reset()
		d.mu.Lock()
		if d.baselineTimer != nil {
			d.baselineTimer.Stop()
			d.baselineTimer = nil
		}
		d.mu.Unlock()
		d.branchStatus.ClearBaseline()
	}
}

func matchSandboxPrefix(pathname string) (prefix, suffix string, ok bool) {
	for _, p := range []string{sandboxPrefix, legacySandboxPrefix} {
		if pathname == p || pathname == p+"/" {
			return p, "/", true
		}
		if strings.HasPrefix(pathname, p+"/") {
			return p, pathname[len(p):], true
		}
	}
	return "", "", false
}

var (
	tasksStreamRe = regexp.MustCompile(`^/tasks/[^/]+/stream$`)
	tasksKillRe   = regexp.MustCompile(`^/tasks/[^/]+/kill$`)
	tasksIdRe     = regexp.MustCompile(`^/tasks/[^/]+$`)
)

var corsHeaders = map[string]string{
	"Access-Control-Allow-Origin":  "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
	"Access-Control-Allow-Headers": "Content-Type, Accept, Cache-Control, Authorization",
}

func (d *daemon) vmRoute(w http.ResponseWriter, r *http.Request, prefix, vmPath string) {
	method := r.Method

	if method == "GET" && vmPath == "/idle" {
		d.handlers["idle"](w, r)
		return
	}
	if method == "GET" && vmPath == "/events" {
		d.handlers["events"](w, r)
		return
	}
	if method == "GET" && vmPath == "/scripts" {
		d.handlers["scripts"](w, r)
		return
	}
	if method == "OPTIONS" {
		h := w.Header()
		for k, v := range corsHeaders {
			h.Set(k, v)
		}
		w.WriteHeader(204)
		return
	}

	if method == "POST" && vmPath == "/dispatch" {
		d.dispatchReg.HandleDispatch(w, r, d.dispatchDeps)
		return
	}
	if method == "DELETE" && strings.HasPrefix(vmPath, "/runs/") {
		d.dispatchReg.HandleCancel(w, r, d.getToken)
		return
	}

	if !auth.TokenOK(r, d.getToken()) {
		httpx.Error(w, 401, "unauthorized")
		return
	}

	// Hosted harnesses drive the sandbox through the fs/exec routes WITHOUT a
	// /dispatch envelope, so the org links must be ensured here too — before
	// bash/read/write resolve the prompts' relative `org/...` paths. vm-tools
	// stamp the thread on each call (x-thread-id) so `org/output` can point at the
	// running thread's folder; memoized, so repeat calls cost one lstat. ONLY
	// these routes: gating /orgfs-config would deadlock provisioning into the full
	// fail-open wait (the mounts it polls for appear only after that POST lands),
	// and gating /setup/clone would create `repo/org` ahead of the clone — the
	// boot-time hazard the repo link is deliberately deferred to avoid.
	if method == "POST" && (isFsRoute(vmPath) || strings.HasPrefix(vmPath, "/exec/")) {
		if threadId := r.Header.Get("x-thread-id"); threadId != "" {
			d.orgFsLinks.RepointForRun(threadId)
		} else {
			d.orgFsLinks.EnsureRepoLink()
		}
	}

	if vmPath == "/config" {
		switch method {
		case "GET":
			d.handlers["config-read"](w, r)
		case "PUT", "POST":
			d.handlers["config-update"](w, r)
		default:
			httpx.Error(w, 404, fmt.Sprintf("Not found: %s/config", prefix))
		}
		return
	}
	if method == "POST" && vmPath == "/orgfs-config" {
		d.handlers["orgfs-config"](w, r)
		return
	}
	if strings.HasPrefix(vmPath, "/tasks") {
		switch {
		case method == "GET" && vmPath == "/tasks":
			d.handlers["tasks-list"](w, r)
		case method == "POST" && vmPath == "/tasks/kill-all":
			d.handlers["tasks-kill-all"](w, r)
		case method == "GET" && tasksStreamRe.MatchString(vmPath):
			d.handlers["tasks-stream"](w, r)
		case method == "POST" && tasksKillRe.MatchString(vmPath):
			d.handlers["tasks-kill"](w, r)
		case method == "DELETE" && tasksIdRe.MatchString(vmPath):
			d.handlers["tasks-delete"](w, r)
		case method == "GET" && tasksIdRe.MatchString(vmPath):
			d.handlers["tasks-get"](w, r)
		default:
			httpx.Error(w, 404, fmt.Sprintf("Not found: %s%s", prefix, vmPath))
		}
		return
	}
	if method == "POST" {
		switch vmPath {
		case "/tools/sync":
			d.handlers["tools-sync"](w, r)
			return
		case "/setup/clone":
			d.handlers["setup-clone"](w, r)
			return
		case "/setup/install":
			d.handlers["setup-install"](w, r)
			return
		case "/setup/start":
			d.handlers["setup-start"](w, r)
			return
		}
	}
	gitRoutes := map[string]string{
		"/git/status": "git-status", "/git/diff": "git-diff", "/git/publish": "git-publish",
		"/git/discard": "git-discard", "/git/rebase": "git-rebase",
	}
	if name, ok := gitRoutes[vmPath]; ok && (method == "GET" || method == "POST") {
		d.handlers[name](w, r)
		return
	}
	if name, ok := fsRoutes[vmPath]; ok && method == "POST" {
		d.handlers[name](w, r)
		return
	}
	if method == "POST" && strings.HasPrefix(vmPath, "/exec/") {
		if strings.HasSuffix(vmPath, "/kill") {
			rawName := vmPath[len("/exec/") : len(vmPath)-len("/kill")]
			name := rawName
			killed := d.tasks.KillByLogName(name, true, syscall.SIGTERM)
			httpx.JSON(w, 200, map[string]any{"killed": killed})
			return
		}
		d.handlers["exec"](w, r)
		return
	}

	httpx.Error(w, 404, fmt.Sprintf("Not found: %s%s", prefix, vmPath))
}

func (d *daemon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	method := r.Method

	if p != "/health" && p != sandboxPrefix+"/idle" && p != legacySandboxPrefix+"/idle" {
		activity.Bump()
		d.mu.Lock()
		if !d.firstWorkLogged {
			d.firstWorkLogged = true
			slog.Info("daemon first request", "boot_id", d.bootId, "method", method, "path", p)
		}
		d.mu.Unlock()
	}

	prefix, suffix, isSandbox := matchSandboxPrefix(p)

	if proxy.IsWebSocketUpgrade(r) && !isSandbox {
		proxy.ServeWs(w, r, proxy.WsDeps{
			GetDevPort:   d.getDevPort,
			OnClientData: func() { activity.Bump() },
		})
		return
	}

	if method == "GET" && p == "/health" {
		d.handlers["health"](w, r)
		return
	}
	if isSandbox {
		d.vmRoute(w, r, prefix, suffix)
		return
	}
	d.proxyHandler.ServeHTTP(w, r)
}

func (d *daemon) shutdown() {
	d.mu.Lock()
	if d.shuttingDown {
		d.mu.Unlock()
		return
	}
	d.shuttingDown = true
	d.mu.Unlock()

	d.tasks.Shutdown()
	d.branchStatus.Stop()
	// Before the publish, and unconditionally: the runner holds harness CLIs that
	// would otherwise keep writing into the tree the publish is about to commit.
	d.harnessRunner.Shutdown()

	cfg := d.store.Read()
	if cfg != nil && cfg.Branch() != "" {
		err := gitx.Publish(gitx.PublishDeps{
			RepoDir:     d.repoDir,
			GetCloneUrl: func() string { return cfg.CloneUrl() },
			GetOperator: d.operatorIdentity,
			// "skip", not "throw": an invalid block must not abort the whole
			// shutdown sync and lose the user's other valid work.
			OnInvalidBlock: gitx.InvalidBlockSkip,
		}, "chore(daemon): sync all local changes to remote on shutdown")
		if err != nil {
			slog.Error("shutdown publish failed", "err", err)
		}
	}
	os.Exit(0)
}

func (d *daemon) operatorIdentity() *gitx.CoAuthorIdentity {
	cfg := d.store.Read()
	if cfg == nil || cfg.Operator == nil || cfg.Operator.UserName == nil {
		return nil
	}
	id := &gitx.CoAuthorIdentity{UserName: *cfg.Operator.UserName}
	if cfg.Operator.UserEmail != nil {
		id.UserEmail = *cfg.Operator.UserEmail
	}
	return id
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, nil)))

	bootId := os.Getenv("DAEMON_BOOT_ID")
	if bootId == "" {
		bootId = randomUUID()
		os.Setenv("DAEMON_BOOT_ID", bootId)
	}

	appRoot := os.Getenv("WORKDIR")
	if appRoot == "" {
		appRoot = os.Getenv("APP_ROOT")
	}
	if appRoot == "" {
		appRoot = "/"
	}
	portStr := os.Getenv("DAEMON_PORT")
	if portStr == "" {
		portStr = os.Getenv("PROXY_PORT")
	}
	if portStr == "" {
		portStr = "9000"
	}
	os.Setenv("DAEMON_PORT", portStr)
	port, err := strconv.Atoi(portStr)
	if err != nil {
		slog.Error("invalid port", "port", portStr)
		os.Exit(1)
	}

	repoDir := filepath.Join(appRoot, "repo")
	tmpDir := filepath.Join(appRoot, "tmp")
	os.MkdirAll(repoDir, 0o755)

	var offloadHosts []string
	for _, h := range strings.Split(os.Getenv("OFFLOAD_ALLOWED_HOSTS"), ",") {
		h = strings.TrimSpace(h)
		if h != "" {
			offloadHosts = append(offloadHosts, h)
		}
	}

	d := &daemon{
		token:         os.Getenv("DAEMON_TOKEN"),
		bootId:        bootId,
		appRoot:       appRoot,
		repoDir:       repoDir,
		tmpDir:        tmpDir,
		currentStatus: events.DaemonStatus{State: "running"},
		pendingPaths:  map[string]struct{}{},
	}

	d.broadcaster = events.NewBroadcaster(routes.ReplayBytesCapacity)
	d.sniffer = proc.NewPortSniffer()
	d.broadcaster.ChunkObserver = func(source, data string) {
		d.sniffer.Observe(source, data)
	}

	d.store = config.NewStore()
	d.installState = setup.NewInstallState()
	d.lifecycle = lifecycle.New(d.broadcaster)
	d.lifecycle.OnTransition = func(prev, next events.LifecycleState) {
		if prev.Phase == events.PhaseRunning && next.Phase != events.PhaseRunning {
			d.sniffer.Reset()
			if d.prober != nil {
				d.prober.Reset()
			}
		}
		if prev.Phase != next.Phase {
			slog.Info("lifecycle transition", "from", prev.Phase, "to", next.Phase)
		}
	}

	d.phases = proc.NewPhaseManager()
	d.tasks = proc.NewTaskManager(proc.TaskManagerDeps{
		LogsDir:      tmpDir,
		PhaseManager: d.phases,
		OnChange: func() {
			d.broadcaster.Emit("tasks", map[string]any{"active": d.getActiveTasks()})
		},
		BroadcastChunk: func(source, data string, tee bool) {
			d.broadcaster.BroadcastChunk(source, data, events.ChunkOpts{Tee: tee})
		},
	})
	d.tasks.OnTaskExit(func(s proc.TaskSummary) {
		label := s.LogName
		if label == "" {
			label = s.ID
		}
		slog.Info("task exit", "task", label, "status", s.Status, "exit_code", s.ExitCode)
	})

	// The watcher is what makes edits the daemon did not perform itself visible —
	// a CLI harness writes through `bash`, so the fs routes never see them.
	d.branchStatus = gitx.NewBranchStatusMonitor(repoDir, d.broadcaster, d.emitFileChanged)

	d.orchestrator = setup.NewOrchestrator(setup.OrchestratorDeps{
		AppRoot:      appRoot,
		RepoDir:      repoDir,
		LogsDir:      tmpDir,
		Store:        d.store,
		TaskManager:  d.tasks,
		SetStatus:    d.setStatus,
		GetStatus:    d.getStatus,
		Broadcaster:  d.broadcaster,
		InstallState: d.installState,
		Lifecycle:    d.lifecycle,
		BranchStatus: d.branchStatus,
	})
	d.store.Subscribe(func(e config.ApplyEvent) {
		d.orchestrator.Handle(e.Transition)
	})

	d.prober = probe.Start(probe.Deps{
		GetPort:  d.getDevPort,
		OnChange: d.onProbeChange,
		OnLog:    func(msg string) { d.broadcaster.BroadcastChunk("setup", msg) },
	})

	d.proxyHandler = proxy.New(proxy.Deps{
		GetDevPort: d.getDevPort,
		Log: func(msg string) {
			d.broadcaster.BroadcastChunk("daemon",
				fmt.Sprintf("[daemon] %s %s\r\n", time.Now().UTC().Format(time.RFC3339Nano), msg))
		},
	})

	// Org-fs: this daemon links, the privileged sidecar mounts (see
	// internal/orgfs/links.go). Inert unless the pod sets the sidecar env.
	d.orgFsLinks = &orgfs.Links{
		AppRoot:    appRoot,
		RepoDir:    repoDir,
		StatusPath: os.Getenv("ORGFS_SIDECAR_STATUS_PATH"),
		ConfigPath: os.Getenv("ORGFS_SIDECAR_CONFIG_PATH"),
	}
	// Fail loud rather than silently unmounted: ORGFS_CONFIG is the desktop's
	// "mount them yourself" env, which only the TS bundle implements.
	if os.Getenv("ORGFS_CONFIG") != "" && d.orgFsLinks.StatusPath == "" {
		slog.Warn("ORGFS_CONFIG is set but this daemon does not mount org volumes " +
			"(cluster sidecar path only) — org files will not appear in the workspace")
	}
	// Same rule for the golden cache's remote tier: the pod may be configured for
	// L2, but this daemon implements L1 only. Boots stay correct, just slower.
	if os.Getenv("GOLDEN_CACHE_REMOTE") != "" {
		slog.Warn("GOLDEN_CACHE_REMOTE is set but this daemon implements the " +
			"node-local golden tier only — remote restore/publish is skipped")
	}

	catalogSync := toolscatalog.NewCoalescer(
		toolscatalog.Opts{AppRoot: appRoot, RepoDir: repoDir},
		toolscatalog.DefaultSyncMinInterval,
	)

	d.dispatchReg = dispatch.NewRegistry()
	d.harnessRunner = dispatch.NewRunner()
	d.dispatchDeps = dispatch.Deps{
		DaemonToken:      d.getToken,
		AppRoot:          appRoot,
		AllowedHosts:     offloadHosts,
		AllowSameHostDev: os.Getenv("OFFLOAD_ALLOW_SAME_HOST_DEV") == "1",
		HarnessRunnerCmd: dispatch.ParseRunnerCmd(os.Getenv("HARNESS_RUNNER_CMD")),
		Runner:           d.harnessRunner,
		// Share-files-back: point `org/output` at this run's thread subtree before
		// the harness can touch it. A failure degrades to no link, never blocks the
		// run. Same call refreshes `.deco/tools/` from the run's MCP endpoint
		// (coalesced in the background) so a renamed tool does not stay stale until
		// something calls /tools/sync explicitly.
		BeforeRun: func(info dispatch.RunInfo) {
			d.orgFsLinks.RepointForRun(info.ThreadId)
			catalogSync.Sync(toolscatalog.Endpoint{
				URL:       info.McpURL,
				Headers:   info.McpHeaders,
				ExpiresAt: info.McpExpiresAt,
			})
		},
	}

	fsDeps := routes.FsDeps{
		AppRoot: appRoot,
		RepoDir: repoDir,
		OnWorkingTreeWrite: func(path string) {
			d.branchStatus.Refresh()
			d.emitFileChanged(path)
		},
		AllowedHosts:     offloadHosts,
		AllowSameHostDev: os.Getenv("OFFLOAD_ALLOW_SAME_HOST_DEV") == "1",
	}
	gitDeps := routes.GitDeps{
		AppRoot: appRoot,
		RepoDir: repoDir,
		GetCloneUrl: func() string {
			if cfg := d.store.Read(); cfg != nil {
				return cfg.CloneUrl()
			}
			return ""
		},
		GetOperator: d.operatorIdentity,
	}
	tasksDeps := routes.TasksDeps{TaskManager: d.tasks}
	getOrch := func() routes.OrchestratorState {
		return routes.OrchestratorState{
			Running: d.orchestrator.IsRunning(),
			Pending: d.orchestrator.PendingCount(),
		}
	}
	isReady := func() bool { return d.lifecycle.Current().Phase == events.PhaseRunning }

	d.handlers = map[string]http.HandlerFunc{
		"health": routes.Health(routes.HealthDeps{
			DaemonBootId:    bootId,
			GetReady:        isReady,
			GetOrchestrator: getOrch,
			GetConfigured:   func() bool { return d.store.Read() != nil },
		}),
		"idle": routes.Idle(),
		"scripts": routes.Scripts(func() []string {
			if cached, ok := d.orchestrator.DiscoveredScripts(); ok {
				return cached
			}
			cfg := d.store.Read()
			if cfg == nil || cfg.PmName() == "" {
				return []string{}
			}
			cwd := cfg.PmPath()
			if cwd == "" {
				cwd = repoDir
			} else if !filepath.IsAbs(cwd) {
				cwd = filepath.Join(repoDir, cwd)
			}
			return proc.DiscoverScripts(cwd, cfg.PmName())
		}),
		"events": routes.EventsStream(routes.EventsDeps{
			Broadcaster:          d.broadcaster,
			GetLifecycle:         d.lifecycle.Current,
			GetDiscoveredScripts: d.orchestrator.DiscoveredScripts,
			GetActiveTasks:       d.getActiveTasks,
			GetStatus:            d.getStatus,
			GetBranchMeta:        d.branchStatus.GetLast,
		}),
		"config-read": routes.ConfigRead(routes.ConfigDeps{
			DaemonBootId:    bootId,
			Store:           d.store,
			GetOrchestrator: getOrch,
			GetReady:        isReady,
			GetTasks:        func() []proc.Phase { return d.phases.Recent(20) },
			RepoDir:         repoDir,
		}),
		"config-update": routes.ConfigUpdate(routes.ConfigDeps{
			DaemonBootId:   bootId,
			Store:          d.store,
			SetDaemonToken: d.setToken,
		}),
		"orgfs-config": routes.OrgFsConfig(routes.OrgFsDeps{
			ConfigPath: os.Getenv("ORGFS_SIDECAR_CONFIG_PATH"),
		}),
		"read":           routes.Read(fsDeps),
		"write":          routes.Write(fsDeps),
		"unlink":         routes.Unlink(fsDeps),
		"mkdir":          routes.Mkdir(fsDeps),
		"rename":         routes.Rename(fsDeps),
		"edit":           routes.Edit(fsDeps),
		"grep":           routes.Grep(fsDeps),
		"glob":           routes.Glob(fsDeps),
		"write_from_url": routes.WriteFromUrl(fsDeps),
		"upload_to_url":  routes.UploadToUrl(fsDeps),
		"bash":           routes.Bash(routes.BashDeps{RepoDir: repoDir, TaskManager: d.tasks}),
		"git-status":     routes.GitStatus(gitDeps),
		"git-diff":       routes.GitDiff(gitDeps),
		"git-publish":    routes.GitPublish(gitDeps),
		"git-discard":    routes.GitDiscard(gitDeps),
		"git-rebase":     routes.GitRebase(gitDeps),
		"tasks-list":     routes.TasksList(tasksDeps),
		"tasks-get":      routes.TasksGet(tasksDeps),
		"tasks-kill":     routes.TasksKill(tasksDeps),
		"tasks-kill-all": routes.TasksKillAll(tasksDeps),
		"tasks-delete":   routes.TasksDelete(tasksDeps),
		"tasks-stream":   routes.TasksStream(tasksDeps),
		"exec": routes.Exec(routes.ExecDeps{
			RepoDir:     repoDir,
			Store:       d.store,
			TaskManager: d.tasks,
			Lifecycle:   d.lifecycle,
			GetStatus:   d.getStatus,
			SetStatus:   d.setStatus,
		}),
		"tools-sync":    routes.ToolsSync(routes.ToolsDeps{AppRoot: appRoot, RepoDir: repoDir}),
		"setup-clone":   routes.Setup("clone", func(string) { d.orchestrator.ResumeFrom(setup.StepClone) }),
		"setup-install": routes.Setup("install", func(string) { d.orchestrator.ResumeFrom(setup.StepInstall) }),
		"setup-start":   routes.Setup("start", func(string) { d.orchestrator.ResumeFrom(setup.StepStart) }),
	}

	if diskCfg, ok := config.ReadDiskConfig(repoDir); ok {
		d.store.Hydrate(diskCfg)
		d.orchestrator.Handle(config.Transition{Kind: config.KindBootstrap, Config: diskCfg})
	}
	if d.store.Read() == nil {
		slog.Info("daemon ready, unclaimed — waiting for workload config", "boot_id", bootId)
	}

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigs
		d.shutdown()
	}()

	server := &http.Server{
		Addr:              fmt.Sprintf("0.0.0.0:%d", port),
		Handler:           d,
		ReadHeaderTimeout: 30 * time.Second,
	}
	slog.Error("http server exited", "err", server.ListenAndServe())
	os.Exit(1)
}
