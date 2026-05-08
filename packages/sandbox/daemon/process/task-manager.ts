import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { appLogPath } from "../paths";
import { LogTee } from "./log-tee";
import { spawnPty } from "./pty-spawn";
import { RingBuffer } from "./ring-buffer";
import type { PhaseManager } from "./phase-manager";

const RING_BUFFER_BYTES = 256 * 1024;
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_REAP_INTERVAL_MS = 60 * 1000;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const TASK_FILE_PREFIX = "task";

export type TaskStatus = "running" | "exited" | "failed" | "killed" | "timeout";

export type TaskSpawnMode = "pipe" | "pty";

export interface TaskSpec {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  mode: TaskSpawnMode;
  timeoutMs?: number;
  /** Display label for SSE / log header. */
  label?: string;
  /**
   * Named-script tee. When set, output writes to `<logsDir>/app/<logName>`
   * (stable filename, overwritten across runs of the same name). When
   * unset, output writes to `<logsDir>/<taskId>` where taskId is `task<N>`
   * (sequential within the daemon lifetime, purged on startup).
   */
  logName?: string;
}

interface OutputChunk {
  stream: "stdout" | "stderr";
  data: string;
}

export interface TaskSummary {
  id: string;
  command: string;
  status: TaskStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  timedOut: boolean;
  truncated: boolean;
  /**
   * Mirrors `spec.logName`. Surfaced in summaries so the SSE active-tasks
   * payload can identify a task by its script name (e.g. "format") without
   * the consumer having to regex the command string.
   */
  logName?: string;
  /** True when the kill that terminated this task was flagged intentional
   *  (orchestrator-driven stop, replace-by-logName, or user Stop). */
  intentional?: boolean;
}

export interface TaskResult {
  exitCode: number;
  status: TaskStatus;
  timedOut: boolean;
}

interface TaskInternal {
  id: string;
  spec: TaskSpec;
  status: TaskStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  timedOut: boolean;
  pid: number | undefined;
  pgid: number | undefined;
  phaseId: string | undefined;
  stdout: RingBuffer;
  stderr: RingBuffer;
  /**
   * Single combined tee at `<logsDir>/<id>`. Header line ("$ <command>")
   * is written first, then stdout + stderr chunks interleave in arrival
   * order. Capped at 10MB; cleaned up when the task is reaped.
   */
  tee: LogTee;
  logPath: string;
  subscribers: Set<(c: OutputChunk) => void>;
  finishedPromise: Promise<TaskResult>;
  resolveFinished: (r: TaskResult) => void;
  kill: (signal?: NodeJS.Signals) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set when a kill was flagged intentional. Surfaced on TaskSummary
   *  so subscribers can distinguish stop from crash. */
  intentional: boolean;
  /** Guard flag to ensure onTaskExit handlers fire exactly once. */
  exitFired: boolean;
}

export interface TaskManagerDeps {
  /** Where per-task logs live: <logsDir>/<taskId>/{stdout,stderr}.log. */
  logsDir: string;
  ttlMs?: number;
  reapIntervalMs?: number;
  /** Fires on spawn and finalize so callers can re-broadcast the running set. */
  onChange?: () => void;
  /** When provided, each task is registered as a named phase on spawn/finalize. */
  phaseManager?: PhaseManager;
  /**
   * When provided, tasks with a `logName` mirror their stdout/stderr onto the
   * global SSE log stream under that name. The env-tab terminal is keyed on
   * `logName`, so without this the terminal stays empty (only the per-task
   * subscribers and the on-disk tee see the chunks). The header line
   * (`$ <label>`) is also broadcast on spawn.
   */
  broadcaster?: {
    broadcastChunk: (source: string, data: string) => void;
  };
}

/**
 * Manages transient, concurrent tasks (ad-hoc bash, package scripts via
 * /exec/:name). UUID-keyed; many tasks may run in parallel. The managed
 * application service (dev server) is NOT here — see ApplicationService.
 *
 * Lifecycle:
 *   spawn → running → (exited | failed | killed | timeout)
 *   completed tasks are reaped after `ttlMs` (default 15 min).
 */
export class TaskManager {
  private readonly tasks = new Map<string, TaskInternal>();
  private readonly reaper: ReturnType<typeof setInterval>;
  private readonly ttlMs: number;
  private idCounter = 0;
  private readonly exitHandlers = new Set<(s: TaskSummary) => void>();

  constructor(private readonly deps: TaskManagerDeps) {
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    // Stale `task*` files from previous daemon lifetimes are unreachable
    // (in-memory state is gone; IDs restart from 1). Drop them so the
    // workspace doesn't accumulate orphaned tees.
    this.purgeStaleLogs();
    this.reaper = setInterval(
      () => this.reap(),
      deps.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS,
    );
    this.reaper.unref?.();
  }

  async spawn(
    spec: TaskSpec & { replaceByLogName?: boolean },
  ): Promise<TaskSummary> {
    if (spec.replaceByLogName && spec.logName) {
      // Kill any running task with the same logName, await exit, then proceed.
      // Mirrors the old ApplicationService.start() "replace if alive" semantic
      // but inside a single owner — no leaked PTYs, no orphaned log routing.
      const waiters: Array<Promise<unknown>> = [];
      for (const t of this.tasks.values()) {
        if (t.status !== "running" || t.spec.logName !== spec.logName) continue;
        t.intentional = true;
        t.kill("SIGTERM");
        setTimeout(() => {
          if (t.status === "running") t.kill("SIGKILL");
        }, 3000);
        waiters.push(t.finishedPromise);
      }
      if (waiters.length > 0) await Promise.all(waiters);
    }
    const id = `${TASK_FILE_PREFIX}${++this.idCounter}`;
    const task = this.create(id, spec);
    this.tasks.set(id, task);
    this.deps.onChange?.();
    return summarize(task);
  }

  get(id: string): TaskSummary | null {
    const t = this.tasks.get(id);
    return t ? summarize(t) : null;
  }

  output(
    id: string,
  ): { stdout: string; stderr: string; truncated: boolean } | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    const stdout = t.stdout.read();
    const stderr = t.stderr.read();
    return {
      stdout: stdout.data,
      stderr: stderr.data,
      truncated: stdout.truncated || stderr.truncated || t.tee.isTruncated(),
    };
  }

  finished(id: string): Promise<TaskResult> | null {
    const t = this.tasks.get(id);
    return t ? t.finishedPromise : null;
  }

  subscribe(id: string, fn: (c: OutputChunk) => void): (() => void) | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    t.subscribers.add(fn);
    return () => t.subscribers.delete(fn);
  }

  /** Subscribe to per-task exit events. Handler receives the final
   *  summary (status, exitCode, intentional, logName). Returns an
   *  unsubscribe function. */
  onTaskExit(handler: (s: TaskSummary) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  /** Resolves once no running task carries any of the given logNames.
   *  Used by the orchestrator to await dev/start shutdown before
   *  branch/install transitions. */
  async waitForLogNamesIdle(logNames: ReadonlyArray<string>): Promise<void> {
    const matching = (): TaskInternal[] => {
      const out: TaskInternal[] = [];
      for (const t of this.tasks.values()) {
        if (
          t.status === "running" &&
          t.spec.logName &&
          logNames.includes(t.spec.logName)
        ) {
          out.push(t);
        }
      }
      return out;
    };
    const initial = matching();
    if (initial.length === 0) return;
    await Promise.all(initial.map((t) => t.finishedPromise));
  }

  list(filter?: { status?: ReadonlyArray<TaskStatus> }): TaskSummary[] {
    const out: TaskSummary[] = [];
    for (const t of this.tasks.values()) {
      if (filter?.status && !filter.status.includes(t.status)) continue;
      out.push(summarize(t));
    }
    return out;
  }

  kill(id: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
    const t = this.tasks.get(id);
    if (!t) return false;
    if (t.status !== "running") return false;
    t.kill(signal);
    setTimeout(() => {
      if (t.status === "running") {
        t.kill("SIGKILL");
      }
    }, 3000);
    return true;
  }

  killByLogName(
    logName: string,
    opts?: { intentional?: boolean; signal?: NodeJS.Signals },
  ): number {
    const signal = opts?.signal ?? "SIGTERM";
    let count = 0;
    for (const t of this.tasks.values()) {
      if (t.status !== "running" || t.spec.logName !== logName) continue;
      if (opts?.intentional) t.intentional = true;
      t.kill(signal);
      setTimeout(() => {
        if (t.status === "running") t.kill("SIGKILL");
      }, 3000);
      count++;
    }
    return count;
  }

  killAll(): number {
    let count = 0;
    for (const t of this.tasks.values()) {
      if (t.status === "running") {
        t.kill("SIGTERM");
        count++;
      }
    }
    return count;
  }

  delete(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t) return false;
    if (t.status === "running") return false;
    this.tasks.delete(id);
    t.tee.close();
    this.unlink(t.logPath);
    return true;
  }

  shutdown(): void {
    clearInterval(this.reaper);
    for (const t of this.tasks.values()) {
      if (t.status === "running") t.kill("SIGKILL");
      t.tee.close();
    }
    this.tasks.clear();
  }

  private reap(): void {
    const now = Date.now();
    for (const [id, t] of this.tasks) {
      if (t.status === "running" || t.finishedAt === null) continue;
      if (now - t.finishedAt > this.ttlMs) {
        this.tasks.delete(id);
        t.tee.close();
        this.unlink(t.logPath);
      }
    }
  }

  private purgeStaleLogs(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.deps.logsDir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith(TASK_FILE_PREFIX)) continue;
      this.unlink(join(this.deps.logsDir, name));
    }
  }

  private unlink(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      /* file already gone or never opened */
    }
  }

  private create(id: string, spec: TaskSpec): TaskInternal {
    const stdout = new RingBuffer(RING_BUFFER_BYTES);
    const stderr = new RingBuffer(RING_BUFFER_BYTES);
    const logPath = spec.logName
      ? appLogPath(this.deps.logsDir, spec.logName)
      : join(this.deps.logsDir, id);
    const tee = new LogTee(logPath, LOG_MAX_BYTES);
    const headerLine = spec.label ?? `$ ${spec.command}`;
    tee.writeHeader(headerLine);
    if (spec.logName) {
      this.deps.broadcaster?.broadcastChunk(spec.logName, `${headerLine}\r\n`);
    }
    const subscribers = new Set<(c: OutputChunk) => void>();

    let resolveFinished!: (r: TaskResult) => void;
    const finishedPromise = new Promise<TaskResult>((resolve) => {
      resolveFinished = resolve;
    });

    const phaseId = this.deps.phaseManager?.begin(spec.label ?? spec.command);
    const task: TaskInternal = {
      id,
      spec,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      timedOut: false,
      pid: undefined,
      pgid: undefined,
      phaseId,
      stdout,
      stderr,
      tee,
      logPath,
      subscribers,
      finishedPromise,
      resolveFinished,
      kill: () => undefined,
      timer: null,
      intentional: false,
      exitFired: false,
    };

    if (spec.mode === "pty") {
      this.startPty(task);
    } else {
      this.startPipe(task);
    }
    return task;
  }

  private startPty(task: TaskInternal): void {
    let child: ReturnType<typeof spawnPty>;
    try {
      child = spawnPty({
        cmd: task.spec.command,
        cwd: task.spec.cwd,
        env: task.spec.env as NodeJS.ProcessEnv | undefined,
      });
    } catch (e) {
      const msg = `spawn error: ${(e as Error).message}\n`;
      task.stderr.append(msg);
      task.tee.write(msg);
      this.fanOut(task, { stream: "stderr", data: msg });
      // Defer finalize so callers awaiting `finished` see the same shape
      // as a normal exit; spawn() returning synchronously must observe a
      // running task for one tick before it resolves to failed.
      queueMicrotask(() =>
        this.finalize(task, { exitCode: -1, timedOut: false }),
      );
      return;
    }
    task.pid = child.pid;
    task.kill = (signal) => child.kill(signal ?? "SIGTERM");

    child.onData((data) => {
      task.stdout.append(data);
      task.tee.write(data);
      this.fanOut(task, { stream: "stdout", data });
    });

    if (task.spec.timeoutMs && task.spec.timeoutMs > 0) {
      task.timer = setTimeout(() => {
        if (task.status !== "running") return;
        task.timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, task.spec.timeoutMs);
    }

    child.onExit((code) => {
      if (task.timer) clearTimeout(task.timer);
      this.finalize(task, {
        exitCode: code,
        timedOut: task.timedOut,
      });
    });
  }

  private startPipe(task: TaskInternal): void {
    const opts: Parameters<typeof nodeSpawn>[2] = {
      cwd: task.spec.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: task.spec.env,
      detached: true,
    };
    const child: ChildProcess = nodeSpawn(
      "bash",
      ["-c", task.spec.command],
      opts,
    );
    task.pid = child.pid;
    task.pgid = child.pid;

    const killGroup = (signal: NodeJS.Signals) => {
      if (task.pgid === undefined) return;
      try {
        process.kill(-task.pgid, signal);
      } catch {
        /* group already gone */
      }
    };
    task.kill = (signal) => killGroup(signal ?? "SIGTERM");

    child.stdout?.on("data", (chunk: Buffer) => {
      const data = chunk.toString("utf-8");
      task.stdout.append(data);
      task.tee.write(data);
      this.fanOut(task, { stream: "stdout", data });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const data = chunk.toString("utf-8");
      task.stderr.append(data);
      task.tee.write(data);
      this.fanOut(task, { stream: "stderr", data });
    });

    if (task.spec.timeoutMs && task.spec.timeoutMs > 0) {
      task.timer = setTimeout(() => {
        if (task.status !== "running") return;
        task.timedOut = true;
        killGroup("SIGKILL");
      }, task.spec.timeoutMs);
    }

    child.on("close", (code) => {
      if (task.timer) clearTimeout(task.timer);
      // Reap survivors of any backgrounded children.
      killGroup("SIGKILL");
      this.finalize(task, {
        exitCode: code ?? 1,
        timedOut: task.timedOut,
      });
    });
    child.on("error", (err) => {
      if (task.timer) clearTimeout(task.timer);
      const msg = `spawn error: ${err.message}\n`;
      task.stderr.append(msg);
      task.tee.write(msg);
      this.fanOut(task, { stream: "stderr", data: msg });
      this.finalize(task, { exitCode: -1, timedOut: false });
    });
  }

  private finalize(
    task: TaskInternal,
    result: { exitCode: number; timedOut: boolean },
  ): void {
    if (task.status !== "running") return;
    let status: TaskStatus;
    if (result.timedOut) status = "timeout";
    else if (result.exitCode === 0) status = "exited";
    else if (result.exitCode === -1) status = "failed";
    else if (result.exitCode > 128) status = "killed";
    else status = "exited";
    task.status = status;
    task.exitCode = result.exitCode;
    task.finishedAt = Date.now();
    task.tee.close();
    if (task.phaseId) {
      if (status === "exited" || status === "killed") {
        this.deps.phaseManager?.done(task.phaseId);
      } else {
        this.deps.phaseManager?.fail(task.phaseId, `exit ${result.exitCode}`);
      }
    }
    task.resolveFinished({
      exitCode: result.exitCode,
      status,
      timedOut: result.timedOut,
    });
    // Fire onTaskExit handlers exactly once, with the guard flag.
    if (!task.exitFired) {
      task.exitFired = true;
      const summary = summarize(task);
      for (const h of this.exitHandlers) {
        try {
          h(summary);
        } catch {
          /* handlers must not crash the task lifecycle */
        }
      }
    }
    this.deps.onChange?.();
  }

  private fanOut(task: TaskInternal, chunk: OutputChunk): void {
    for (const sub of task.subscribers) {
      try {
        sub(chunk);
      } catch {
        /* one bad subscriber doesn't stop the rest */
      }
    }
    if (task.spec.logName) {
      this.deps.broadcaster?.broadcastChunk(task.spec.logName, chunk.data);
    }
  }
}

function summarize(t: TaskInternal): TaskSummary {
  return {
    id: t.id,
    command: t.spec.command,
    status: t.status,
    exitCode: t.exitCode,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    timedOut: t.timedOut,
    truncated: t.tee.isTruncated(),
    logName: t.spec.logName,
    intentional: t.intentional,
  };
}
