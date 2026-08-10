package setup

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
	"github.com/decocms/studio/sandbox-daemon/internal/events"
	"github.com/decocms/studio/sandbox-daemon/internal/gitx"
	"github.com/decocms/studio/sandbox-daemon/internal/lifecycle"
	"github.com/decocms/studio/sandbox-daemon/internal/paths"
	"github.com/decocms/studio/sandbox-daemon/internal/proc"
	"github.com/decocms/studio/sandbox-daemon/internal/telemetry"
)

type Step string

const (
	StepClone   Step = "clone"
	StepInstall Step = "install"
	StepStart   Step = "start"
)

var stepRank = map[Step]int{StepClone: 3, StepInstall: 2, StepStart: 1}

const installLogMaxBytes = 10 * 1024 * 1024

type orchestratorBroadcaster interface {
	BroadcastChunk(source, data string, opts ...events.ChunkOpts)
	Emit(name string, payload any)
}

type OrchestratorDeps struct {
	AppRoot      string
	RepoDir      string
	LogsDir      string
	Store        *config.Store
	TaskManager  *proc.TaskManager
	SetStatus    func(next events.DaemonStatus)
	GetStatus    func() events.DaemonStatus
	Broadcaster  orchestratorBroadcaster
	InstallState *InstallState
	Lifecycle    *lifecycle.Manager
	BranchStatus *gitx.BranchStatusMonitor
}

type Orchestrator struct {
	deps OrchestratorDeps

	mu                sync.Mutex
	queue             []Step
	running           bool
	currentBranchHead string
	latestScripts     []string
	hasScripts        bool
	// A fresh install not yet published as a golden — published by
	// PublishPendingGolden() once the dev server is confirmed healthy. Nil when
	// the boot restored an existing golden (nothing new to publish).
	pendingGolden *GoldenParams
	// The `running` state a checkout interrupted, restored by stepStartInner
	// when the dev server turns out never to have stopped. Zero otherwise.
	interruptedRunning events.LifecycleState
}

func NewOrchestrator(deps OrchestratorDeps) *Orchestrator {
	o := &Orchestrator{deps: deps}
	deps.TaskManager.OnTaskExit(func(s proc.TaskSummary) {
		if s.LogName == "" || !proc.IsWellKnownStarter(s.LogName) {
			return
		}
		// Counted before the intentional gate below: a restart the daemon asked
		// for and a user app crashlooping are the same event from outside the
		// pod, and telling them apart is the whole point of the attribute.
		telemetry.RecordDevServerExit(context.Background(), s.Intentional)
		if s.Intentional {
			return
		}
		if s.ExitCode == nil || *s.ExitCode == 0 {
			return
		}
		reason := fmt.Sprintf("dev script exited with code %d", *s.ExitCode)
		o.chunk("\r\n[orchestrator] " + reason + "\r\n")
		o.deps.SetStatus(events.DaemonStatus{State: "error", Reason: reason})
		if o.deps.Lifecycle.Current().Phase != events.PhaseStartFailed {
			o.deps.Lifecycle.Transition(events.LifecycleState{Phase: events.PhaseStartFailed, Error: reason})
		}
	})
	return o
}

func (o *Orchestrator) ResumeFrom(step Step) {
	if o.deps.GetStatus().State == "error" {
		o.deps.SetStatus(events.DaemonStatus{State: "running"})
	}
	o.enqueue(step)
}

func (o *Orchestrator) Handle(t config.Transition) {
	if t.Kind == config.KindGitCredentialRefresh {
		o.syncGitRemoteCredentials(t.CloneUrl)
		return
	}
	step, ok := transitionToStep(t)
	if !ok {
		return
	}
	o.enqueue(step)
}

func (o *Orchestrator) IsRunning() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.running
}

func (o *Orchestrator) PendingCount() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.queue)
}

func (o *Orchestrator) DiscoveredScripts() ([]string, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.latestScripts, o.hasScripts
}

// PublishPendingGolden publishes this boot's fresh install as the golden, called
// only once the probe confirms the dev server healthy — a broken-but-exit-0
// install must never become a sticky golden. No-op when nothing is pending.
func (o *Orchestrator) PublishPendingGolden() {
	o.mu.Lock()
	pending := o.pendingGolden
	o.pendingGolden = nil
	o.mu.Unlock()
	if pending == nil {
		return
	}
	// Untee'd, matching the TS daemon: publish runs after the dev server is up,
	// and its log belongs in the setup stream, not in the pod's stdout.
	pending.Log = func(m string) { o.rawChunk(m + "\r\n") }
	PublishGolden(*pending)
	PruneGoldens("")
	// L2 last: it is the slow one (compress + read-back over the network), and a
	// no-op both when the key already exists — the common case after an L2
	// restore — and when GOLDEN_CACHE_REMOTE is unset. The store is read-only in
	// a tenant pod, so today this only ever logs a failure to write; that changes
	// when a trusted publisher gets the writable mount.
	PublishRemoteGolden(RemoteGoldenFrom(*pending))
}

func (o *Orchestrator) enqueue(step Step) {
	o.mu.Lock()
	rank := stepRank[step]
	for _, q := range o.queue {
		if stepRank[q] >= rank {
			o.mu.Unlock()
			return
		}
	}
	// Nothing queued outranks this step (the loop above returned if it did), and
	// a higher-rank step subsumes every lower one — runStep(clone) runs
	// clone→install→start. So the queue never holds more than one step.
	o.queue = append(o.queue[:0], step)
	shouldDrain := !o.running
	if shouldDrain {
		o.running = true
	}
	o.mu.Unlock()
	if shouldDrain {
		go o.drain()
	}
}

func (o *Orchestrator) drain() {
	for {
		o.mu.Lock()
		if len(o.queue) == 0 {
			o.running = false
			o.mu.Unlock()
			return
		}
		step := o.queue[0]
		o.queue = o.queue[1:]
		o.mu.Unlock()

		o.chunk(fmt.Sprintf("[orchestrator] running step: %s\r\n", step))
		func() {
			defer func() {
				if r := recover(); r != nil {
					o.chunk(fmt.Sprintf("\r\n[orchestrator] step %s crashed: %v\r\n", step, r))
				}
			}()
			o.runStep(step)
		}()
	}
}

// A running dev server is stopped by whoever actually invalidates it — the
// install (which rewrites node_modules under it) and a start whose command
// differs — never up front, on the assumption that a step implies a restart.
// The assumption is what breaks a tenant warm pool: a claim onto a pod that is
// already serving arrives as branch-change, and the thread branch points at the
// same commit the pool warmed, so the checkout leaves the tree byte-identical.
// Killing dev there rebuilds a framework that was already answering requests
// (~2min for a faststore/Next app) — the whole value of the warm pod, spent on
// a no-op. Same commit + same fingerprint now keeps the process: install
// short-circuits on the fingerprint, and stepStart sees its own command already
// running and skips.
func (o *Orchestrator) runStep(step Step) {
	switch step {
	case StepClone:
		if !o.stepClone() {
			return
		}
		if !o.stepInstall() {
			return
		}
		o.stepStart()
	case StepInstall:
		if !o.stepInstall() {
			return
		}
		o.stepStart()
	case StepStart:
		o.stepStart()
	}
}

func (o *Orchestrator) chunk(data string) {
	o.deps.Broadcaster.BroadcastChunk("setup", data)
}

func (o *Orchestrator) rawChunk(data string) {
	o.deps.Broadcaster.BroadcastChunk("setup", data, events.ChunkOpts{Tee: false})
}

func (o *Orchestrator) stepClone() bool {
	return timedPhase("clone", o.stepCloneInner)
}

func (o *Orchestrator) stepInstall() bool {
	return timedPhase("install", o.stepInstallInner)
}

// startOutcome is what a start attempt actually did. "skipped" is not a boot
// phase — nothing was spawned — so it is deliberately not reported.
type startOutcome string

const (
	startDone    startOutcome = "done"
	startFailed  startOutcome = "failed"
	startSkipped startOutcome = "skipped"
)

// start cannot use timedPhase, for two reasons.
//
// It has three outcomes rather than two: a skipped start spawned nothing, so
// there is no phase to report.
//
// And it does not finish when this function returns. TaskManager.Spawn returns
// once the process exists, not once it serves — timing that would measure fork
// latency and would record every immediately-crashing dev script as a healthy
// start. So the attempt is left open and closed by the lifecycle, which is
// where both terminal states arrive: running (the probe reached the server) or
// start-failed (no start command, or the script exited non-zero).
func (o *Orchestrator) stepStart() {
	o.deps.Lifecycle.NoteStartAttempt()
	// startFailed already transitioned to start-failed, which closed the attempt.
	if o.stepStartInner() == startSkipped {
		o.deps.Lifecycle.CancelStartAttempt()
	}
}

// timedPhase times one setup step and reports it under the same instrument the
// TaskManager phases use. Wrapping the three step methods here rather than
// threading a timer through their many exit points is what makes `clone` and
// `install` measurable at all — neither goes through the PhaseManager, so until
// now sandbox.daemon.phase.duration covered only the dev-server spawn and user
// commands, despite claiming otherwise.
//
// A step signals failure by returning false, which aborts the pipeline.
func timedPhase(name string, run func() bool) bool {
	startedAt := time.Now()
	ok := run()
	status := "done"
	if !ok {
		status = "failed"
	}
	telemetry.RecordPhase(context.Background(), name, status, time.Since(startedAt).Milliseconds())
	return ok
}

func (o *Orchestrator) stepCloneInner() bool {
	cfg := o.deps.Store.Read()
	if cfg == nil {
		return false
	}
	cloneUrl := cfg.CloneUrl()

	if cloneUrl != "" && paths.HasGitRepo(o.deps.RepoDir) {
		o.syncGitRemoteCredentials(cloneUrl)
	}

	if cloneUrl != "" && !paths.HasGitRepo(o.deps.RepoDir) {
		o.deps.Lifecycle.Transition(events.LifecycleState{Phase: events.PhaseCloning})
		cloneLogPath := paths.AppLogPath(o.deps.LogsDir, "clone")
		os.Remove(cloneLogPath)
		cloneTee := proc.NewLogTee(cloneLogPath, installLogMaxBytes)
		result := SpawnClone(CloneDeps{
			RepoDir:  o.deps.RepoDir,
			CloneUrl: cloneUrl,
			Branch:   cfg.Branch(),
			OnChunk: func(data string) {
				o.rawChunk(data)
				cloneTee.Write(data)
			},
		})
		cloneTee.Close()
		if result.Code != 0 {
			errMsg := fmt.Sprintf("exit %d", result.Code)
			o.chunk(fmt.Sprintf("\r\n[orchestrator] clone failed (%s)\r\n", errMsg))
			o.deps.Lifecycle.Transition(events.LifecycleState{Phase: events.PhaseCloneFailed, Error: errMsg})
			return false
		}
		if result.FetchBase != nil {
			go func() {
				defer func() { recover() }()
				result.FetchBase(func(data string) { o.rawChunk(data) })
				o.deps.BranchStatus.Refresh()
			}()
		}
	} else if cloneUrl != "" {
		branch := cfg.Branch()
		if branch != "" && !config.IsSyntheticBranch(branch) {
			o.noteInterruptedRunning()
			o.deps.Lifecycle.Transition(events.LifecycleState{Phase: events.PhaseCheckingOut, To: branch})
			if err := o.checkoutBranch(branch); err != nil {
				o.chunk(fmt.Sprintf("\r\n[orchestrator] checkout failed: %s\r\n", err.Error()))
				o.deps.Lifecycle.Transition(events.LifecycleState{Phase: events.PhaseCloneFailed, Error: err.Error()})
				return false
			}
		} else {
			o.chunk("[orchestrator] repo already cloned\r\n")
		}
	}

	o.gitSetup(cfg)
	o.fillApplicationDefaults()
	// Before install, so install runs against the up-to-date lockfile.
	o.maybeFastForwardToBase()
	// Re-read HEAD: the fast-forward may have moved it past what gitSetup's
	// checkout captured, and installState fingerprints against this field.
	o.refreshBranchHead()
	o.deps.BranchStatus.Refresh()
	return true
}

// maybeFastForwardToBase advances an idle, unchanged sandbox to its base
// branch. No-op unless the branch is clean-of-commits and behind base.
func (o *Orchestrator) maybeFastForwardToBase() {
	result := gitx.FastForwardToBase(o.deps.RepoDir)
	if !result.FastForwarded {
		return
	}
	pushed := ""
	if result.Pushed {
		pushed = ", pushed"
	}
	o.chunk(fmt.Sprintf(
		"[orchestrator] fast-forwarded %s to origin/%s (+%d commits%s)\r\n",
		result.Branch, result.Base, result.BehindBase, pushed,
	))
}

func (o *Orchestrator) stepInstallInner() bool {
	cfg := o.deps.Store.Read()
	if cfg == nil {
		return false
	}
	// Clone-only: the consumer wants the checkout, nothing else. Skipped here
	// rather than by omitting `application`, because fillApplicationDefaults
	// autodetects a package manager from the lockfile and would put the install
	// back — silently, and in parallel with whatever is using the checkout.
	if cfg.IsCloneOnly() {
		o.chunk("[orchestrator] clone-only: skipping dependency install\r\n")
		return true
	}
	if o.deps.InstallState.IsInstalledFor(cfg, o.branchHead()) {
		o.broadcastDiscoveredScripts(cfg)
		return true
	}
	pm := cfg.PmName()
	if pm == "" {
		return true
	}

	// An install rewrites node_modules under whatever is reading it, so the dev
	// server goes down here — after every early return above, so a claim that
	// installs nothing keeps its warm process (see runStep).
	o.stopDevTask()
	o.deps.Lifecycle.Transition(events.LifecycleState{Phase: events.PhaseInstalling})

	// Timed from here so the reported cost is the whole dependency step: a failed
	// golden probe is real boot latency too.
	depsStartedAt := time.Now()
	cloneUrl := resolveCloneUrl(cfg, o.deps.RepoDir)
	bootId := os.Getenv("DAEMON_BOOT_ID")
	elapsedMs := func() int64 { return time.Since(depsStartedAt).Milliseconds() }

	// Golden fast path: reflink a cached node_modules for this exact lockfile and
	// skip install entirely. Best-effort — a miss or any failure falls through.
	golden := GoldenParams{
		CloneUrl:    cloneUrl,
		InstallRoot: paths.ResolvePmRoot(o.deps.RepoDir, cfg.PmPath()),
		Pm:          pm,
		Log:         func(m string) { o.chunk(m + "\r\n") },
	}
	if TryRestoreGolden(golden) {
		o.mu.Lock()
		o.pendingGolden = nil // restored an existing golden — nothing to publish
		o.mu.Unlock()
		EmitDepsRestore(RestoreL1, cloneUrl, elapsedMs(), bootId)
		o.markInstallSucceeded(cfg)
		return true
	}

	// L2: the same lockfile may already be archived on the shared store even
	// though this node has never built it. Extracting it beats installing, and it
	// is the only tier that helps a pod that landed in a cold zone.
	//
	// A hit leaves pendingGolden set, so the healthy-boot transition seeds THIS
	// node's L1 from the extracted tree — the next pod here gets the reflink
	// instead of another extract. PublishRemoteGolden no-ops on an existing key,
	// so it is safe that the same transition also runs the L2 publish.
	if TryRestoreRemoteGolden(RemoteGoldenFrom(golden)) {
		o.mu.Lock()
		o.pendingGolden = &golden
		o.mu.Unlock()
		EmitDepsRestore(RestoreL2, cloneUrl, elapsedMs(), bootId)
		o.markInstallSucceeded(cfg)
		return true
	}

	o.chunk("[orchestrator] installing dependencies\r\n")

	installLogPath := paths.AppLogPath(o.deps.LogsDir, "install")
	os.Remove(installLogPath)
	installTee := proc.NewLogTee(installLogPath, installLogMaxBytes)

	code, ran := SpawnInstall(cfg, o.deps.RepoDir, cfg.Env, func(data string) {
		o.rawChunk(data)
		installTee.Write(data)
	})
	installTee.Close()
	if !ran {
		// Reported, not silent: this is the path every Deno project takes, and
		// without a line here "no data" and "the cache is irrelevant for this
		// runtime" look identical in the log store.
		EmitDepsRestore(RestoreNoInstall, cloneUrl, elapsedMs(), bootId)
		o.markInstallSucceeded(cfg)
		return true
	}
	if code != 0 {
		errMsg := fmt.Sprintf("exit %d", code)
		o.chunk(fmt.Sprintf("\r\n[orchestrator] install failed (%s)\r\n", errMsg))
		o.deps.InstallState.Mark(Fingerprint(cfg, o.branchHead()), false)
		o.deps.Lifecycle.Transition(events.LifecycleState{Phase: events.PhaseInstallFailed, Error: errMsg})
		return false
	}
	EmitDepsRestore(RestoreMiss, cloneUrl, elapsedMs(), bootId)
	o.markInstallSucceeded(cfg)

	// Not published yet: PublishPendingGolden runs off the probe's `running`
	// transition, so only a boot that actually came up publishes.
	o.mu.Lock()
	o.pendingGolden = &golden
	o.mu.Unlock()

	// Install scripts (postinstall/prepare — lefthook, husky) can overwrite
	// .git/hooks/pre-push; reinstall so branch protection survives.
	if o.deps.RepoDir != "" {
		if err := gitx.InstallProtectedBranchHook(o.deps.RepoDir); err != nil {
			o.chunk(fmt.Sprintf("\r\n[orchestrator] warning: could not reinstall protected-branch hook: %s\r\n", err.Error()))
		}
	}

	go EmitInstalledDeps(DepMetricsInput{
		InstallRoot:    paths.ResolvePmRoot(o.deps.RepoDir, cfg.PmPath()),
		PackageManager: pm,
		BootId:         bootId,
		RepoName:       cfg.RepoName(),
		Branch:         cfg.Branch(),
	})
	return true
}

func (o *Orchestrator) stepStartInner() startOutcome {
	cfg := o.deps.Store.Read()
	if cfg == nil {
		return startSkipped
	}
	// No install happened, so there is nothing to start — and the fingerprint
	// check below would report it as a mismatch, which reads like a failure.
	if cfg.IsCloneOnly() {
		return startSkipped
	}
	if status := o.deps.GetStatus(); status.State != "running" {
		o.chunk(fmt.Sprintf("\r\n[orchestrator] skipping start: status=%s (resume to retry)\r\n", status.State))
		return startSkipped
	}
	if !o.deps.InstallState.IsInstalledFor(cfg, o.branchHead()) {
		o.chunk("\r\n[orchestrator] skipping start: install fingerprint mismatch\r\n")
		return startSkipped
	}
	command, ok := o.buildStartCommand(cfg)
	if !ok {
		reason := o.diagnoseNoStartCommand(cfg)
		o.chunk(reason)
		flat := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(reason, "\r", " "), "\n", " "))
		o.deps.Lifecycle.Transition(events.LifecycleState{Phase: events.PhaseStartFailed, Error: flat})
		return startFailed
	}

	if runningCmd, runningCwd, found := o.deps.TaskManager.RunningCommandByLogName(command.Source); found &&
		runningCmd == command.Cmd && runningCwd == command.Cwd {
		o.chunk(fmt.Sprintf("[orchestrator] dev already running (%s) — skipping restart\r\n", command.Source))
		cur := o.deps.Lifecycle.Current().Phase
		if cur != events.PhaseRunning && cur != events.PhaseStarting {
			o.deps.Lifecycle.Transition(o.resumeAfterCheckout(cfg))
		}
		return startSkipped
	}
	o.stopDevTask()
	o.deps.Lifecycle.Transition(events.LifecycleState{Phase: events.PhaseStarting})
	overrides := map[string]string{}
	for k, v := range DenoCacheEnv(cfg, o.deps.RepoDir) {
		overrides[k] = v
	}
	for k, v := range cfg.Env {
		overrides[k] = v
	}
	o.deps.TaskManager.Spawn(proc.TaskSpec{
		Command:          command.Cmd,
		Cwd:              command.Cwd,
		Env:              BuildDevEnv(cfg, overrides),
		Label:            command.Label,
		Mode:             "pty",
		LogName:          command.Source,
		ReplaceByLogName: true,
	})
	return startDone
}

type startCommand struct {
	Cmd    string
	Cwd    string
	Label  string
	Source string
}

func (o *Orchestrator) buildStartCommand(cfg *config.Enriched) (startCommand, bool) {
	pm := cfg.PmName()
	if pm == "" {
		return startCommand{}, false
	}
	pmConf, ok := PackageManagers[pm]
	if !ok {
		return startCommand{}, false
	}
	cwd := paths.ResolvePmRoot(o.deps.RepoDir, cfg.PmPath())
	scripts := proc.DiscoverScripts(cwd, pm)
	starter := ""
	for _, s := range proc.WellKnownStarters {
		for _, have := range scripts {
			if s == have {
				starter = s
				break
			}
		}
		if starter != "" {
			break
		}
	}
	if starter == "" {
		return startCommand{}, false
	}
	rc := PmRunCommand(cfg.RuntimePathPrefix, cwd, pmConf.RunPrefix, starter)
	return startCommand{Cmd: rc.Cmd, Cwd: cwd, Label: rc.Label, Source: starter}, true
}

func (o *Orchestrator) diagnoseNoStartCommand(cfg *config.Enriched) string {
	pm := cfg.PmName()
	if pm == "" {
		return "\r\n[orchestrator] skipping start: no package manager configured — update the VM config to enable a dev server\r\n"
	}
	pmConf := PackageManagers[pm]
	cwd := paths.ResolvePmRoot(o.deps.RepoDir, cfg.PmPath())
	scripts := proc.DiscoverScripts(cwd, pm)
	if len(scripts) == 0 {
		hasManifest := false
		for _, m := range pmConf.Manifests {
			if _, err := os.Stat(filepath.Join(cwd, m)); err == nil {
				hasManifest = true
				break
			}
		}
		if !hasManifest {
			return fmt.Sprintf("\r\n[orchestrator] skipping start: no package manifest (%s) found at %s — update the VM config if a dev server should run\r\n", joinOr(pmConf.Manifests), cwd)
		}
		return fmt.Sprintf("\r\n[orchestrator] skipping start: no scripts defined in %s/package.json — update the VM config if a dev server should run\r\n", cwd)
	}
	return fmt.Sprintf("\r\n[orchestrator] skipping start: no 'dev' or 'start' script found (available: %s) — update the VM config to set the correct start script\r\n", strings.Join(scripts, ", "))
}

// noteInterruptedRunning remembers a serving state about to be interrupted by a
// checkout, so resumeAfterCheckout can put it back.
func (o *Orchestrator) noteInterruptedRunning() {
	prev := o.deps.Lifecycle.Current()
	if prev.Phase != events.PhaseRunning {
		return
	}
	o.mu.Lock()
	o.interruptedRunning = prev
	o.mu.Unlock()
}

// resumeAfterCheckout is the state to report once a checkout finishes without
// restarting the dev server. `starting` would be a lie: the process behind that
// port never stopped, and it costs a user the whole probe re-confirmation —
// 13–26s measured on a warm tenant-pool pod, during which Studio holds the
// booting overlay over a preview that is already answering requests. Falls back
// to `starting` when there is nothing to resume or the port moved under it (the
// saved port would then name something that is no longer there).
func (o *Orchestrator) resumeAfterCheckout(cfg *config.Enriched) events.LifecycleState {
	o.mu.Lock()
	prev := o.interruptedRunning
	o.interruptedRunning = events.LifecycleState{}
	o.mu.Unlock()

	starting := events.LifecycleState{Phase: events.PhaseStarting}
	if prev.Phase != events.PhaseRunning || prev.Port == 0 {
		return starting
	}
	if port, ok := cfg.Port(); ok && port != prev.Port {
		return starting
	}
	return prev
}

func (o *Orchestrator) stopDevTask() {
	for _, starter := range proc.WellKnownStarters {
		o.deps.TaskManager.KillByLogName(starter, true, 15) // SIGTERM
	}
	o.deps.TaskManager.WaitForLogNamesIdle(proc.WellKnownStarters)
}

func (o *Orchestrator) gitSetup(cfg *config.Enriched) {
	if cfg.Git != nil && cfg.Git.Identity != nil &&
		cfg.Git.Identity.UserName != nil && cfg.Git.Identity.UserEmail != nil {
		if err := gitx.ConfigureGitIdentity(o.deps.RepoDir, *cfg.Git.Identity.UserName, *cfg.Git.Identity.UserEmail); err != nil {
			o.chunk(fmt.Sprintf("\r\n[orchestrator] warning: git identity setup failed: %s\r\n", err.Error()))
		}
	}
	if err := gitx.InstallProtectedBranchHook(o.deps.RepoDir); err != nil {
		o.chunk(fmt.Sprintf("\r\n[orchestrator] warning: could not install protected-branch hook: %s\r\n", err.Error()))
	}
	branch := cfg.Branch()
	if branch != "" && !config.IsSyntheticBranch(branch) {
		o.chunk(fmt.Sprintf("[orchestrator] checking out branch: %s\r\n", branch))
		if err := o.checkoutBranch(branch); err != nil {
			o.chunk(fmt.Sprintf("\r\n[orchestrator] warning: branch checkout failed: %s\r\n", err.Error()))
		}
	}
	o.refreshBranchHead()
}

func (o *Orchestrator) checkoutBranch(branch string) error {
	repoDir := o.deps.RepoDir
	return gitx.CheckoutBranch(gitx.CheckoutBranchParams{
		RepoDir: repoDir,
		Branch:  branch,
		RunStep: func(argv []string) int {
			o.rawChunk("$ " + formatArgv(argv) + "\r\n")
			return SpawnStepArgv(argv, func(data string) { o.rawChunk(data) }, gitStepEnv)
		},
		Log: func(message string) { o.chunk(message) },
	})
}

func (o *Orchestrator) fillApplicationDefaults() {
	diskCfg, _ := config.ReadDiskConfig(o.deps.RepoDir)

	o.deps.Store.ApplyInternal(func(current *config.TenantConfig) *config.Patch {
		var cur *config.Application
		if current != nil {
			cur = current.Application
		}
		var diskApp *config.Application
		if diskCfg != nil {
			diskApp = diskCfg.Application
		}

		detected := Autodetect(o.deps.RepoDir)

		patchApp := &config.Application{}
		changed := false

		curPmName := ""
		if cur != nil && cur.PackageManager != nil && cur.PackageManager.Name != nil {
			curPmName = *cur.PackageManager.Name
		}
		if curPmName == "" {
			if diskApp != nil && diskApp.PackageManager != nil && diskApp.PackageManager.Name != nil {
				patchApp.PackageManager = diskApp.PackageManager
			} else {
				patchApp.PackageManager = &config.PackageManagerConfig{Name: config.Str(detected.PackageManager)}
			}
			changed = true
		}
		curRuntime := ""
		if cur != nil && cur.Runtime != nil {
			curRuntime = *cur.Runtime
		}
		if curRuntime == "" {
			if diskApp != nil && diskApp.Runtime != nil {
				patchApp.Runtime = diskApp.Runtime
			} else {
				patchApp.Runtime = config.Str(detected.Runtime)
			}
			changed = true
		}
		if (cur == nil || cur.Port == nil) && diskApp != nil && diskApp.Port != nil {
			patchApp.Port = diskApp.Port
			changed = true
		}
		if !changed {
			return nil
		}
		return &config.Patch{Application: patchApp}
	})
}

func (o *Orchestrator) markInstallSucceeded(cfg *config.Enriched) {
	o.deps.InstallState.Mark(Fingerprint(cfg, o.branchHead()), true)
	o.broadcastDiscoveredScripts(cfg)
}

func (o *Orchestrator) broadcastDiscoveredScripts(cfg *config.Enriched) {
	cwd := paths.ResolvePmRoot(o.deps.RepoDir, cfg.PmPath())
	scripts := proc.DiscoverScripts(cwd, cfg.PmName())
	o.mu.Lock()
	o.latestScripts = scripts
	o.hasScripts = true
	o.mu.Unlock()
	o.deps.Broadcaster.Emit("scripts", map[string]any{"scripts": scripts})
}

func (o *Orchestrator) refreshBranchHead() {
	head := ""
	if paths.HasGitRepo(o.deps.RepoDir) {
		if out, ok := gitx.Try([]string{"rev-parse", "HEAD"}, gitx.RunOpts{Cwd: o.deps.RepoDir}); ok {
			head = out
		}
	}
	o.mu.Lock()
	o.currentBranchHead = head
	o.mu.Unlock()
}

func (o *Orchestrator) branchHead() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.currentBranchHead
}

func (o *Orchestrator) syncGitRemoteCredentials(cloneUrl string) {
	if !paths.HasGitRepo(o.deps.RepoDir) {
		return
	}
	if err := gitx.SyncOriginRemote(o.deps.RepoDir, cloneUrl); err != nil {
		o.chunk(fmt.Sprintf("\r\n[orchestrator] failed to sync origin credentials: %s\r\n", err.Error()))
		return
	}
	o.chunk("[orchestrator] synced origin credentials\r\n")
}

func transitionToStep(t config.Transition) (Step, bool) {
	switch t.Kind {
	case config.KindBootstrap, config.KindBranchChange:
		return StepClone, true
	case config.KindRuntimeChange, config.KindPmChange:
		return StepInstall, true
	case config.KindPortChange, config.KindEnvChange:
		// env-change restarts dev: BuildDevEnv reads the merged store at start,
		// so without this the new env never reaches the dev server.
		return StepStart, true
	}
	return "", false
}
