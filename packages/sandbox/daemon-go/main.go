package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/activity"
	"github.com/decocms/studio/sandbox-daemon/internal/auth"
	"github.com/decocms/studio/sandbox-daemon/internal/config"
	"github.com/decocms/studio/sandbox-daemon/internal/decofile"
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
	"github.com/decocms/studio/sandbox-daemon/internal/telemetry"
	"github.com/decocms/studio/sandbox-daemon/internal/toolscatalog"
	"github.com/decocms/studio/sandbox-daemon/internal/worktree"
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

var sandboxPrefixes = []string{sandboxPrefix, legacySandboxPrefix}

func isSandboxPath(pathname string) bool {
	for _, p := range sandboxPrefixes {
		if pathname == p || strings.HasPrefix(pathname, p+"/") {
			return true
		}
	}
	return false
}

// Zero for the boot-to-serving measurement. A package var so it is stamped at
// process start — anything later would silently exclude whatever ran before it.
var processStartedAt = time.Now()

type daemon struct {
	mu              sync.Mutex
	readyOnce       sync.Once
	token           string
	bootId          string
	appRoot         string
	repoDir         string
	tmpDir          string
	currentStatus   events.DaemonStatus
	lastRunningPort int
	baselineTimer   *time.Timer
	firstWorkLogged bool

	broadcaster  *events.Broadcaster
	sniffer      *proc.PortSniffer
	store        *config.Store
	installState *setup.InstallState
	lifecycle    *lifecycle.Manager
	phases       *proc.PhaseManager
	tasks        *proc.TaskManager
	branchStatus *gitx.BranchStatusMonitor
	orchestrator *setup.Orchestrator
	prober       *probe.Prober
	proxyHandler *proxy.Handler
	dispatchReg  *dispatch.Registry
	dispatchDeps dispatch.Deps
	orgFsLinks   *orgfs.Links

	fileChangedMu    sync.Mutex
	fileChangedTimer *time.Timer
	pendingPaths     map[string]struct{}

	decofileDeps        routes.DecofileDeps
	decofileMu          sync.Mutex
	lastDecofileVersion string

	shuttingDown bool

	// treeLock serializes every mutation of the shared working tree. Shared
	// sandboxes put every org member's writes through this one daemon.
	treeLock worktree.Lock

	health http.HandlerFunc
	mux    *http.ServeMux

	// Bounded metric flush on the SIGTERM path; nil when metrics are off.
	otelShutdown func(context.Context) error
}

// sandboxHandlers is the daemon API's leaf handlers, built once and mounted
// under each prefix by registerSandboxRoutes.
type sandboxHandlers struct {
	events, scripts, decofile             http.HandlerFunc
	configRead, configUpdate, orgfsConfig http.HandlerFunc
	tasksList, tasksGet, tasksDelete      http.HandlerFunc
	tasksKill, tasksKillAll, tasksStream  http.HandlerFunc
	toolsSync, exec                       http.HandlerFunc
	fs, git, setup                        map[string]http.HandlerFunc
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
		touchedBlocks := false
		for p := range paths {
			d.broadcaster.Emit("file-changed", map[string]string{"path": p})
			if decofile.IsBlockPath(p) {
				touchedBlocks = true
			}
		}
		if touchedBlocks {
			go d.announceDecofileVersion()
		}
	})
}

// announceDecofileVersion recomputes the merged blocks' version and, if it
// changed, broadcasts it. The single trigger point for both "tree just
// landed" (lifecycle.OnTransition) and "a blocks file changed"
// (emitFileChanged) — the unchanged-hash guard means the two paths can't
// double-emit.
func (d *daemon) announceDecofileVersion() {
	merged, ok := routes.ReadDecofile(d.decofileDeps)
	if !ok {
		return
	}
	d.decofileMu.Lock()
	if merged.Version == d.lastDecofileVersion {
		d.decofileMu.Unlock()
		return
	}
	d.lastDecofileVersion = merged.Version
	d.decofileMu.Unlock()
	d.broadcaster.Emit("decofile", map[string]any{"version": merged.Version})
}

func (d *daemon) getDecofileVersion() (string, bool) {
	d.decofileMu.Lock()
	defer d.decofileMu.Unlock()
	return d.lastDecofileVersion, d.lastDecofileVersion != ""
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

var corsHeaders = map[string]string{
	"Access-Control-Allow-Origin":  "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
	"Access-Control-Allow-Headers": "Content-Type, Accept, Cache-Control, Authorization",
}

func corsPreflight(w http.ResponseWriter, _ *http.Request) {
	h := w.Header()
	for k, v := range corsHeaders {
		h.Set(k, v)
	}
	w.WriteHeader(204)
}

// authed gates a handler on the daemon token. Also wraps the catch-all, so an
// unauthenticated caller cannot enumerate routes.
func (d *daemon) authed(fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !auth.TokenOK(r, d.getToken()) {
			httpx.Error(w, 401, "unauthorized")
			return
		}
		fn(w, r)
	}
}

// linked ensures this run's org-fs links before the handler runs. Hosted
// harnesses drive the sandbox through fs/exec without a /dispatch envelope, so
// the links must be ensured here too, keyed on x-thread-id. Applied to the fs
// and exec routes only: gating /orgfs-config would deadlock provisioning on
// mounts that appear only after that POST, and gating /setup/clone would create
// `repo/org` ahead of the clone.
func (d *daemon) linked(fn http.HandlerFunc) http.HandlerFunc {
	return d.authed(func(w http.ResponseWriter, r *http.Request) {
		if threadId := r.Header.Get("x-thread-id"); threadId != "" {
			d.orgFsLinks.RepointForRun(threadId)
		} else {
			d.orgFsLinks.EnsureRepoLink()
		}
		fn(w, r)
	})
}

// The workspace-touching routes. One list because it is also the set that
// resolves relative `org/...` paths: registration and the org-fs link hook are
// the same loop below, so they cannot drift apart.
var fsRouteNames = []string{
	"read", "write", "unlink", "mkdir", "rename", "edit", "grep", "glob",
	"write_from_url", "upload_to_url", "bash",
}

// The subset of the above that mutates the tree, and so runs under the worktree
// lock. `bash` mutates too but cannot be held: it is long-running and taking the
// lock around it would stall every other writer for the length of a command —
// so a bash write can still interleave with a publish. Git routes that only read
// (status, diff) are likewise unguarded; the UI polls them.
var mutatingFsRoutes = map[string]bool{
	"write": true, "edit": true, "unlink": true, "mkdir": true,
	"rename": true, "write_from_url": true,
}

var mutatingGitRoutes = map[string]bool{
	"publish": true, "discard": true, "rebase": true,
}

// treeGuarded serializes a handler against every other tree mutation.
func (d *daemon) treeGuarded(fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		defer d.treeLock.Acquire()()
		fn(w, r)
	}
}

// registerSandboxRoutes mounts the daemon's own API under one prefix. Called
// once per prefix: /_sandbox is canonical, /_decopilot_vm is served for one
// release window.
func (d *daemon) registerSandboxRoutes(mux *http.ServeMux, pre string, h sandboxHandlers) {
	// Unauthenticated: liveness, the event stream, script discovery, the draft
	// decofile pull, preflight.
	mux.HandleFunc("GET "+pre+"/idle", routes.Idle())
	mux.HandleFunc("GET "+pre+"/events", h.events)
	mux.HandleFunc("GET "+pre+"/scripts", h.scripts)
	mux.HandleFunc("GET "+pre+"/decofile", h.decofile)
	mux.HandleFunc("OPTIONS "+pre, corsPreflight)
	mux.HandleFunc("OPTIONS "+pre+"/", corsPreflight)

	// Dispatch checks the token itself, so it can answer over SSE.
	mux.HandleFunc("POST "+pre+"/dispatch", func(w http.ResponseWriter, r *http.Request) {
		d.dispatchReg.HandleDispatch(w, r, d.dispatchDeps)
	})
	mux.HandleFunc("DELETE "+pre+"/runs/{runId}", func(w http.ResponseWriter, r *http.Request) {
		d.dispatchReg.HandleCancel(w, r, d.getToken)
	})

	mux.HandleFunc("GET "+pre+"/config", d.authed(h.configRead))
	mux.HandleFunc("PUT "+pre+"/config", d.authed(h.configUpdate))
	mux.HandleFunc("POST "+pre+"/config", d.authed(h.configUpdate))
	mux.HandleFunc("POST "+pre+"/orgfs-config", d.authed(h.orgfsConfig))

	mux.HandleFunc("GET "+pre+"/tasks", d.authed(h.tasksList))
	mux.HandleFunc("POST "+pre+"/tasks/kill-all", d.authed(h.tasksKillAll))
	mux.HandleFunc("GET "+pre+"/tasks/{id}", d.authed(h.tasksGet))
	mux.HandleFunc("DELETE "+pre+"/tasks/{id}", d.authed(h.tasksDelete))
	mux.HandleFunc("GET "+pre+"/tasks/{id}/stream", d.authed(h.tasksStream))
	mux.HandleFunc("POST "+pre+"/tasks/{id}/kill", d.authed(h.tasksKill))

	mux.HandleFunc("POST "+pre+"/tools/sync", d.authed(h.toolsSync))
	for _, step := range []string{"clone", "install", "start"} {
		mux.HandleFunc("POST "+pre+"/setup/"+step, d.authed(h.setup[step]))
	}

	for name, fn := range h.git {
		if mutatingGitRoutes[name] {
			fn = d.treeGuarded(fn)
		}
		mux.HandleFunc("GET "+pre+"/git/"+name, d.authed(fn))
		mux.HandleFunc("POST "+pre+"/git/"+name, d.authed(fn))
	}

	for _, name := range fsRouteNames {
		fn := h.fs[name]
		if mutatingFsRoutes[name] {
			fn = d.treeGuarded(fn)
		}
		mux.HandleFunc("POST "+pre+"/"+name, d.linked(fn))
	}

	mux.HandleFunc("POST "+pre+"/exec/{name}", d.linked(h.exec))
	mux.HandleFunc("POST "+pre+"/exec/{name}/kill", d.linked(func(w http.ResponseWriter, r *http.Request) {
		killed := d.tasks.KillByLogName(r.PathValue("name"), true, syscall.SIGTERM)
		httpx.JSON(w, 200, map[string]any{"killed": killed})
	}))

	notFound := d.authed(func(w http.ResponseWriter, r *http.Request) {
		httpx.Error(w, 404, "Not found: "+r.URL.Path)
	})
	mux.HandleFunc(pre, notFound)
	mux.HandleFunc(pre+"/", notFound)
}

func (d *daemon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path

	if p != "/health" && p != sandboxPrefix+"/idle" && p != legacySandboxPrefix+"/idle" {
		activity.Bump()
		d.mu.Lock()
		if !d.firstWorkLogged {
			d.firstWorkLogged = true
			slog.Info("daemon first request", "boot_id", d.bootId, "method", r.Method, "path", p)
		}
		d.mu.Unlock()
	}

	if proxy.IsWebSocketUpgrade(r) && !isSandboxPath(p) {
		proxy.ServeWs(w, r, proxy.WsDeps{
			GetDevPort:   d.getDevPort,
			OnClientData: func() { activity.Bump() },
		})
		return
	}
	if r.Method == "GET" && p == "/health" {
		d.health(w, r)
		return
	}
	// Only the daemon's own API goes through the mux. The dev-server proxy stays
	// off it: ServeMux cleans and 301-redirects paths, which is right for our
	// routes and wrong for whatever the tenant's server serves.
	if isSandboxPath(p) {
		d.mux.ServeHTTP(w, r)
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
	// Before the publish, and unconditionally: a running harness holds CLIs that
	// would otherwise keep writing into the tree the publish is about to commit.
	d.dispatchReg.CancelAll()

	cfg := d.store.Read()
	if cfg != nil && cfg.Branch() != "" {
		publishStartedAt := time.Now()
		release := d.treeLock.Acquire()
		err := gitx.Publish(gitx.PublishDeps{
			RepoDir:     d.repoDir,
			GetCloneUrl: func() string { return cfg.CloneUrl() },
			GetOperator: d.operatorIdentity,
			// "skip", not "throw": an invalid block must not abort the whole
			// shutdown sync and lose the user's other valid work.
			OnInvalidBlock: gitx.InvalidBlockSkip,
		}, "chore(daemon): sync all local changes to remote on shutdown")
		release()
		status := "done"
		if err != nil {
			status = "failed"
			slog.Error("shutdown publish failed", "err", err)
		}
		telemetry.RecordPublish(context.Background(), status, time.Since(publishStartedAt).Milliseconds())
	}
	// Flush the current export window. os.Exit below skips main's deferred
	// shutdown, so without this a sandbox torn down inside the 30s interval
	// reports nothing — and short-lived pods are exactly the boots a cold-start
	// comparison cares about. Bounded at 2s, AFTER the publish: an unreachable
	// collector must not spend the grace period that saves the user's work.
	// The TS daemon races the same 2s budget at the same point.
	if d.otelShutdown != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = d.otelShutdown(ctx)
		cancel()
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

// runGoldenUploader is the node-level bridge from the L1 hostPath store to the
// shared one. Same binary as the daemon on purpose: the logic and the archive
// format live in internal/setup, which Go's `internal/` rule keeps unimportable
// from outside this module — and reusing the sandbox image means there is no
// second artifact to build, publish or keep in lockstep.
//
// It is NOT the daemon: no HTTP server, no lifecycle, no tenant. It runs as node
// infrastructure precisely because a sandbox pod must never hold write access to
// a store shared across nodes.
func runGoldenUploader() {
	opts := setup.UploaderOpts{
		CacheRoot:  os.Getenv("DEPS_CACHE_ROOT"),
		RemoteRoot: os.Getenv("GOLDEN_CACHE_REMOTE"),
		Env:        os.Getenv("SANDBOX_ENV"),
		Log:        func(m string) { slog.Info(m) },
	}
	if opts.CacheRoot == "" || opts.RemoteRoot == "" {
		slog.Error("golden-uploader needs DEPS_CACHE_ROOT (node-local store) and " +
			"GOLDEN_CACHE_REMOTE (shared store, writable here)")
		os.Exit(2)
	}
	interval := 5 * time.Minute
	if v := os.Getenv("GOLDEN_UPLOAD_INTERVAL_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			interval = time.Duration(n) * time.Second
		}
	}
	slog.Info("golden-uploader start", "cache_root", opts.CacheRoot,
		"remote_root", opts.RemoteRoot, "interval", interval.String())

	stop := make(chan struct{})
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		// A sweep in flight keeps running: it writes to a final key and verifies
		// before reporting, so being cut short leaves no readable half-object.
		slog.Info("golden-uploader stopping")
		close(stop)
	}()
	setup.RunUploader(opts, interval, stop)
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, nil)))

	// One binary, two roles. Subcommand rather than a separate image so the
	// uploader cannot drift from the archive format the daemon reads.
	if len(os.Args) > 1 && os.Args[1] == "golden-uploader" {
		runGoldenUploader()
		return
	}

	bootId := os.Getenv("DAEMON_BOOT_ID")
	if bootId == "" {
		bootId = randomUUID()
		os.Setenv("DAEMON_BOOT_ID", bootId)
	}

	// Unconditional, first thing after the logger exists: each daemon ships in
	// its own image, so this line is what ties a pod's logs to the
	// implementation that produced them — the canary's panels split on it, and
	// CI asserts each image logs the impl it claims. The TS daemon emits the
	// same `impl=` key.
	slog.Info("daemon boot", "impl", "go", "boot_id", bootId)

	// Metrics are opt-in via OTEL_EXPORTER_OTLP_ENDPOINT and best-effort: a
	// collector that is unreachable, misconfigured or absent must never keep a
	// sandbox from booting, so a failure here is logged and execution continues
	// with the no-op provider. The SIGTERM path flushes too, but only after the
	// git-sync that saves the user's work and only within a bounded budget — see
	// daemon.shutdown().
	otelShutdown, err := telemetry.Init(context.Background(), bootId, "go")
	if err != nil {
		slog.Warn("otlp metrics disabled: exporter init failed", "err", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = otelShutdown(ctx)
	}()

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
		otelShutdown:  otelShutdown,
	}

	d.broadcaster = events.NewBroadcaster(routes.ReplayBytesCapacity)
	d.sniffer = proc.NewPortSniffer()
	d.broadcaster.ChunkObserver = func(source, data string) {
		d.sniffer.Observe(source, data)
	}

	d.store = config.NewStore()
	d.decofileDeps = routes.DecofileDeps{RepoDir: repoDir, Store: d.store}
	d.installState = setup.NewInstallState()
	d.lifecycle = lifecycle.New(d.broadcaster)
	d.lifecycle.OnStartPhase = func(status string, durationMs int64) {
		telemetry.RecordPhase(context.Background(), "start", status, durationMs)
	}
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
		// Every path to a serving sandbox ends here, so one hook covers cold
		// boot, golden restore and resume alike. Once per process: a dev server
		// that crashes and comes back re-enters `running`, and counting that as
		// a second cold start would flatter every average it appears in.
		if next.Phase == events.PhaseRunning {
			d.readyOnce.Do(func() {
				telemetry.RecordReady(context.Background(), time.Since(processStartedAt).Milliseconds())
			})
		}
		// Working tree just landed (see events.IsWorkingTreeReadyPhase). Announce
		// the initial draft version here too, not only from emitFileChanged: a
		// clone doesn't write through the daemon's fs routes, so on a fresh
		// sandbox no `.deco/blocks` write is ever observed to trigger it.
		if events.IsWorkingTreeReadyPhase(next.Phase) && !events.IsWorkingTreeReadyPhase(prev.Phase) {
			go d.announceDecofileVersion()
		}
	}

	d.phases = proc.NewPhaseManager()
	// One hook covers every phase: clone, install and dev-server start all go
	// through Begin/Done, so per-phase boot cost needs no per-call-site
	// instrumentation and a phase added later is measured for free.
	d.phases.OnFinish = func(name, status string, durationMs int64) {
		telemetry.RecordPhase(context.Background(), name, status, durationMs)
	}
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
	// The golden cache's remote tier needs `zstd` in the image; without it every
	// restore and publish fails into a normal install, silently apart from this.
	if setup.RemoteEnabled() {
		if _, err := exec.LookPath("zstd"); err != nil {
			slog.Warn("GOLDEN_CACHE_REMOTE is set but zstd is not on PATH — " +
				"the shared golden tier will miss on every boot")
		}
	}

	catalogSync := toolscatalog.NewCoalescer(
		toolscatalog.Opts{AppRoot: appRoot, RepoDir: repoDir},
		toolscatalog.DefaultSyncMinInterval,
	)

	d.dispatchReg = dispatch.NewRegistry()
	d.dispatchDeps = dispatch.Deps{
		DaemonToken:      d.getToken,
		AppRoot:          appRoot,
		AllowedHosts:     offloadHosts,
		AllowSameHostDev: os.Getenv("OFFLOAD_ALLOW_SAME_HOST_DEV") == "1",
		HarnessRunnerCmd: dispatch.ParseRunnerCmd(os.Getenv("HARNESS_RUNNER_CMD")),
		// The tenant env Studio pushed on the config channel — the harness's model
		// credential lives there, and it reaches the harness as its spawn
		// environment, so it dies with the run.
		// Plus GH_TOKEN, so the harness can open the pull request its prompt asks
		// for: `git push` already works off the credentialed `origin`, but `gh`
		// reads a token from the environment and there is none in the pod.
		//
		// Read back from the clone URL rather than pushed separately, so it cannot
		// drift from what the working tree pushes with, and it grants the harness
		// nothing it could not already read out of `.git/config`.
		RunEnv: func() map[string]string {
			cfg := d.store.Read()
			if cfg == nil {
				return nil
			}
			env := make(map[string]string, len(cfg.Env)+1)
			if token := config.TokenFromCloneUrl(cfg.CloneUrl()); token != "" {
				env["GH_TOKEN"] = token
			}
			// Tenant env last: an explicit GH_TOKEN from Studio wins.
			for k, v := range cfg.Env {
				env[k] = v
			}
			return env
		},
		// Point `org/output` at this run's thread subtree, and refresh `.deco/tools/`
		// from its MCP endpoint, before the harness can touch either. Degrades to no
		// link; never blocks the run.
		BeforeRun: func(info dispatch.RunInfo) {
			d.orgFsLinks.RepointForRun(info.ThreadId)
			catalogSync.Sync(toolscatalog.Endpoint{
				URL:       info.McpURL,
				Headers:   info.McpHeaders,
				ExpiresAt: info.McpExpiresAt,
			})
		},
		// A skill the model authored into the checkout would die with the branch;
		// move it onto the org mount before anyone goes looking for it.
		AfterRun: func(dispatch.RunInfo) {
			d.orgFsLinks.AdoptStrayRepoSkills()
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

	d.health = routes.Health(routes.HealthDeps{
		DaemonBootId:    bootId,
		GetReady:        isReady,
		GetOrchestrator: getOrch,
		GetConfigured:   func() bool { return d.store.Read() != nil },
	})

	h := sandboxHandlers{
		scripts: routes.Scripts(func() []string {
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
		events: routes.EventsStream(routes.EventsDeps{
			Broadcaster:              d.broadcaster,
			GetLifecycle:             d.lifecycle.Current,
			GetDiscoveredScripts:     d.orchestrator.DiscoveredScripts,
			GetActiveTasks:           d.getActiveTasks,
			GetStatus:                d.getStatus,
			GetBranchMeta:            d.branchStatus.GetLast,
			GetDecofileVersion:       d.getDecofileVersion,
			OnDecofileVersionUnknown: func() { go d.announceDecofileVersion() },
		}),
		decofile: routes.Decofile(d.decofileDeps),
		configRead: routes.ConfigRead(routes.ConfigDeps{
			DaemonBootId:    bootId,
			Store:           d.store,
			GetOrchestrator: getOrch,
			GetReady:        isReady,
			GetTasks:        func() []proc.Phase { return d.phases.Recent(20) },
			RepoDir:         repoDir,
		}),
		configUpdate: routes.ConfigUpdate(routes.ConfigDeps{
			DaemonBootId:   bootId,
			Store:          d.store,
			SetDaemonToken: d.setToken,
		}),
		orgfsConfig: routes.OrgFsConfig(routes.OrgFsDeps{
			ConfigPath: os.Getenv("ORGFS_SIDECAR_CONFIG_PATH"),
		}),
		fs: map[string]http.HandlerFunc{
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
		},
		git: map[string]http.HandlerFunc{
			"status":  routes.GitStatus(gitDeps),
			"diff":    routes.GitDiff(gitDeps),
			"publish": routes.GitPublish(gitDeps),
			"discard": routes.GitDiscard(gitDeps),
			"rebase":  routes.GitRebase(gitDeps),
		},
		setup: map[string]http.HandlerFunc{
			"clone":   routes.Setup("clone", func(string) { d.orchestrator.ResumeFrom(setup.StepClone) }),
			"install": routes.Setup("install", func(string) { d.orchestrator.ResumeFrom(setup.StepInstall) }),
			"start":   routes.Setup("start", func(string) { d.orchestrator.ResumeFrom(setup.StepStart) }),
		},
		tasksList:    routes.TasksList(tasksDeps),
		tasksGet:     routes.TasksGet(tasksDeps),
		tasksKill:    routes.TasksKill(tasksDeps),
		tasksKillAll: routes.TasksKillAll(tasksDeps),
		tasksDelete:  routes.TasksDelete(tasksDeps),
		tasksStream:  routes.TasksStream(tasksDeps),
		exec: routes.Exec(routes.ExecDeps{
			RepoDir:     repoDir,
			Store:       d.store,
			TaskManager: d.tasks,
			Lifecycle:   d.lifecycle,
			GetStatus:   d.getStatus,
			SetStatus:   d.setStatus,
		}),
		toolsSync: routes.ToolsSync(routes.ToolsDeps{AppRoot: appRoot, RepoDir: repoDir}),
	}

	d.mux = http.NewServeMux()
	for _, pre := range sandboxPrefixes {
		d.registerSandboxRoutes(d.mux, pre, h)
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
