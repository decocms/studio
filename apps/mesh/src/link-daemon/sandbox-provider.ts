/**
 * LaptopSandboxProvider — owns per-handle sandbox daemons on the user's
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

import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { TunnelHandle } from "./tunnel";

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

export interface EnsureSandboxInput {
  handle: string;
  repo?: RepoRef;
}

export interface SandboxState {
  handle: string;
  port: number;
  process: SpawnResult;
  /** Warp tunnel handle, or null in --no-tunnel mode. */
  tunnel: TunnelHandle | null;
  /** Public URL the cluster + browser use to reach this daemon.
   *  - prod: `https://<handle>.deco.host` (the tunnel above)
   *  - dev (--no-tunnel): `http://127.0.0.1:<port>` */
  sandboxUrl: string;
  lastUsedAt: number;
  activeDispatchCount: number;
}

export interface LaptopSandboxProvider {
  ensureSandbox(
    input: EnsureSandboxInput,
  ): Promise<{ sandboxUrl: string; port: number }>;
  proxyPort(handle: string): number | null;
  recordHit(handle: string): void;
  acquireDispatch(handle: string): () => void;
  listSandboxes(): SandboxState[];
  deleteSandbox(handle: string): Promise<void>;
  shutdown(): Promise<void>;
}

export interface OpenTunnelDeps {
  /** Public hostname (subdomain) for the daemon's tunnel.
   *  e.g. `mellow-slate-bb5b7.deco.host` */
  subDomain: string;
  /** Local target the tunnel forwards to. e.g. `http://127.0.0.1:63266` */
  localAddr: string;
}

export interface LaptopSandboxProviderDeps {
  dataDir: string;
  spawnDaemon: (args: {
    workdir: string;
    handle: string;
    port: number;
  }) => SpawnResult | Promise<SpawnResult>;
  postConfig: (
    port: number,
    devPort: number,
    config: { repo?: RepoRef },
  ) => Promise<void>;
  waitForHealth: (port: number) => Promise<void>;
  /**
   * Open a warp tunnel for a daemon. Called per-spawn; the returned
   * TunnelHandle's `publicUrl` is what the cluster + browser see.
   * Return `null` to skip tunnel opening (e.g. --no-tunnel dev mode);
   * the provider will fall back to `http://127.0.0.1:<port>` as the URL.
   */
  openDaemonTunnel: (input: OpenTunnelDeps) => Promise<TunnelHandle | null>;
  /** Override port allocation (tests provide a deterministic value). */
  pickPort?: () => Promise<number> | number;
  maxSandboxes?: number;
}

export function createLaptopSandboxProvider(
  deps: LaptopSandboxProviderDeps,
): LaptopSandboxProvider {
  const cap = deps.maxSandboxes ?? 20;
  const sandboxes = new Map<string, SandboxState>();
  const pickPort = deps.pickPort ?? allocateEphemeralPort;

  // In-flight ensureSandbox promises, keyed by handle. The cluster
  // creates a fresh `RemoteUserSandboxProvider` for every request
  // (its `records` map is per-instance), so several concurrent
  // VM_START / preview / proxyDaemonRequest paths can race here
  // before any of them gets a chance to populate `sandboxes`. Without
  // dedup, each would spawn its own daemon + clone + install. Memoizing
  // the promise collapses concurrent callers onto the first one's work.
  // Cleared on settle so a fresh ensure can take a clean swing.
  const inflight = new Map<
    string,
    Promise<{ sandboxUrl: string; port: number }>
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
    try {
      victim.tunnel?.close();
    } catch {
      // warp-node Connected has no real close yet; ignore
    }
    sandboxes.delete(victim.handle);
  }

  const buildEntry = async (
    input: EnsureSandboxInput,
  ): Promise<{ sandboxUrl: string; port: number }> => {
    evictIfNeeded();
    const workdir = join(
      deps.dataDir,
      ".deco",
      "link",
      "sandboxes",
      input.handle,
    );
    await mkdir(workdir, { recursive: true });
    // Two ephemeral ports per sandbox: one for the daemon's HTTP/proxy
    // (port) and one for the dev script the orchestrator will spawn
    // (devPort). Without a dedicated devPort, every framework's
    // default 3000 collides with the cluster (and with other sandboxes).
    const [port, devPort] = await Promise.all([pickPort(), pickPort()]);
    const spawned = await Promise.resolve(
      deps.spawnDaemon({ workdir, handle: input.handle, port }),
    );
    let tunnel: TunnelHandle | null = null;
    try {
      await deps.waitForHealth(port);
      await deps.postConfig(port, devPort, { repo: input.repo });
      tunnel = await deps.openDaemonTunnel({
        subDomain: `${input.handle}.deco.host`,
        localAddr: `http://127.0.0.1:${port}`,
      });
    } catch (err) {
      try {
        spawned.kill("SIGKILL");
      } catch {
        // already gone
      }
      try {
        tunnel?.close();
      } catch {
        // no-op
      }
      throw err;
    }
    const sandboxUrl = tunnel?.publicUrl ?? `http://127.0.0.1:${port}`;
    const state: SandboxState = {
      handle: input.handle,
      port,
      process: spawned,
      tunnel,
      sandboxUrl,
      lastUsedAt: Date.now(),
      activeDispatchCount: 0,
    };
    sandboxes.set(input.handle, state);

    // Watchdog: clear the map entry if the daemon process exits unexpectedly.
    // Without this the cache returns a stale dead port and the cluster's
    // alive() probe loops forever against a tunnel pointing at a dead upstream.
    if (spawned.exited) {
      spawned.exited.then(() => {
        const current = sandboxes.get(input.handle);
        if (current === state) {
          sandboxes.delete(input.handle);
          try {
            tunnel?.close();
          } catch {
            // no-op
          }
        }
      });
    }

    return { sandboxUrl, port };
  };

  return {
    async ensureSandbox(input) {
      const existing = sandboxes.get(input.handle);
      if (existing) {
        existing.lastUsedAt = Date.now();
        return { sandboxUrl: existing.sandboxUrl, port: existing.port };
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
    recordHit(handle) {
      const s = sandboxes.get(handle);
      if (s) s.lastUsedAt = Date.now();
    },
    acquireDispatch(handle) {
      const s = sandboxes.get(handle);
      if (!s) return () => {};
      s.activeDispatchCount += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const cur = sandboxes.get(handle);
        if (cur)
          cur.activeDispatchCount = Math.max(0, cur.activeDispatchCount - 1);
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
      try {
        s.tunnel?.close();
      } catch {
        // no-op
      }
      sandboxes.delete(handle);
    },
    async shutdown() {
      for (const s of sandboxes.values()) {
        try {
          s.process.kill("SIGTERM");
        } catch {
          // already gone
        }
        try {
          s.tunnel?.close();
        } catch {
          // no-op
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
