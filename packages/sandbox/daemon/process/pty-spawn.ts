/**
 * Thin wrapper around `node-pty.spawn` that allocates a pseudo-terminal for
 * a shell command. Children see `isatty(stdout) === true`, so they emit
 * colors, draw progress bars, and line-buffer their output — restoring the
 * UX `script(1)` was meant to provide but works portably on macOS + Linux.
 *
 * Output stdout/stderr are merged into a single stream — this matches the
 * SSE log-streaming pipeline downstream, which doesn't care about source.
 *
 * ## Bun Compatibility Note
 *
 * Bun's `tty.ReadStream` incorrectly treats `EAGAIN` on a PTY master fd as a
 * fatal error and calls `stream.destroy(eagainError)` on the first read
 * attempt, before any data arrives. This closes the fd and makes
 * `onData`/`onExit` silently stop working.
 *
 * The workaround patches `socket.destroy` synchronously (before the event
 * loop runs) to:
 *   - Block calls with an EAGAIN error (Bun's premature destroy).
 *   - Allow calls with no error (node-pty's own cleanup after child exit).
 *
 * Data is read by a `setInterval`-based polling loop using `fs.readSync`.
 * Exit is detected when node-pty's native callback fires its 200 ms timer
 * and calls `socket.destroy()` with no error — that destroy is allowed
 * through, which completes the close chain and fires `raw.onExit`.
 * The actual exit code / signal is captured there; signals are mapped to
 * shell-style exit codes (`128 + signal`).
 *
 * This whole workaround is POSIX-only: it only makes sense for a real PTY
 * master fd (exposed via `_socket.fd` on `UnixTerminal`). node-pty's Windows
 * implementation (ConPTY/winpty, `WindowsTerminal`) backs `_socket` with a
 * `net.Socket` over a named pipe instead — `.fd` is not a number there, and
 * Bun's `tty.ReadStream`/EAGAIN bug doesn't apply to it in the first place.
 * `spawnPty` detects that case (`typeof socket?.fd !== "number"`) and drives
 * I/O through node-pty's public `onData`/`onExit` API directly, with no
 * fd polling and no destroy patching.
 */

import fs from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { spawn as ptySpawn } from "node-pty";
import {
  isStructuredCommand,
  type StructuredCommand,
} from "./structured-command";
import { resolveShell } from "./resolve-shell";
import { SIGNAL_NUMBERS } from "./signal-numbers";

export { ShellNotFoundError } from "./structured-command";

export interface PtyHandle {
  /** OS process id of the spawned child. */
  pid: number;
  /** Subscribe to merged stdout/stderr output. */
  onData(cb: (data: string) => void): void;
  /** Fired exactly once when the child exits. */
  onExit(cb: (exitCode: number) => void): void;
  /** Send a signal (default SIGHUP — node-pty's convention). */
  kill(signal?: string): void;
}

export interface PtySpawnOpts {
  /** Shell command (runs via a resolved shell) OR a shell-free argv spawn. */
  cmd: string | StructuredCommand;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Drop privileges to this uid (Linux only; ignored on macOS/win32). */
  uid?: number;
  gid?: number;
  cols?: number;
  rows?: number;
}

function ptyArgv(
  cmd: string | StructuredCommand,
  childPath?: string,
): [string, string[]] {
  if (isStructuredCommand(cmd)) {
    const [exe, ...rest] = cmd.argv;
    // win32: a bare command name (e.g. "git") is the same shape that made
    // resolveShell() necessary for bash below — node-pty's ConPTY spawn
    // doesn't reliably resolve it via PATH, so structured commands (git
    // clone/fetch/checkout, …) can hit a spurious "File not found" even
    // when the real executable IS on PATH. Resolve up front via Bun.which
    // (same pattern already used for rclone in org-fs/sidecar-main.ts) so
    // PATH search happens in a context known to work; fall back to the
    // bare name — preserving today's behavior, including the legible
    // "<exe> not found on PATH" error below — when Bun.which can't find it
    // either. Resolve against the CHILD's effective PATH (the merged env
    // may prepend runtimePathDirs like /opt/bun/bin), not the daemon's own
    // — on POSIX execvp resolves in the child env, and win32 must match
    // that or a runtime-pinned binary hits "File not found" while a
    // shadowed one silently runs the wrong copy.
    if (process.platform === "win32") {
      const resolved = childPath
        ? Bun.which(exe, { PATH: childPath })
        : Bun.which(exe);
      if (resolved) return [resolved, rest];
    }
    return [exe, rest];
  }
  // String command → needs a shell. win32 has no `sh`; resolveShell finds
  // Git Bash (or throws ShellNotFoundError legibly if it can't).
  if (process.platform === "win32") {
    return [resolveShell("sh"), ["-c", cmd]];
  }
  return ["sh", ["-c", cmd]];
}

export function spawnPty(opts: PtySpawnOpts): PtyHandle {
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") baseEnv[k] = v;
  }

  const overrideEnv: Record<string, string> = {};
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (typeof v === "string") overrideEnv[k] = v;
    }
  }

  const structured = isStructuredCommand(opts.cmd) ? opts.cmd : undefined;
  const spawnOpts: Parameters<typeof ptySpawn>[2] = {
    name: "xterm-256color",
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 30,
    cwd: opts.cwd ?? structured?.cwd ?? process.cwd(),
    env: {
      ...baseEnv,
      TERM: "xterm-256color",
      ...structured?.env,
      ...overrideEnv,
    },
  };
  // uid/gid: Linux-only concept. Setting them on win32 throws in libuv; on
  // macOS a non-root daemon can't setuid anyway. Gate hard.
  if (process.platform === "linux") {
    if (typeof opts.uid === "number")
      (spawnOpts as Record<string, unknown>).uid = opts.uid;
    if (typeof opts.gid === "number")
      (spawnOpts as Record<string, unknown>).gid = opts.gid;
  }

  // forkpty(3) can fail transiently in CI containers under PTY pressure
  // (concurrent test files allocating PTYs faster than the kernel reaps them).
  // Retry a few times before giving up — production callers also benefit from
  // resilience to brief PTY exhaustion.
  // Computed once, outside the retry loop below: a deterministic
  // ShellNotFoundError (or any other resolution error) must not burn the
  // 3 forkpty retries — it will fail identically every time.
  const [file, args] = ptyArgv(
    opts.cmd,
    (spawnOpts.env as Record<string, string>).PATH,
  );

  let raw!: ReturnType<typeof ptySpawn>;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      raw = ptySpawn(file, args, spawnOpts);
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      // Brief sync pause before retry: 50ms × attempt+1.
      // Bun.sleepSync is preferred when available; fall back to a busy-wait.
      const pauseMs = 50 * (attempt + 1);
      const sleepSync = (
        globalThis as { Bun?: { sleepSync?: (ms: number) => void } }
      ).Bun?.sleepSync;
      if (sleepSync) {
        sleepSync(pauseMs);
      } else {
        const end = Date.now() + pauseMs;
        while (Date.now() < end) {
          // intentional spin
        }
      }
    }
  }
  if (lastErr) {
    // node-pty prebuilt binaries may not run on very new OS versions (e.g.
    // macOS 26 / Darwin 25+). Fall back to a plain child_process.spawn so
    // setup steps (clone/install) still work — color/progress output is lost
    // but all data and exit-code semantics are preserved.
    if ((lastErr as Error).message?.includes("posix_spawnp")) {
      return spawnFallback(opts);
    }
    // ConPTY's "File not found" is bare — no executable name — when a
    // structured command's argv[0] (e.g. `git`) isn't on PATH. That was the
    // original dead-end for customers: name the culprit and point at a fix.
    if (
      process.platform === "win32" &&
      /File not found/i.test((lastErr as Error).message ?? "")
    ) {
      throw new Error(
        `"${file}" not found on PATH — the daemon needs it to run this step. ` +
          `Install Git for Windows (https://gitforwindows.org) or run the daemon under WSL2.`,
      );
    }
    throw lastErr;
  }

  const pid = raw.pid;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const socket = (raw as any)._socket as
    | { fd?: number; destroy: (err?: Error) => void }
    | undefined;

  /** Map node-pty's (exitCode, signal) to a shell-convention exit code. */
  function shellExitCode(code: number, signal: number): number {
    // On macOS node-pty always reports exitCode=0 for signal-killed processes;
    // the signal number is in `signal`. Map to shell convention: 128 + signal.
    if (signal > 0) return 128 + signal;
    return code;
  }

  // node-pty's Windows implementation (ConPTY/winpty, see windowsTerminal.js)
  // backs `_socket` with a `net.Socket` over a named pipe, not a POSIX PTY
  // master fd — `.fd` is not a number there. The entire Bun-compat machinery
  // below exists to work around Bun's tty.ReadStream mis-handling EAGAIN on a
  // POSIX PTY master fd (see the file header); that bug doesn't apply here,
  // so drive I/O through node-pty's own public API instead — `onData`/
  // `onExit` work via the socket's normal event plumbing on every platform
  // and were never subject to the Bun bug in the first place.
  if (typeof socket?.fd !== "number") {
    const dataListeners: Array<(data: string) => void> = [];
    const exitListeners: Array<(exitCode: number) => void> = [];
    let done = false;

    raw.onData((data: string) => {
      for (const listener of dataListeners) listener(data);
    });
    raw.onExit(({ exitCode, signal }) => {
      if (done) return;
      done = true;
      // `exitCode` can arrive undefined/null in edge cases (e.g. the pty is
      // torn down before the child's own exit is observed by the native
      // layer) — never let that resolve a caller's "did the step succeed?"
      // check as `undefined` (upstream compares `result.code !== 0`, and
      // `undefined !== 0` is true, but logs a useless "exit undefined").
      // Default to a real failure code instead.
      for (const listener of exitListeners) {
        listener(shellExitCode(exitCode ?? 1, signal ?? 0));
      }
    });

    return {
      pid,
      onData(cb) {
        dataListeners.push(cb);
      },
      onExit(cb) {
        exitListeners.push(cb);
      },
      kill(signal) {
        // node-pty's WindowsTerminal.kill(signal) THROWS ("Signals not
        // supported on windows.") for any signal argument; on win32 every
        // signal means terminate, so call bare — the ConPTY agent kill
        // closes the pipe and onExit fires normally. Guarding here (not in
        // callers) keeps task-manager's SIGTERM→SIGKILL escalation code
        // platform-agnostic.
        if (process.platform === "win32") {
          raw.kill();
          return;
        }
        raw.kill(signal);
      },
    };
  }

  const fd: number = socket.fd;

  // ── Bun Compat Patch ──────────────────────────────────────────────────────
  // Bun's tty.ReadStream calls socket.destroy(eagainError) on the first read
  // when no data is available yet (an EAGAIN). This is incorrect — EAGAIN on
  // a PTY master fd is transient, not fatal. We block only those calls.
  //
  // node-pty itself calls socket.destroy() with NO error argument after the
  // child exits (via a 200 ms timer inside the native onexit callback). We
  // allow those through so the normal close → exit chain fires and raw.onExit
  // receives the true exit code.
  const origDestroy = socket.destroy.bind(socket);

  socket.destroy = function (err?: NodeJS.ErrnoException) {
    if (err?.code === "EAGAIN" || err?.code === "EWOULDBLOCK") {
      return; // Bun's premature destroy — ignore
    }
    // Clean destroy (no error, or non-EAGAIN error): let node-pty proceed.
    origDestroy(err);
  };
  // ── End Bun Compat Patch ─────────────────────────────────────────────────

  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(exitCode: number) => void> = [];
  let done = false;

  function fireExit(code: number): void {
    if (done) return;
    done = true;
    clearInterval(dataPoller);
    for (const listener of exitListeners) listener(code);
  }

  // node-pty's native exit fires after the close chain completes. `exitCode`
  // is expected to always be a number here (this is the real POSIX fd path),
  // but never let a stray undefined resolve a caller's exit-code check as
  // `undefined` — fall back to the same "assume clean exit" default the EOF
  // path below uses.
  raw.onExit(({ exitCode, signal }) => {
    fireExit(shellExitCode(exitCode ?? 0, signal ?? 0));
  });

  // ── Data polling loop ─────────────────────────────────────────────────────
  // Poll the PTY master fd non-blocking via readSync. EAGAIN = no data yet
  // (retry). n === 0 = EOF (PTY slave closed — child exited normally). On
  // macOS the master fd may stay EAGAIN forever after kill() since the kernel
  // keeps the slave alive until the master is closed; in that case, exit is
  // detected via node-pty's "clean" destroy() call above, which fires the
  // close → raw.onExit chain without needing an EOF read.
  const buf = Buffer.alloc(8192);
  const dataPoller = setInterval(() => {
    if (done) {
      clearInterval(dataPoller);
      return;
    }
    try {
      const n = fs.readSync(fd, buf, 0, 8192, null);
      if (n > 0) {
        const data = buf.slice(0, n).toString("utf8");
        for (const listener of dataListeners) listener(data);
      } else if (n === 0) {
        // EOF: PTY slave closed (child exited, data fully drained).
        // Trigger the node-pty close chain to get the real exit code.
        clearInterval(dataPoller);
        origDestroy();
        // Fallback: if raw.onExit doesn't fire within 300 ms, use code 0.
        setTimeout(() => {
          if (!done) fireExit(0);
        }, 300);
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") return; // no data yet
      // EBADF or EIO: fd closed by external means.
      clearInterval(dataPoller);
      origDestroy();
      setTimeout(() => {
        if (!done) fireExit(1);
      }, 300);
    }
  }, 5);

  return {
    pid,
    onData(cb) {
      dataListeners.push(cb);
    },
    onExit(cb) {
      exitListeners.push(cb);
    },
    kill(signal) {
      raw.kill(signal);
    },
  };
}

function spawnFallback(opts: PtySpawnOpts): PtyHandle {
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") baseEnv[k] = v;
  }
  const overrideEnv: Record<string, string> = {};
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (typeof v === "string") overrideEnv[k] = v;
    }
  }

  const structured = isStructuredCommand(opts.cmd) ? opts.cmd : undefined;
  const spawnOpts: Parameters<typeof nodeSpawn>[2] = {
    cwd: opts.cwd ?? structured?.cwd ?? process.cwd(),
    env: {
      ...baseEnv,
      TERM: "xterm-256color",
      ...structured?.env,
      ...overrideEnv,
    },
    ...(process.platform === "linux" && typeof opts.uid === "number"
      ? { uid: opts.uid }
      : {}),
    ...(process.platform === "linux" && typeof opts.gid === "number"
      ? { gid: opts.gid }
      : {}),
  };

  const [file, args] = ptyArgv(
    opts.cmd,
    (spawnOpts.env as Record<string, string>).PATH,
  );
  const child = nodeSpawn(file, args, spawnOpts);
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(exitCode: number) => void> = [];

  const emit = (chunk: Buffer | string) => {
    const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const l of dataListeners) l(str);
  };
  child.stdout?.on("data", emit);
  child.stderr?.on("data", emit);

  child.on("exit", (code, signal) => {
    const sigNum = signal ? (SIGNAL_NUMBERS[signal] ?? 1) : 0;
    const exitCode = sigNum > 0 ? 128 + sigNum : (code ?? 0);
    for (const l of exitListeners) l(exitCode);
  });

  return {
    pid: child.pid ?? -1,
    onData: (cb) => {
      dataListeners.push(cb);
    },
    onExit: (cb) => {
      exitListeners.push(cb);
    },
    kill: (signal) => {
      child.kill((signal ?? "SIGHUP") as NodeJS.Signals);
    },
  };
}
