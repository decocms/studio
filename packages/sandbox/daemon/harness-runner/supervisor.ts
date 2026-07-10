/**
 * Daemon-side harness-runner supervision: spawn-on-demand, single shared
 * process, no auto-respawn (the next dispatch respawns — a crash therefore
 * costs each in-flight run one `harness_crashed` and nothing else, never a
 * respawn storm). The runner is the daemon's own bundle re-executed with
 * HARNESS_RUNNER_MODE=1; HARNESS_RUNNER_CMD overrides the argv (e2e seam,
 * mirrors DAEMON_E2E_CMD).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  HARNESS_RUNNER_CMD_ENV,
  HARNESS_RUNNER_MODE_ENV,
  HARNESS_RUNNER_READY_PREFIX,
  HARNESS_RUNNER_TOKEN_ENV,
} from "./protocol";

const READY_TIMEOUT_MS = 30_000;

export interface RunnerHandle {
  port: number;
  token: string;
  proc: ChildProcess;
}

let handlePromise: Promise<RunnerHandle> | null = null;
let activeProc: ChildProcess | null = null;

function resolveRunnerCmd(): string[] {
  const raw = process.env[HARNESS_RUNNER_CMD_ENV];
  if (raw && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((x) => typeof x === "string")
      ) {
        return parsed;
      }
    } catch {
      /* not JSON — fall back to whitespace split */
    }
    return raw.trim().split(/\s+/);
  }
  const self = process.argv[1];
  if (!self) {
    throw new Error("harness-runner: cannot resolve own entry from argv");
  }
  return [process.execPath, self];
}

function spawnRunner(): Promise<RunnerHandle> {
  return new Promise((resolve, reject) => {
    const token = randomUUID();
    const [cmd, ...args] = resolveRunnerCmd();
    const proc = spawn(cmd!, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        [HARNESS_RUNNER_MODE_ENV]: "1",
        [HARNESS_RUNNER_TOKEN_ENV]: token,
      },
    });
    activeProc = proc;

    let settled = false;
    let buf = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      reject(
        new Error(
          `harness-runner did not report ready within ${READY_TIMEOUT_MS}ms`,
        ),
      );
    }, READY_TIMEOUT_MS);

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (settled) {
        process.stdout.write(chunk);
        return;
      }
      buf += chunk.toString();
      let nl = buf.indexOf("\n");
      while (nl >= 0 && !settled) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith(HARNESS_RUNNER_READY_PREFIX)) {
          settled = true;
          clearTimeout(timer);
          try {
            const { port } = JSON.parse(
              line.slice(HARNESS_RUNNER_READY_PREFIX.length),
            ) as { port: number };
            console.log(`[harness-runner] ready pid=${proc.pid} port=${port}`);
            resolve({ port, token, proc });
          } catch (err) {
            proc.kill("SIGKILL");
            reject(
              new Error(`harness-runner: malformed ready line: ${String(err)}`),
            );
          }
          if (buf.length > 0) process.stdout.write(buf);
          buf = "";
        } else {
          process.stdout.write(`${line}\n`);
        }
        nl = buf.indexOf("\n");
      }
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.on("exit", (code, signal) => {
      console.log(`[harness-runner] exited code=${code} signal=${signal}`);
      if (activeProc === proc) {
        activeProc = null;
        handlePromise = null;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `harness-runner exited before ready (code=${code} signal=${signal})`,
        ),
      );
    });
  });
}

export function ensureHarnessRunner(): Promise<RunnerHandle> {
  handlePromise ??= spawnRunner().catch((err) => {
    handlePromise = null;
    throw err;
  });
  return handlePromise;
}

export function shutdownHarnessRunner(): void {
  activeProc?.kill("SIGTERM");
}

/** Sync last-resort kill for the daemon's `exit` handler. */
export function killHarnessRunnerSync(): void {
  activeProc?.kill("SIGKILL");
}
