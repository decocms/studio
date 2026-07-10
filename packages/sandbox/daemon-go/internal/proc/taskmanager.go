package proc

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

const (
	ringBufferBytes     = 256 * 1024
	logMaxBytes         = 10 * 1024 * 1024
	defaultReapInterval = 60 * time.Second
	defaultTTL          = 15 * time.Minute
	taskFilePrefix      = "task"
	killEscalationDelay = 3 * time.Second
	StatusRunning       = "running"
	StatusExited        = "exited"
	StatusFailed        = "failed"
	StatusKilled        = "killed"
	StatusTimeout       = "timeout"
)

var ValidStatuses = map[string]bool{
	StatusRunning: true, StatusExited: true, StatusFailed: true,
	StatusKilled: true, StatusTimeout: true,
}

type TaskSpec struct {
	Command          string
	Cwd              string
	Env              map[string]string
	Mode             string // "pipe" | "pty"
	TimeoutMs        int
	Label            string
	LogName          string
	ReplaceByLogName bool
}

type OutputChunk struct {
	Stream string `json:"stream"`
	Data   string `json:"data"`
}

type TaskSummary struct {
	ID          string `json:"id"`
	Command     string `json:"command"`
	Status      string `json:"status"`
	ExitCode    *int   `json:"exitCode"`
	StartedAt   int64  `json:"startedAt"`
	FinishedAt  *int64 `json:"finishedAt"`
	TimedOut    bool   `json:"timedOut"`
	Truncated   bool   `json:"truncated"`
	LogName     string `json:"logName,omitempty"`
	Intentional bool   `json:"intentional"`
}

type TaskResult struct {
	ExitCode int
	Status   string
	TimedOut bool
}

type taskInternal struct {
	id          string
	spec        TaskSpec
	status      string
	exitCode    *int
	startedAt   int64
	finishedAt  *int64
	timedOut    bool
	pid         int
	phaseID     string
	stdout      *RingBuffer
	stderr      *RingBuffer
	tee         *LogTee
	logPath     string
	subscribers map[int]func(OutputChunk)
	subCounter  int
	done        chan struct{}
	result      TaskResult
	intentional bool
	timer       *time.Timer
}

type ChunkBroadcaster interface {
	BroadcastChunk(source, data string, opts ...struct{ Tee bool })
}

type TaskManagerDeps struct {
	LogsDir      string
	TTL          time.Duration
	ReapInterval time.Duration
	OnChange     func()
	PhaseManager *PhaseManager
	// BroadcastChunk mirrors logName'd task output onto the global SSE log
	// stream (tee=false for chunks, tee=true for the header line).
	BroadcastChunk func(source, data string, tee bool)
}

type TaskManager struct {
	mu           sync.Mutex
	deps         TaskManagerDeps
	tasks        map[string]*taskInternal
	order        []string
	counter      int
	exitHandlers []func(TaskSummary)
	reapStop     chan struct{}
}

func NewTaskManager(deps TaskManagerDeps) *TaskManager {
	if deps.TTL == 0 {
		deps.TTL = defaultTTL
	}
	if deps.ReapInterval == 0 {
		deps.ReapInterval = defaultReapInterval
	}
	m := &TaskManager{
		deps:     deps,
		tasks:    map[string]*taskInternal{},
		reapStop: make(chan struct{}),
	}
	m.purgeStaleLogs()
	go m.reapLoop()
	return m
}

func (m *TaskManager) reapLoop() {
	t := time.NewTicker(m.deps.ReapInterval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			m.reap()
		case <-m.reapStop:
			return
		}
	}
}

func (m *TaskManager) purgeStaleLogs() {
	entries, err := os.ReadDir(m.deps.LogsDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), taskFilePrefix) {
			os.Remove(filepath.Join(m.deps.LogsDir, e.Name()))
		}
	}
}

func (m *TaskManager) Spawn(spec TaskSpec) TaskSummary {
	if spec.ReplaceByLogName && spec.LogName != "" {
		var waiters []chan struct{}
		m.mu.Lock()
		for _, t := range m.tasks {
			if t.status != StatusRunning || t.spec.LogName != spec.LogName {
				continue
			}
			t.intentional = true
			m.signalLocked(t, syscall.SIGTERM)
			m.escalate(t)
			waiters = append(waiters, t.done)
		}
		m.mu.Unlock()
		for _, w := range waiters {
			<-w
		}
	}

	m.mu.Lock()
	m.counter++
	id := fmt.Sprintf("%s%d", taskFilePrefix, m.counter)
	logPath := filepath.Join(m.deps.LogsDir, id)
	if spec.LogName != "" {
		logPath = filepath.Join(m.deps.LogsDir, "app", spec.LogName)
	}
	label := spec.Label
	if label == "" {
		label = "$ " + spec.Command
	}
	task := &taskInternal{
		id:          id,
		spec:        spec,
		status:      StatusRunning,
		startedAt:   time.Now().UnixMilli(),
		stdout:      NewRingBuffer(ringBufferBytes),
		stderr:      NewRingBuffer(ringBufferBytes),
		tee:         NewLogTee(logPath, logMaxBytes),
		logPath:     logPath,
		subscribers: map[int]func(OutputChunk){},
		done:        make(chan struct{}),
	}
	if m.deps.PhaseManager != nil {
		task.phaseID = m.deps.PhaseManager.Begin(label)
	}
	m.tasks[id] = task
	m.order = append(m.order, id)
	m.mu.Unlock()

	task.tee.WriteHeader(label)
	if spec.LogName != "" && m.deps.BroadcastChunk != nil {
		m.deps.BroadcastChunk(spec.LogName, label+"\r\n", true)
	}

	if spec.Mode == "pty" {
		m.startPty(task)
	} else {
		m.startPipe(task)
	}
	if m.deps.OnChange != nil {
		m.deps.OnChange()
	}
	return m.summarize(task)
}

func buildEnv(inherit bool, overrides map[string]string, extra map[string]string) []string {
	env := map[string]string{}
	if inherit {
		for _, kv := range os.Environ() {
			if i := strings.IndexByte(kv, '='); i >= 0 {
				env[kv[:i]] = kv[i+1:]
			}
		}
	}
	for k, v := range extra {
		env[k] = v
	}
	for k, v := range overrides {
		env[k] = v
	}
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

func (m *TaskManager) startPipe(task *taskInternal) {
	cmd := exec.Command("bash", "-c", task.spec.Command)
	cmd.Dir = task.spec.Cwd
	if task.spec.Env != nil {
		cmd.Env = buildEnv(false, task.spec.Env, nil)
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		m.spawnError(task, err)
		return
	}
	task.pid = cmd.Process.Pid
	m.armTimeout(task)

	var wg sync.WaitGroup
	read := func(r interface{ Read([]byte) (int, error) }, stream string, ring *RingBuffer) {
		defer wg.Done()
		buf := make([]byte, 8192)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				data := string(buf[:n])
				ring.Append(data)
				task.tee.Write(data)
				m.fanOut(task, OutputChunk{Stream: stream, Data: data})
			}
			if err != nil {
				return
			}
		}
	}
	wg.Add(2)
	go read(stdout, "stdout", task.stdout)
	go read(stderr, "stderr", task.stderr)

	go func() {
		wg.Wait()
		err := cmd.Wait()
		m.killGroup(task, syscall.SIGKILL)
		m.finalize(task, waitExitCode(err))
	}()
}

func (m *TaskManager) startPty(task *taskInternal) {
	cmd := exec.Command("sh", "-c", task.spec.Command)
	cmd.Dir = task.spec.Cwd
	cmd.Env = buildEnv(true, task.spec.Env, map[string]string{"TERM": "xterm-256color"})
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 30, Cols: 120})
	if err != nil {
		m.spawnError(task, err)
		return
	}
	task.pid = cmd.Process.Pid
	m.armTimeout(task)

	go func() {
		buf := make([]byte, 8192)
		for {
			n, rerr := f.Read(buf)
			if n > 0 {
				data := string(buf[:n])
				task.stdout.Append(data)
				task.tee.Write(data)
				m.fanOut(task, OutputChunk{Stream: "stdout", Data: data})
			}
			if rerr != nil {
				break
			}
		}
		werr := cmd.Wait()
		f.Close()
		m.finalize(task, waitExitCode(werr))
	}()
}

func waitExitCode(err error) int {
	if err == nil {
		return 0
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		ws, ok := exitErr.Sys().(syscall.WaitStatus)
		if ok {
			if ws.Signaled() {
				return 128 + int(ws.Signal())
			}
			return ws.ExitStatus()
		}
		return exitErr.ExitCode()
	}
	return 1
}

func (m *TaskManager) spawnError(task *taskInternal, err error) {
	msg := fmt.Sprintf("spawn error: %s\n", err.Error())
	task.stderr.Append(msg)
	task.tee.Write(msg)
	m.fanOut(task, OutputChunk{Stream: "stderr", Data: msg})
	go m.finalize(task, -1)
}

func (m *TaskManager) armTimeout(task *taskInternal) {
	if task.spec.TimeoutMs <= 0 {
		return
	}
	m.mu.Lock()
	task.timer = time.AfterFunc(time.Duration(task.spec.TimeoutMs)*time.Millisecond, func() {
		m.mu.Lock()
		if task.status != StatusRunning {
			m.mu.Unlock()
			return
		}
		task.timedOut = true
		m.signalLocked(task, syscall.SIGKILL)
		m.mu.Unlock()
	})
	m.mu.Unlock()
}

func (m *TaskManager) signalLocked(task *taskInternal, sig syscall.Signal) {
	if task.pid <= 0 {
		return
	}
	syscall.Kill(-task.pid, sig)
}

func (m *TaskManager) killGroup(task *taskInternal, sig syscall.Signal) {
	m.mu.Lock()
	m.signalLocked(task, sig)
	m.mu.Unlock()
}

// escalate schedules SIGKILL after the grace period. Caller holds the lock.
func (m *TaskManager) escalate(task *taskInternal) {
	time.AfterFunc(killEscalationDelay, func() {
		m.mu.Lock()
		if task.status == StatusRunning {
			m.signalLocked(task, syscall.SIGKILL)
		}
		m.mu.Unlock()
	})
}

func (m *TaskManager) finalize(task *taskInternal, exitCode int) {
	m.mu.Lock()
	if task.status != StatusRunning {
		m.mu.Unlock()
		return
	}
	var status string
	switch {
	case task.timedOut:
		status = StatusTimeout
	case exitCode == 0:
		status = StatusExited
	case exitCode == -1:
		status = StatusFailed
	case exitCode > 128:
		status = StatusKilled
	default:
		status = StatusExited
	}
	if task.timer != nil {
		task.timer.Stop()
	}
	task.status = status
	task.exitCode = &exitCode
	now := time.Now().UnixMilli()
	task.finishedAt = &now
	task.result = TaskResult{ExitCode: exitCode, Status: status, TimedOut: task.timedOut}
	close(task.done)
	phaseID := task.phaseID
	summary := m.summarizeLocked(task)
	handlers := append([]func(TaskSummary){}, m.exitHandlers...)
	m.mu.Unlock()

	task.tee.Close()
	if phaseID != "" && m.deps.PhaseManager != nil {
		if status == StatusExited || status == StatusKilled {
			m.deps.PhaseManager.Done(phaseID)
		} else {
			m.deps.PhaseManager.Fail(phaseID, fmt.Sprintf("exit %d", exitCode))
		}
	}
	for _, h := range handlers {
		func() {
			defer func() { recover() }()
			h(summary)
		}()
	}
	if m.deps.OnChange != nil {
		m.deps.OnChange()
	}
}

func (m *TaskManager) fanOut(task *taskInternal, chunk OutputChunk) {
	m.mu.Lock()
	subs := make([]func(OutputChunk), 0, len(task.subscribers))
	for _, fn := range task.subscribers {
		subs = append(subs, fn)
	}
	m.mu.Unlock()
	for _, fn := range subs {
		func() {
			defer func() { recover() }()
			fn(chunk)
		}()
	}
	if task.spec.LogName != "" && m.deps.BroadcastChunk != nil {
		m.deps.BroadcastChunk(task.spec.LogName, chunk.Data, false)
	}
}

func (m *TaskManager) Get(id string) (TaskSummary, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.tasks[id]
	if !ok {
		return TaskSummary{}, false
	}
	return m.summarizeLocked(t), true
}

type TaskOutput struct {
	Stdout    string
	Stderr    string
	Truncated bool
}

func (m *TaskManager) Output(id string) (TaskOutput, bool) {
	m.mu.Lock()
	t, ok := m.tasks[id]
	m.mu.Unlock()
	if !ok {
		return TaskOutput{}, false
	}
	stdout, outTrunc := t.stdout.Read()
	stderr, errTrunc := t.stderr.Read()
	return TaskOutput{
		Stdout:    stdout,
		Stderr:    stderr,
		Truncated: outTrunc || errTrunc || t.tee.IsTruncated(),
	}, true
}

// Finished blocks until the task completes. Second return is false for an
// unknown id.
func (m *TaskManager) Finished(id string) (TaskResult, bool) {
	m.mu.Lock()
	t, ok := m.tasks[id]
	m.mu.Unlock()
	if !ok {
		return TaskResult{}, false
	}
	<-t.done
	return t.result, true
}

func (m *TaskManager) Subscribe(id string, fn func(OutputChunk)) (func(), bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.tasks[id]
	if !ok {
		return nil, false
	}
	t.subCounter++
	key := t.subCounter
	t.subscribers[key] = fn
	return func() {
		m.mu.Lock()
		delete(t.subscribers, key)
		m.mu.Unlock()
	}, true
}

func (m *TaskManager) OnTaskExit(handler func(TaskSummary)) {
	m.mu.Lock()
	m.exitHandlers = append(m.exitHandlers, handler)
	m.mu.Unlock()
}

func (m *TaskManager) WaitForLogNamesIdle(logNames []string) {
	m.mu.Lock()
	var waiters []chan struct{}
	for _, t := range m.tasks {
		if t.status != StatusRunning || t.spec.LogName == "" {
			continue
		}
		for _, n := range logNames {
			if t.spec.LogName == n {
				waiters = append(waiters, t.done)
				break
			}
		}
	}
	m.mu.Unlock()
	for _, w := range waiters {
		<-w
	}
}

func (m *TaskManager) RunningCommandByLogName(logName string) (command, cwd string, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, t := range m.tasks {
		if t.status == StatusRunning && t.spec.LogName == logName {
			return t.spec.Command, t.spec.Cwd, true
		}
	}
	return "", "", false
}

func (m *TaskManager) List(statuses []string) []TaskSummary {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []TaskSummary{}
	for _, id := range m.order {
		t, ok := m.tasks[id]
		if !ok {
			continue
		}
		if len(statuses) > 0 {
			match := false
			for _, s := range statuses {
				if t.status == s {
					match = true
					break
				}
			}
			if !match {
				continue
			}
		}
		out = append(out, m.summarizeLocked(t))
	}
	return out
}

func (m *TaskManager) Kill(id string, sig syscall.Signal) bool {
	m.mu.Lock()
	t, ok := m.tasks[id]
	if !ok || t.status != StatusRunning {
		m.mu.Unlock()
		return false
	}
	m.signalLocked(t, sig)
	m.escalate(t)
	m.mu.Unlock()
	return true
}

func (m *TaskManager) KillByLogName(logName string, intentional bool, sig syscall.Signal) int {
	m.mu.Lock()
	count := 0
	for _, t := range m.tasks {
		if t.status != StatusRunning || t.spec.LogName != logName {
			continue
		}
		if intentional {
			t.intentional = true
		}
		m.signalLocked(t, sig)
		m.escalate(t)
		count++
	}
	m.mu.Unlock()
	return count
}

func (m *TaskManager) KillAll() int {
	m.mu.Lock()
	count := 0
	for _, t := range m.tasks {
		if t.status == StatusRunning {
			m.signalLocked(t, syscall.SIGTERM)
			count++
		}
	}
	m.mu.Unlock()
	return count
}

func (m *TaskManager) Delete(id string) bool {
	m.mu.Lock()
	t, ok := m.tasks[id]
	if !ok || t.status == StatusRunning {
		m.mu.Unlock()
		return false
	}
	delete(m.tasks, id)
	m.removeFromOrder(id)
	m.mu.Unlock()
	t.tee.Close()
	os.Remove(t.logPath)
	return true
}

func (m *TaskManager) removeFromOrder(id string) {
	for i, v := range m.order {
		if v == id {
			m.order = append(m.order[:i], m.order[i+1:]...)
			return
		}
	}
}

func (m *TaskManager) Shutdown() {
	close(m.reapStop)
	m.mu.Lock()
	tasks := make([]*taskInternal, 0, len(m.tasks))
	for _, t := range m.tasks {
		tasks = append(tasks, t)
	}
	m.tasks = map[string]*taskInternal{}
	m.order = nil
	for _, t := range tasks {
		if t.status == StatusRunning {
			m.signalLocked(t, syscall.SIGKILL)
		}
	}
	m.mu.Unlock()
	for _, t := range tasks {
		t.tee.Close()
	}
}

func (m *TaskManager) reap() {
	now := time.Now().UnixMilli()
	m.mu.Lock()
	var reaped []*taskInternal
	for id, t := range m.tasks {
		if t.status == StatusRunning || t.finishedAt == nil {
			continue
		}
		if now-*t.finishedAt > m.deps.TTL.Milliseconds() {
			delete(m.tasks, id)
			m.removeFromOrder(id)
			reaped = append(reaped, t)
		}
	}
	m.mu.Unlock()
	for _, t := range reaped {
		t.tee.Close()
		os.Remove(t.logPath)
	}
}

func (m *TaskManager) summarize(t *taskInternal) TaskSummary {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.summarizeLocked(t)
}

func (m *TaskManager) summarizeLocked(t *taskInternal) TaskSummary {
	return TaskSummary{
		ID:          t.id,
		Command:     t.spec.Command,
		Status:      t.status,
		ExitCode:    t.exitCode,
		StartedAt:   t.startedAt,
		FinishedAt:  t.finishedAt,
		TimedOut:    t.timedOut,
		Truncated:   t.tee.IsTruncated(),
		LogName:     t.spec.LogName,
		Intentional: t.intentional,
	}
}
