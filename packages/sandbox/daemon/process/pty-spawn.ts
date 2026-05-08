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
 */

import fs from "node:fs";
import { spawn as ptySpawn } from "node-pty";

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
  /** Shell command. Runs as `sh -c <cmd>`. */
  cmd: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Drop privileges to this uid (Linux only; ignored on macOS). */
  uid?: number;
  /** Drop privileges to this gid (Linux only; ignored on macOS). */
  gid?: number;
  /** Defaults to 120. */
  cols?: number;
  /** Defaults to 30. */
  rows?: number;
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

  const spawnOpts: Parameters<typeof ptySpawn>[2] = {
    name: "xterm-256color",
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 30,
    cwd: opts.cwd ?? process.cwd(),
    env: { TERM: "xterm-256color", ...baseEnv, ...overrideEnv },
  };
  if (typeof opts.uid === "number")
    (spawnOpts as Record<string, unknown>).uid = opts.uid;
  if (typeof opts.gid === "number")
    (spawnOpts as Record<string, unknown>).gid = opts.gid;

  // forkpty(3) can fail transiently in CI containers under PTY pressure
  // (concurrent test files allocating PTYs faster than the kernel reaps them).
  // Retry a few times before giving up — production callers also benefit from
  // resilience to brief PTY exhaustion.
  let raw!: ReturnType<typeof ptySpawn>;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      raw = ptySpawn("sh", ["-c", opts.cmd], spawnOpts);
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
  if (lastErr) throw lastErr;

  const pid = raw.pid;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const socket = (raw as any)._socket as {
    fd: number;
    destroy: (err?: Error) => void;
  };
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

  /** Map node-pty's (exitCode, signal) to a shell-convention exit code. */
  function shellExitCode(code: number, signal: number): number {
    // On macOS node-pty always reports exitCode=0 for signal-killed processes;
    // the signal number is in `signal`. Map to shell convention: 128 + signal.
    if (signal > 0) return 128 + signal;
    return code;
  }

  function fireExit(code: number): void {
    if (done) return;
    done = true;
    clearInterval(dataPoller);
    for (const listener of exitListeners) listener(code);
  }

  // node-pty's native exit fires after the close chain completes.
  raw.onExit(({ exitCode, signal }) => {
    fireExit(shellExitCode(exitCode, signal ?? 0));
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
