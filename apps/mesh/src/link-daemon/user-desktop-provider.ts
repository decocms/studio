/**
 * DesktopSandboxProvider — owns per-handle sandbox daemons on the user's
 * machine. Each `ensureSandbox` call either returns an existing
 * (handle, port) pair or spawns a fresh daemon process, posts the
 * initial tenant config, waits for `/health`, and tracks it for LRU
 * eviction.
 *
 * Idle sandboxes are evicted when the population exceeds `maxSandboxes`
 * (default 20). Sandboxes with active dispatches are pinned — eviction
 * skips them and we tolerate going temporarily over the cap. The
 * cluster's `remoteDispatch` calls `provider.recordHit` indirectly via
 * the reverse-proxy hits, keeping warm sandboxes warm.
 *
 * The actual process spawn / config-post / health-probe are passed in
 * as deps so the production wiring (apps/mesh/src/link-daemon/index.ts)
 * can plug in `Bun.spawn` against the daemon bundle and the tests can
 * stay lightweight.
 */

import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

// Not exported — only referenced via SandboxEvent.phase below.
type SandboxPhase = "spawning" | "ready" | "failed" | "evicted" | "deleted";

/**
 * Observability event emitted on every sandbox lifecycle transition.
 * Purely additive — consumers (the link TUI store) subscribe via the
 * provider's `onEvent` dep. Never alters control flow.
 */
export interface SandboxEvent {
  handle: string;
  phase: SandboxPhase;
  port?: number;
  previewUrl?: string;
  /** Set on `failed`. */
  error?: string;
  activeDispatchCount?: number;
}

export interface SpawnResult {
  port: number;
  kill: (signal?: NodeJS.Signals) => void;
  /** Resolves when the daemon process exits (cleanly or otherwise). Optional
   *  for backwards-compat with test fakes; production spawn always sets it. */
  exited?: Promise<void>;
}

export interface RepoRef {
  cloneUrl: string;
  branch?: string;
  /** Git author identity for commits inside the sandbox. The cluster sources
   *  these from the linked GitHub user; the daemon uses them when running
   *  `git commit`. Optional — clone works without them. */
  userName?: string;
  userEmail?: string;
}

/**
 * Caller-selected runtime + package manager. Mirrors `Workload` from
 * `@decocms/sandbox/provider`. Threaded through to the spawned sandbox
 * daemon's `application` config so the orchestrator runs `bun install`
 * (or pnpm/npm/yarn/deno) instead of falling through to autodetect — the
 * desktop daemon process can't shim arbitrary corepack package managers
 * into PATH the way the container image can, so explicit selection is
 * the only reliable path on user-desktop.
 */
export interface Workload {
  runtime: "node" | "bun" | "deno";
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "deno";
  /** User-pinned dev port; ignored on desktop (the provider allocates its
   *  own ephemeral port to avoid host-network collisions). */
  devPort?: number;
  /** Subdirectory inside the repo where the package manifest lives. */
  packageManagerPath?: string;
}

export interface EnsureSandboxInput {
  handle: string;
  repo?: RepoRef;
  workload?: Workload;
}

export interface SandboxState {
  handle: string;
  port: number;
  process: SpawnResult;
  /** Local URL for the spawned sandbox daemon. Always `http://127.0.0.1:<port>`. */
  sandboxApiUrl: string;
  /**
   * Public-facing URL the user's browser hits. Routed by the local ingress
   * (`<handle>.localhost:<ingressPort>`) which the daemon spins up alongside
   * the sandbox. Distinct from `sandboxApiUrl` so internal probes can skip
   * the ingress hop.
   */
  previewUrl: string;
  lastUsedAt: number;
  activeDispatchCount: number;
  /** Bearer token generated at spawn time; used to authenticate proxied requests. */
  daemonToken: string;
}

export interface DesktopSandboxProvider {
  ensureSandbox(
    input: EnsureSandboxInput,
  ): Promise<{ sandboxApiUrl: string; previewUrl: string; port: number }>;
  proxyPort(handle: string): number | null;
  /** Returns the bearer token for the spawned sandbox daemon, or null if unknown. */
  getDaemonToken(handle: string): string | null;
  /**
   * True if the daemon either has a ready entry for `handle` or is currently
   * spawning one. Used by the cluster's `alive()` probe so that vm-events
   * doesn't emit `gone` during the (potentially multi-second) spawn window
   * and tear down the sandbox the user is in the middle of starting.
   */
  hasHandle(handle: string): boolean;
  recordHit(handle: string): void;
  acquireDispatch(handle: string): () => void;
  listSandboxes(): SandboxState[];
  deleteSandbox(handle: string): Promise<void>;
  shutdown(): Promise<void>;
}

export interface DesktopSandboxProviderDeps {
  dataDir: string;
  spawnDaemon: (args: {
    workdir: string;
    handle: string;
    port: number;
    daemonToken: string;
  }) => SpawnResult | Promise<SpawnResult>;
  postConfig: (
    port: number,
    devPort: number,
    config: { repo?: RepoRef; workload?: Workload },
    daemonToken: string,
  ) => Promise<void>;
  waitForHealth: (port: number) => Promise<void>;
  /**
   * Returns the public-facing URL for `handle` — usually
   * `http://<handle>.localhost:<ingressPort>` where `ingressPort` is the
   * port the local ingress is listening on. Lazy so the provider can be
   * constructed before the ingress finishes binding (the ingress's
   * `lookupSandboxPort` calls back into the provider, so the two have a
   * circular initialization). The default keeps the legacy
   * `http://127.0.0.1:<port>` for compatibility with tests that don't
   * stand up an ingress.
   */
  resolvePreviewUrl?: (handle: string, port: number) => string;
  /** Override port allocation (tests provide a deterministic value). */
  pickPort?: () => Promise<number> | number;
  maxSandboxes?: number;
  /**
   * Used for the cache-hit liveness probe. Default `fetch`; tests inject
   * a mock so the probe doesn't hit a non-existent local port.
   */
  fetchImpl?: typeof fetch;
  /** Optional observability hook for lifecycle transitions (link TUI). */
  onEvent?: (event: SandboxEvent) => void;
}

export function createDesktopSandboxProvider(
  deps: DesktopSandboxProviderDeps,
): DesktopSandboxProvider {
  const cap = deps.maxSandboxes ?? 20;
  const sandboxes = new Map<string, SandboxState>();
  const pickPort = deps.pickPort ?? allocateEphemeralPort;
  const fetcher = deps.fetchImpl ?? fetch;
  const resolvePreviewUrl =
    deps.resolvePreviewUrl ?? ((_handle, port) => `http://127.0.0.1:${port}`);

  const emit = (event: SandboxEvent): void => deps.onEvent?.(event);

  /**
   * Short-timeout GET to `<sandboxUrl>/health`. The cache-hit fast path
   * trusts this entry only if the underlying spawned daemon is still
   * reachable — the `spawned.exited` watchdog catches clean process
   * deaths, but unclean ones (OOM kill, host sleep/wake quirks, tunnel
   * disconnect) leave the cache lying about a corpse. Without this
   * probe the cluster's `POST /api/sandboxes` retries replay the dead
   * URL and the auto-restart loop never converges.
   */
  const probeAlive = async (sandboxUrl: string): Promise<boolean> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1500);
    try {
      const res = await fetcher(`${sandboxUrl}/health`, { signal: ac.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const evictDead = (state: SandboxState): void => {
    try {
      state.process.kill("SIGTERM");
    } catch {
      // already gone
    }
    // Compare-and-swap: under concurrent `ensureSandbox` calls, a second
    // caller's `existing` closure can outlive the first caller's respawn.
    // Without this check the second caller would delete the freshly
    // registered replacement and leave the new daemon process orphaned.
    if (sandboxes.get(state.handle) === state) {
      sandboxes.delete(state.handle);
      emit({ handle: state.handle, phase: "evicted" });
    }
  };

  // In-flight ensureSandbox promises, keyed by handle. The cluster
  // creates a fresh `DesktopSandboxProvider` for every request
  // (its `records` map is per-instance), so several concurrent
  // SANDBOX_START / preview / proxyDaemonRequest paths can race here
  // before any of them gets a chance to populate `sandboxes`. Without
  // dedup, each would spawn its own daemon + clone + install. Memoizing
  // the promise collapses concurrent callers onto the first one's work.
  // Cleared on settle so a fresh ensure can take a clean swing.
  const inflight = new Map<
    string,
    Promise<{ sandboxApiUrl: string; previewUrl: string; port: number }>
  >();

  function evictIfNeeded(): void {
    if (sandboxes.size < cap) return;
    const candidates = [...sandboxes.values()]
      .filter((s) => s.activeDispatchCount === 0)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    if (candidates.length === 0) return; // every sandbox is pinned
    const victim = candidates[0]!;
    try {
      victim.process.kill("SIGTERM");
    } catch {
      // already gone
    }
    sandboxes.delete(victim.handle);
    emit({ handle: victim.handle, phase: "evicted" });
  }

  const buildEntry = async (
    input: EnsureSandboxInput,
  ): Promise<{ sandboxApiUrl: string; previewUrl: string; port: number }> => {
    emit({ handle: input.handle, phase: "spawning" });
    evictIfNeeded();
    const workdir = join(deps.dataDir, "sandboxes", input.handle);
    await mkdir(workdir, { recursive: true });
    console.log(
      `[user-desktop] ensure handle=${input.handle} repo=${input.repo?.cloneUrl ?? "(none)"} branch=${input.repo?.branch ?? "(none)"} runtime=${input.workload?.runtime ?? "(autodetect)"} pm=${input.workload?.packageManager ?? "(autodetect)"}`,
    );
    // Two ephemeral ports per sandbox: one for the daemon's HTTP/proxy
    // (port) and one for the dev script the orchestrator will spawn
    // (devPort). Without a dedicated devPort, every framework's
    // default 3000 collides with the cluster (and with other sandboxes).
    const daemonToken = randomBytes(24).toString("hex");
    const [port, devPort] = await Promise.all([pickPort(), pickPort()]);
    console.log(
      `[user-desktop] spawn handle=${input.handle} port=${port} devPort=${devPort} workdir=${workdir}`,
    );
    const spawned = await Promise.resolve(
      deps.spawnDaemon({ workdir, handle: input.handle, port, daemonToken }),
    );
    try {
      await deps.waitForHealth(port);
      console.log(
        `[user-desktop] healthy handle=${input.handle} port=${port} — posting config`,
      );
      await deps.postConfig(
        port,
        devPort,
        { repo: input.repo, workload: input.workload },
        daemonToken,
      );
    } catch (err) {
      console.error(
        `[user-desktop] sandbox bring-up failed handle=${input.handle} port=${port} (killing daemon):`,
        err,
      );
      try {
        spawned.kill("SIGKILL");
      } catch {
        // already gone
      }
      emit({
        handle: input.handle,
        phase: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    const sandboxApiUrl = `http://127.0.0.1:${port}`;
    const previewUrl = resolvePreviewUrl(input.handle, port);
    console.log(
      `[user-desktop] ready handle=${input.handle} port=${port} sandboxApiUrl=${sandboxApiUrl} previewUrl=${previewUrl}`,
    );
    const state: SandboxState = {
      handle: input.handle,
      port,
      process: spawned,
      sandboxApiUrl,
      previewUrl,
      lastUsedAt: Date.now(),
      activeDispatchCount: 0,
      daemonToken,
    };
    sandboxes.set(input.handle, state);
    emit({
      handle: input.handle,
      phase: "ready",
      port,
      previewUrl,
      activeDispatchCount: 0,
    });

    // Watchdog: clear the map entry if the daemon process exits unexpectedly.
    // Without this the cache returns a stale dead port and the cluster's
    // alive() probe loops forever against a dead upstream.
    if (spawned.exited) {
      spawned.exited.then(() => {
        const current = sandboxes.get(input.handle);
        if (current === state) {
          sandboxes.delete(input.handle);
          emit({ handle: input.handle, phase: "evicted" });
        }
      });
    }

    return { sandboxApiUrl, previewUrl, port };
  };

  return {
    async ensureSandbox(input) {
      const existing = sandboxes.get(input.handle);
      if (existing) {
        if (await probeAlive(existing.sandboxApiUrl)) {
          existing.lastUsedAt = Date.now();
          return {
            sandboxApiUrl: existing.sandboxApiUrl,
            previewUrl: existing.previewUrl,
            port: existing.port,
          };
        }
        // Cached entry is dead — tear it down before respawning so the new
        // entry's spawn isn't fighting the corpse for the same workdir.
        evictDead(existing);
      }
      const pending = inflight.get(input.handle);
      if (pending) return pending;
      const promise = buildEntry(input).finally(() => {
        inflight.delete(input.handle);
      });
      inflight.set(input.handle, promise);
      return promise;
    },
    proxyPort(handle) {
      const s = sandboxes.get(handle);
      if (s) s.lastUsedAt = Date.now();
      return s?.port ?? null;
    },
    getDaemonToken(handle) {
      return sandboxes.get(handle)?.daemonToken ?? null;
    },
    hasHandle(handle) {
      return sandboxes.has(handle) || inflight.has(handle);
    },
    recordHit(handle) {
      const s = sandboxes.get(handle);
      if (s) s.lastUsedAt = Date.now();
    },
    acquireDispatch(handle) {
      const s = sandboxes.get(handle);
      if (!s) return () => {};
      s.activeDispatchCount += 1;
      emit({
        handle,
        phase: "ready",
        activeDispatchCount: s.activeDispatchCount,
      });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const cur = sandboxes.get(handle);
        if (cur) {
          cur.activeDispatchCount = Math.max(0, cur.activeDispatchCount - 1);
          emit({
            handle,
            phase: "ready",
            activeDispatchCount: cur.activeDispatchCount,
          });
        }
      };
    },
    listSandboxes() {
      return [...sandboxes.values()];
    },
    async deleteSandbox(handle) {
      const s = sandboxes.get(handle);
      if (!s) return;
      try {
        s.process.kill("SIGTERM");
      } catch {
        // already gone
      }
      sandboxes.delete(handle);
      emit({ handle, phase: "deleted" });
    },
    async shutdown() {
      for (const s of sandboxes.values()) {
        try {
          s.process.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
      sandboxes.clear();
    },
  };
}

/**
 * Bind to a kernel-chosen ephemeral port and return it after closing.
 * Race window between close() and the daemon's bind() is non-zero — in
 * practice the daemon's bind happens within milliseconds and we accept
 * the rare conflict (the caller surfaces the spawn failure).
 */
function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not allocate port")));
      }
    });
  });
}
