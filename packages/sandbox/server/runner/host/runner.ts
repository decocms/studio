/**
 * Host sandbox runner — local dev / single-tenant self-host.
 *
 * Spawns the same Bun-based daemon as Docker but as a host child process,
 * with the workdir at `${homeDir}/sandboxes/<handle>/`. When `opts.repo` is
 * set, the daemon clones cloneUrl@branch into that workdir during setup;
 * otherwise the workdir stays empty and the daemon skips clone/install/
 * autostart. The local ingress (`startLocalSandboxIngress`) routes
 * `<handle>.localhost:7070` to the daemon's host-side TCP port.
 *
 * Hardening (read-only rootfs, dropped caps, memory limits) is intentionally
 * absent — the daemon runs in the user's trust boundary.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  postConfig,
  probeDaemonHealth,
  proxyDaemonRequest,
  daemonBash,
} from "../../daemon-client";
import type { ConfigResponse, DaemonHealth } from "../../daemon-client";
import {
  applyPreviewPattern,
  buildConfigPayload,
  computeHandle,
} from "../shared";
import type { RunnerStateStore } from "../state-store";
import type {
  EnsureOptions,
  ExecInput,
  ExecOutput,
  ProxyRequestInit,
  Sandbox,
  SandboxId,
  SandboxRunner,
} from "../types";
import type { ClaimPhase } from "../lifecycle-types";
import type { TenantConfig } from "../../../daemon/types";

const RUNNER_KIND = "host" as const;
const READY_TIMEOUT_MS = 30_000;
const READY_INTERVAL_MS = 250;
const STOP_GRACE_MS = 2_000;

type DaemonProcess = {
  pid: number;
  kill: (signal?: NodeJS.Signals | number) => boolean;
};
type SpawnFn = (args: {
  workdir: string;
  env: Record<string, string>;
  daemonPort: number;
}) => Promise<DaemonProcess>;
type HealthProbeFn = (daemonUrl: string) => Promise<DaemonHealth | null>;
type PostConfigFn = (
  daemonUrl: string,
  token: string,
  payload: Partial<TenantConfig>,
) => Promise<ConfigResponse>;
type KillFn = (pid: number, signal: NodeJS.Signals) => void;
type IsAliveFn = (pid: number) => boolean;

export interface HostRunnerOptions {
  /** Root data directory; usually `settings.home` (i.e. DATA_DIR). */
  homeDir: string;
  stateStore?: RunnerStateStore;
  /** Override preview URL pattern (matches DockerRunnerOptions semantics). */
  previewUrlPattern?: string;
  /** @internal test seam */
  _spawn?: SpawnFn;
  /** @internal test seam */
  _probe?: HealthProbeFn;
  /** @internal test seam */
  _postConfig?: PostConfigFn;
  /** @internal test seam */
  _kill?: KillFn;
  /** @internal test seam */
  _isAlive?: IsAliveFn;
}

interface HostRecord {
  id: SandboxId;
  handle: string;
  pid: number;
  daemonPort: number;
  daemonUrl: string;
  workdir: string;
  token: string;
  bootId: string;
}

interface PersistedHostState {
  pid: number;
  daemonPort: number;
  daemonUrl: string;
  workdir: string;
  token: string;
  bootId: string;
}

export class HostSandboxRunner implements SandboxRunner {
  readonly kind = RUNNER_KIND;

  private readonly records = new Map<string, HostRecord>();
  private readonly homeDir: string;
  private readonly stateStore: RunnerStateStore | null;
  private readonly previewUrlPattern: string | null;
  private readonly spawnFn: SpawnFn;
  private readonly probeFn: HealthProbeFn;
  private readonly postConfigFn: PostConfigFn;
  private readonly killFn: KillFn;
  private readonly isAliveFn: IsAliveFn;

  constructor(opts: HostRunnerOptions) {
    if (!opts.homeDir) {
      throw new Error("HostSandboxRunner requires a homeDir (DATA_DIR)");
    }
    this.homeDir = opts.homeDir;
    this.stateStore = opts.stateStore ?? null;
    this.previewUrlPattern = opts.previewUrlPattern ?? null;
    this.spawnFn = opts._spawn ?? createDefaultSpawn(this.homeDir);
    this.probeFn = opts._probe ?? probeDaemonHealth;
    this.postConfigFn = opts._postConfig ?? postConfig;
    this.killFn = opts._kill ?? ((pid, sig) => process.kill(pid, sig));
    this.isAliveFn = opts._isAlive ?? isPidAlive;
  }

  // ---- SandboxRunner surface ------------------------------------------------

  async ensure(id: SandboxId, opts: EnsureOptions = {}): Promise<Sandbox> {
    const handle = computeHandle(id, opts.repo?.branch);

    // 1. In-memory cache hit?
    const cached = this.records.get(handle);
    if (cached && this.isAliveFn(cached.pid)) return this.toSandbox(cached);

    // 2. State-store resume.
    if (this.stateStore) {
      const persisted = await this.stateStore.getByHandle(RUNNER_KIND, handle);
      if (persisted) {
        const rec = await this.rehydrate(persisted.id, persisted);
        if (rec) {
          this.records.set(handle, rec);
          return this.toSandbox(rec);
        }
        await this.stateStore
          .deleteByHandle(RUNNER_KIND, handle)
          .catch(() => undefined);
      }
    }

    // 3. Fresh provision.
    const workdir = this.workdirFor(handle);
    // Pre-create the workspace root so the daemon (and bash routes) have
    // a valid cwd before clone runs. The daemon clones into `<workdir>/app`,
    // not `<workdir>` itself, so a pre-created workspace dir doesn't trip
    // git's "destination already exists" check.
    await mkdir(workdir, { recursive: true });

    const token = randomBytes(24).toString("hex");
    const bootId = randomUUID();
    const daemonPort = await preallocatePort();
    const daemonUrl = `http://127.0.0.1:${daemonPort}`;
    const devPort = await preallocatePort();
    const ingressPort = await preallocatePort();

    const env = buildDaemonEnv({
      token,
      bootId,
      workdir,
      daemonPort,
      devPort,
      ingressPort,
      extraEnv: opts.env,
    });
    const configPayload = buildConfigPayload({
      runtime: opts.workload?.runtime ?? "bun",
      packageManager: opts.workload?.packageManager
        ? {
            name: opts.workload.packageManager,
            ...(opts.workload.packageManagerPath
              ? { path: opts.workload.packageManagerPath }
              : {}),
          }
        : null,
      repo: opts.repo ?? null,
      port: opts.workload?.devPort ?? devPort,
    });

    const proc = await this.spawnFn({ workdir, env, daemonPort });
    try {
      await this.waitForDaemon(daemonUrl);
      if (configPayload) {
        await this.postConfigFn(daemonUrl, token, configPayload);
      }
    } catch (err) {
      // Daemon never came up (or rejected the bootstrap) — kill it so we don't
      // leak the child process or pin daemonPort. The deterministic workdir is
      // left in place; a retry will reuse it.
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      throw err;
    }

    const rec: HostRecord = {
      id,
      handle,
      pid: proc.pid,
      daemonPort,
      daemonUrl,
      workdir,
      token,
      bootId,
    };
    this.records.set(handle, rec);

    if (this.stateStore) {
      const state = {
        pid: rec.pid,
        daemonPort: rec.daemonPort,
        daemonUrl: rec.daemonUrl,
        workdir: rec.workdir,
        token: rec.token,
        bootId: rec.bootId,
      } as PersistedHostState as unknown as Record<string, unknown>;
      await this.stateStore.put(id, RUNNER_KIND, { handle, state });
    }
    return this.toSandbox(rec);
  }

  /**
   * Match docker's `waitForDaemonReady` semantics: return as soon as `/health`
   * responds with a valid shape, even if `health.ready === false`. The prior
   * code waited for `ready === true`, which only flips after the daemon's
   * upstream probe finds the user's dev server listening — i.e. clone +
   * install + autoStartDev all complete. That gating blocked VM_START until
   * the dev server was up, kept the SSE proxy from connecting in the
   * meantime, and made the frontend look frozen for the entire setup window
   * before flushing a flood of replayed logs. Dev-server-ready is still
   * observable via the daemon's `status` SSE events.
   *
   * Inlined (vs. calling `waitForDaemonReady` directly) so `_probe` test
   * seam still drives the loop.
   */
  private async waitForDaemon(daemonUrl: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const health = await this.probeFn(daemonUrl);
      if (health) return;
      await new Promise((r) => setTimeout(r, READY_INTERVAL_MS));
    }
    throw new Error(`daemon at ${daemonUrl} never reported healthy`);
  }

  async exec(handle: string, input: ExecInput): Promise<ExecOutput> {
    const rec = await this.requireRecord(handle);
    return daemonBash(rec.daemonUrl, rec.token, input);
  }

  async delete(handle: string): Promise<void> {
    const rec = await this.getRecord(handle);
    this.records.delete(handle);

    if (rec) {
      if (this.isAliveFn(rec.pid)) {
        try {
          this.killFn(rec.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
        const deadline = Date.now() + STOP_GRACE_MS;
        while (Date.now() < deadline) {
          if (!this.isAliveFn(rec.pid)) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        if (this.isAliveFn(rec.pid)) {
          try {
            this.killFn(rec.pid, "SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }
      await rm(rec.workdir, { recursive: true, force: true }).catch((err) =>
        console.warn(
          `[HostSandboxRunner] rm workdir(${handle}) failed:`,
          err instanceof Error ? err.message : String(err),
        ),
      );
    }

    if (this.stateStore) {
      if (rec) await this.stateStore.delete(rec.id, RUNNER_KIND);
      else await this.stateStore.deleteByHandle(RUNNER_KIND, handle);
    }
  }

  async alive(handle: string): Promise<boolean> {
    // Use getRecord (which rehydrates from the state-store on cold mesh
    // boot) so the answer is honest regardless of in-memory cache state.
    // Without this, a fresh mesh process with a still-running daemon would
    // report alive=false and the SSE's stale-handle probe would emit a
    // spurious `gone` event before VM_START got a chance to rehydrate.
    const rec = await this.getRecord(handle);
    if (!rec) return false;
    return this.isAliveFn(rec.pid);
  }

  // No pre-Ready window worth surfacing: VM_START's `runner.ensure` blocks
  // until the daemon's HTTP server is up (typically <1s on host). Yield a
  // single `ready` and let the caller proceed straight to the daemon SSE.
  // Generator returns immediately even if `signal` aborts later — there's
  // nothing to clean up on the host side.
  async *watchClaimLifecycle(
    _handle: string,
    _signal?: AbortSignal,
  ): AsyncGenerator<ClaimPhase, void, unknown> {
    yield { kind: "ready" };
  }

  async getPreviewUrl(handle: string): Promise<string | null> {
    const rec = await this.getRecord(handle);
    return rec ? this.composePreviewUrl(rec) : null;
  }

  async proxyDaemonRequest(
    handle: string,
    path: string,
    init: ProxyRequestInit,
  ): Promise<Response> {
    const rec = await this.getRecord(handle);
    if (!rec) {
      return new Response(JSON.stringify({ error: "sandbox not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return proxyDaemonRequest(rec.daemonUrl, rec.token, path, init);
  }

  // ---- Public host-only surface ---------------------------------------------

  /** Used by the local ingress to map handle → daemon TCP port. */
  async resolveDaemonPort(handle: string): Promise<number | null> {
    const rec = await this.getRecord(handle);
    return rec?.daemonPort ?? null;
  }

  /**
   * Host-side absolute path of the per-branch clone. Used by stream-core to
   * set `cwd` on the Claude Code adapter so it edits the right files. Null
   * for unknown handles — caller falls back to `process.cwd()`.
   */
  async localWorkdir(handle: string): Promise<string | null> {
    const rec = await this.getRecord(handle);
    return rec?.workdir ?? null;
  }

  // ---- Internal helpers ------------------------------------------------------

  private workdirFor(handle: string): string {
    return join(this.homeDir, "sandboxes", handle);
  }

  private composePreviewUrl(rec: HostRecord): string {
    if (this.previewUrlPattern) {
      return applyPreviewPattern(this.previewUrlPattern, rec.handle);
    }
    const envRoot = process.env.SANDBOX_ROOT_URL;
    if (envRoot) return applyPreviewPattern(envRoot, rec.handle);
    const ingressPort = Number(process.env.SANDBOX_INGRESS_PORT ?? 7070);
    return `http://${rec.handle}.localhost:${ingressPort}/`;
  }

  private toSandbox(rec: HostRecord): Sandbox {
    return {
      handle: rec.handle,
      workdir: rec.workdir,
      previewUrl: this.composePreviewUrl(rec),
    };
  }

  private async getRecord(handle: string): Promise<HostRecord | null> {
    const cached = this.records.get(handle);
    if (cached) return cached;
    if (!this.stateStore) return null;
    const persisted = await this.stateStore.getByHandle(RUNNER_KIND, handle);
    if (!persisted) return null;
    const rec = await this.rehydrate(persisted.id, persisted);
    if (rec) this.records.set(handle, rec);
    return rec;
  }

  private async requireRecord(handle: string): Promise<HostRecord> {
    const rec = await this.getRecord(handle);
    if (!rec) throw new Error(`unknown sandbox handle ${handle}`);
    return rec;
  }

  private async rehydrate(
    id: SandboxId,
    persisted: { handle: string; state: Record<string, unknown> },
  ): Promise<HostRecord | null> {
    const state = persisted.state as Partial<PersistedHostState>;
    if (
      typeof state.pid !== "number" ||
      typeof state.daemonPort !== "number" ||
      typeof state.daemonUrl !== "string" ||
      typeof state.workdir !== "string" ||
      typeof state.token !== "string" ||
      typeof state.bootId !== "string"
    ) {
      return null;
    }
    if (!this.isAliveFn(state.pid)) return null;
    const health = await this.probeFn(state.daemonUrl);
    if (!health) return null;
    return {
      id,
      handle: persisted.handle,
      pid: state.pid,
      daemonPort: state.daemonPort,
      daemonUrl: state.daemonUrl,
      workdir: state.workdir,
      token: state.token,
      bootId: health.bootId,
    };
  }
}

// ---- Module-private helpers (used from later tasks) --------------------------

function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pre-allocate a host-side TCP port. The daemon binds to it on startup.
 * Race window is non-zero — the kernel may hand the port to another process
 * between close() and the daemon's bind() — in which case the daemon fails
 * to come up, `waitForDaemon` times out, and `ensure()` rejects. There is
 * no automatic retry; the caller (e.g. VM_START) surfaces the error. In
 * practice this never fires on a developer machine.
 */
function preallocatePort(): Promise<number> {
  return new Promise((resolve_, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve_(port));
      } else {
        srv.close(() => reject(new Error("could not allocate port")));
      }
    });
  });
}

function buildDaemonEnv(args: {
  token: string;
  bootId: string;
  workdir: string;
  daemonPort: number;
  devPort: number;
  ingressPort: number;
  extraEnv: Record<string, string> | undefined;
}): Record<string, string> {
  return {
    DAEMON_TOKEN: args.token,
    DAEMON_BOOT_ID: args.bootId,
    APP_ROOT: args.workdir,
    PROXY_PORT: String(args.daemonPort),
    // Inherited by every child the daemon spawns. extraEnv is spread last
    // so the caller can override (rare — passing PORT/SANDBOX_INGRESS_PORT/
    // VITE_PORT through opts.env defeats the collision-avoidance, but the
    // escape hatch stays).
    PORT: String(args.devPort),
    SANDBOX_INGRESS_PORT: String(args.ingressPort),
    ...(args.extraEnv ?? {}),
  };
}

// ---- Daemon executable resolution ------------------------------------------
//
// In dev (source tree present), spawn `bun run <daemon/entry.ts>` so the
// daemon code reloads on file change without a build step.
//
// In production (`bunx decocms@latest`), `runner.ts` has been inlined into
// `dist/server/server.js`, so the source TS path resolves to the
// nonexistent `<bunx-cache>/node_modules/daemon/entry.ts`. Materialize the
// embedded bundle (loaded lazily from `daemon-asset.ts`) into
// `${homeDir}/.deco/cache/sandbox-daemon-<hash>.js` and spawn that.
//
// `node-pty` is a runtime dep of the daemon. Its install location lives
// inside the parent's `node_modules` tree, but the materialized bundle
// sits in DATA_DIR — bun won't find `node-pty` by walking up from there.
// Resolve the parent's node_modules dir at the call site and pass it via
// `NODE_PATH` so the spawned daemon can `import "node-pty"`.

function resolveSourceDaemonPath(): string {
  return resolve(
    fileURLToPath(new URL("../../../daemon/entry.ts", import.meta.url)),
  );
}

function resolveNodePtyNodeModulesDir(): string {
  // node-pty is a peer of the parent process (decocms ships it as a direct
  // dep; in dev it lives in packages/sandbox/node_modules). We resolve from
  // this module's location and walk back to the enclosing node_modules
  // root.
  const ptyEntry = Bun.resolveSync("node-pty", import.meta.dir);
  const marker = "/node_modules/";
  const idx = ptyEntry.lastIndexOf(marker);
  if (idx < 0) {
    throw new Error(
      `[HostSandboxRunner] could not derive node_modules path from node-pty resolution: ${ptyEntry}`,
    );
  }
  return ptyEntry.slice(0, idx + marker.length - 1);
}

async function materializeDaemonBundle(homeDir: string): Promise<string> {
  // Lazy-imported so tests using the `_spawn` test seam don't trigger the
  // text-import resolution (which would require `daemon/dist/daemon.js` to
  // exist on disk before the bundle has been built).
  const { DAEMON_BUNDLE } = await import("./daemon-asset");
  const hash = createHash("sha256")
    .update(DAEMON_BUNDLE)
    .digest("hex")
    .slice(0, 16);
  const cacheDir = join(homeDir, ".deco", "cache");
  const cachePath = join(cacheDir, `sandbox-daemon-${hash}.js`);
  if (existsSync(cachePath)) return cachePath;
  await mkdir(cacheDir, { recursive: true });
  // Write atomically — concurrent spawns racing to materialize the same
  // hashed file are tolerated because `rename` is atomic on POSIX.
  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  await writeFile(tmpPath, DAEMON_BUNDLE);
  await rename(tmpPath, cachePath);
  return cachePath;
}

async function resolveDaemonExec(homeDir: string): Promise<string> {
  const sourceTs = resolveSourceDaemonPath();
  if (existsSync(sourceTs)) return sourceTs;
  return materializeDaemonBundle(homeDir);
}

function createDefaultSpawn(homeDir: string): SpawnFn {
  return async (args) => {
    const daemonExec = await resolveDaemonExec(homeDir);
    const ptyNodeModulesDir = resolveNodePtyNodeModulesDir();
    const existingNodePath = process.env.NODE_PATH;
    const nodePath = existingNodePath
      ? `${ptyNodeModulesDir}:${existingNodePath}`
      : ptyNodeModulesDir;
    const proc = Bun.spawn({
      cmd: ["bun", "run", daemonExec],
      // cwd is intentionally inherited from the parent — daemon resolves
      // its own paths relative to the entry file.
      env: {
        ...process.env,
        NODE_PATH: nodePath,
        ...args.env,
      },
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
    });
    return {
      pid: proc.pid,
      kill: (sig) => {
        proc.kill(sig as NodeJS.Signals | number | undefined);
        return true;
      },
    };
  };
}
