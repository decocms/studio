/**
 * DesktopSandboxProvider — owns per-handle sandbox daemons on the user's
 * machine. Each `ensureSandbox` call either returns an existing
 * (handle, port) pair or spawns a fresh daemon process, posts the
 * initial tenant config, waits for `/health`, and tracks it for LRU
 * eviction.
 *
 * Idle sandboxes are evicted when the population exceeds `maxSandboxes`
 * (default 20). Sandboxes with active dispatches are pinned — both LRU
 * eviction AND explicit `deleteSandbox` skip them (a reap mid-run would
 * close the SSE pump and fail the dispatch), and we tolerate going
 * temporarily over the cap. The daemon's proxy hits call
 * `provider.recordHit`, keeping warm sandboxes warm.
 *
 * The actual process spawn / config-post / health-probe are passed in
 * as deps so the production wiring (apps/api/src/link-daemon/index.ts)
 * can plug in `Bun.spawn` against the daemon bundle and the tests can
 * stay lightweight.
 */

import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { LinkSandboxRegistry } from "../cli/link-sandbox-registry";

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
  /**
   * Registry metadata carried on create-path events so the TUI can render the
   * correct PROJECT/BRANCH columns before the next `setPersistedSandboxes`
   * hydration. Without these, a freshly created live row has no prior state to
   * inherit from and falls back to the handle (which embeds the branch),
   * showing the branch in the PROJECT column until the CLI restarts.
   */
  projectName?: string | null;
  branch?: string | null;
  sandboxPath?: string | null;
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
  /** Resolved per-host PATs for fetching private submodules. Forwarded to the
   *  spawned daemon so `git submodule update` can authenticate. Optional. */
  submoduleCredentials?: { host: string; token: string }[];
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
  /**
   * Live production URL of the linked site. Forwarded to the daemon so the
   * `/_deco/fast-preview` route can render the working-tree decofile against
   * production without the dev server.
   */
  productionUrl?: string;
}

export interface EnsureSandboxInput {
  handle: string;
  repo?: RepoRef;
  workload?: Workload;
  /** Studio user operating the sandbox — co-authored on git commits. */
  operator?: {
    userName: string;
    userEmail?: string;
  };
  /**
   * Message-offload SSRF allowlist, pushed by the cluster from its OWN trusted
   * S3 config (never a request frame). Threaded into the spawned daemon's boot
   * env (`OFFLOAD_ALLOWED_HOSTS`) so it can re-inflate offloaded `messagesRef`
   * payloads — but only from these hosts. Absent/empty = the daemon fails
   * closed (every offload fetch rejected).
   */
  offloadAllowedHosts?: string[];
  /** Permit http:// loopback offload refs (dev MinIO over localhost). Maps to
   *  the daemon's `OFFLOAD_ALLOW_SAME_HOST_DEV=1`. */
  offloadAllowSameHostDev?: boolean;
  /** org-fs mount config (JSON OrgFsMountConfig) → daemon `ORGFS_CONFIG` boot
   *  env so it mounts the configured volumes kext-free. Absent → no mounting. */
  orgFsConfigJson?: string;
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

type SandboxRegistryMetadata = Pick<
  Parameters<LinkSandboxRegistry["upsert"]>[0],
  "repoCloneUrl" | "branch" | "projectName"
>;

type TrackedSandboxState = SandboxState & {
  registryMetadata: SandboxRegistryMetadata;
};

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
  registry?: LinkSandboxRegistry;
  spawnDaemon: (args: {
    workdir: string;
    handle: string;
    port: number;
    daemonToken: string;
    /** Message-offload SSRF allowlist for the daemon's boot env. Empty = the
     *  daemon fails closed. Sourced from the cluster's trusted ensure body. */
    offloadAllowedHosts: string[];
    /** Maps to the daemon's `OFFLOAD_ALLOW_SAME_HOST_DEV=1`. */
    offloadAllowSameHostDev: boolean;
    /** org-fs mount config (JSON) → daemon `ORGFS_CONFIG`. undefined = no mount. */
    orgFsConfigJson?: string;
  }) => SpawnResult | Promise<SpawnResult>;
  postConfig: (
    port: number,
    devPort: number,
    config: {
      repo?: RepoRef;
      workload?: Workload;
      operator?: EnsureSandboxInput["operator"];
    },
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

/**
 * Wrap a low-level bring-up step error in a user-facing message carrying the
 * stable `sandbox failed to start:` marker. The chat web layer keys on this
 * marker (`parseErrorMessage` in the highlight component) to show the real
 * reason instead of the generic "took longer than expected". The original
 * error is preserved as `cause` for the daemon log + the `failed` event.
 */
function markBringUpFailure(reason: string, cause: unknown): Error {
  return new Error(`sandbox failed to start: ${reason}`, { cause });
}

/**
 * True for runtime timeout aborts — notably the `AbortSignal.timeout()`
 * `DOMException` ("The operation timed out.") that fires when the spawned
 * daemon doesn't answer `POST /_sandbox/config` within `CONFIG_TIMEOUT_MS`.
 */
function isTimeoutLike(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "TimeoutError" ||
    /timed out|timeout|operation was aborted|aborted/i.test(err.message)
  );
}

/** The original (pre-marker) cause message, for operator-facing logs/events. */
function bringUpCauseMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return err.message;
  }
  return String(err);
}

function projectNameFromCloneUrl(cloneUrl: string | undefined): string | null {
  if (!cloneUrl) return null;
  const trimmed = cloneUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  const segment = trimmed.split(/[/:]/).filter(Boolean).at(-1);
  if (!segment) return null;
  return segment.replace(/\.git$/i, "") || null;
}

function registryMetadataFromInput(
  input: EnsureSandboxInput,
): SandboxRegistryMetadata {
  return {
    repoCloneUrl: input.repo?.cloneUrl ?? null,
    branch: input.repo?.branch ?? null,
    projectName: projectNameFromCloneUrl(input.repo?.cloneUrl),
  };
}

export function createDesktopSandboxProvider(
  deps: DesktopSandboxProviderDeps,
): DesktopSandboxProvider {
  const cap = deps.maxSandboxes ?? 20;
  const sandboxes = new Map<string, TrackedSandboxState>();
  const pickPort = deps.pickPort ?? allocateEphemeralPort;
  const fetcher = deps.fetchImpl ?? fetch;
  const resolvePreviewUrl =
    deps.resolvePreviewUrl ?? ((_handle, port) => `http://127.0.0.1:${port}`);
  const sandboxPath = (handle: string): string =>
    join(deps.dataDir, "sandboxes", handle);
  const persist = (row: Parameters<LinkSandboxRegistry["upsert"]>[0]): void => {
    try {
      deps.registry?.upsert(row);
    } catch (err) {
      console.warn(
        `[user-desktop] failed to persist sandbox lifecycle handle=${row.handle} status=${row.status}:`,
        err,
      );
    }
  };

  // Observability must never break provider control flow: a throwing
  // onEvent consumer is swallowed (the JSDoc on SandboxEvent guarantees this).
  const emit = (event: SandboxEvent): void => {
    try {
      deps.onEvent?.(event);
    } catch {
      // ignore consumer errors
    }
  };

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
      if (!res.ok) {
        console.warn(
          `[user-desktop] probe ${sandboxUrl}/health → ${res.status} (treating as dead)`,
        );
      }
      return res.ok;
    } catch (err) {
      console.warn(
        `[user-desktop] probe ${sandboxUrl}/health failed: ${
          err instanceof Error ? err.message : String(err)
        } (treating as dead)`,
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const evictDead = (state: TrackedSandboxState): void => {
    console.warn(
      `[user-desktop] evicting dead daemon handle=${state.handle} port=${state.port}`,
    );
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
      persist({
        handle: state.handle,
        status: "stopped",
        sandboxPath: sandboxPath(state.handle),
        port: null,
        previewUrl: null,
        ...state.registryMetadata,
        error: null,
      });
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
    if (candidates.length === 0) {
      console.warn(
        `[user-desktop] at cap ${sandboxes.size}/${cap} but every sandbox is pinned (active dispatch) — exceeding cap temporarily`,
      );
      return; // every sandbox is pinned
    }
    const victim = candidates[0]!;
    console.log(
      `[user-desktop] evicting LRU victim handle=${victim.handle} port=${victim.port} (cap ${cap} reached, size=${sandboxes.size})`,
    );
    try {
      victim.process.kill("SIGTERM");
    } catch {
      // already gone
    }
    sandboxes.delete(victim.handle);
    persist({
      handle: victim.handle,
      status: "stopped",
      sandboxPath: sandboxPath(victim.handle),
      port: null,
      previewUrl: null,
      ...victim.registryMetadata,
      error: null,
    });
    emit({ handle: victim.handle, phase: "evicted" });
  }

  const buildEntry = async (
    input: EnsureSandboxInput,
  ): Promise<{ sandboxApiUrl: string; previewUrl: string; port: number }> => {
    const metadata = registryMetadataFromInput(input);
    const workdir = sandboxPath(input.handle);
    persist({
      handle: input.handle,
      status: "spawning",
      sandboxPath: workdir,
      port: null,
      previewUrl: null,
      ...metadata,
      error: null,
    });
    emit({
      handle: input.handle,
      phase: "spawning",
      sandboxPath: workdir,
      projectName: metadata.projectName,
      branch: metadata.branch,
    });
    evictIfNeeded();
    let port: number | undefined;
    let spawned: SpawnResult | null = null;
    let daemonToken!: string;
    try {
      await mkdir(workdir, { recursive: true });
      console.log(
        `[user-desktop] ensure handle=${input.handle} repo=${input.repo?.cloneUrl ?? "(none)"} branch=${input.repo?.branch ?? "(none)"} runtime=${input.workload?.runtime ?? "(autodetect)"} pm=${input.workload?.packageManager ?? "(autodetect)"}`,
      );
      // Two ephemeral ports per sandbox: one for the daemon's HTTP/proxy
      // (port) and one for the dev script the orchestrator will spawn
      // (devPort). Without a dedicated devPort, every framework's
      // default 3000 collides with the cluster (and with other sandboxes).
      daemonToken = randomBytes(24).toString("hex");
      const [daemonPort, devPort] = await Promise.all([pickPort(), pickPort()]);
      port = daemonPort;
      console.log(
        `[user-desktop] spawn handle=${input.handle} port=${port} devPort=${devPort} workdir=${workdir}`,
      );
      spawned = await Promise.resolve(
        deps.spawnDaemon({
          workdir,
          handle: input.handle,
          port,
          daemonToken,
          // Offload SSRF allowlist from the cluster's trusted ensure body.
          // Defaults fail closed (empty list, no loopback) so a daemon spawned
          // by an older cluster that doesn't push these stays safe.
          offloadAllowedHosts: input.offloadAllowedHosts ?? [],
          offloadAllowSameHostDev: input.offloadAllowSameHostDev ?? false,
          // org-fs mount config (desktop-only); undefined → daemon skips mounting.
          orgFsConfigJson: input.orgFsConfigJson,
        }),
      );
      try {
        await deps.waitForHealth(port);
      } catch (err) {
        throw markBringUpFailure("the sandbox didn't come online in time", err);
      }
      console.log(
        `[user-desktop] healthy handle=${input.handle} port=${port} — posting config`,
      );
      try {
        await deps.postConfig(
          port,
          devPort,
          {
            repo: input.repo,
            workload: input.workload,
            operator: input.operator,
          },
          daemonToken,
        );
      } catch (err) {
        throw markBringUpFailure(
          isTimeoutLike(err)
            ? "configuration timed out"
            : "the sandbox rejected its configuration",
          err,
        );
      }
    } catch (err) {
      // A config-post timeout is expected under cold-start load, not a real
      // failure — console.error is wired to error tracking (see
      // observability/index.ts), so logging it at ERROR here was the #1
      // chronic error in prod (20k+ hits, issue #3763). Log it at WARN
      // instead; genuine bring-up failures still hit console.error.
      const log = isTimeoutLike(err) ? console.warn : console.error;
      log(
        `[user-desktop] sandbox bring-up failed handle=${input.handle} port=${port ?? "(none)"}${spawned ? " (killing daemon)" : ""}:`,
        err,
      );
      if (spawned) {
        try {
          spawned.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      emit({
        handle: input.handle,
        phase: "failed",
        error: bringUpCauseMessage(err),
        sandboxPath: workdir,
        projectName: metadata.projectName,
        branch: metadata.branch,
      });
      persist({
        handle: input.handle,
        status: "failed",
        sandboxPath: workdir,
        port: null,
        previewUrl: null,
        ...metadata,
        error: bringUpCauseMessage(err),
      });
      throw err;
    }
    if (!spawned || port === undefined) {
      throw new Error("sandbox bring-up invariant violated");
    }
    const sandboxApiUrl = `http://127.0.0.1:${port}`;
    const previewUrl = resolvePreviewUrl(input.handle, port);
    console.log(
      `[user-desktop] ready handle=${input.handle} port=${port} sandboxApiUrl=${sandboxApiUrl} previewUrl=${previewUrl}`,
    );
    const state: TrackedSandboxState = {
      handle: input.handle,
      port,
      process: spawned,
      sandboxApiUrl,
      previewUrl,
      lastUsedAt: Date.now(),
      activeDispatchCount: 0,
      daemonToken,
      registryMetadata: metadata,
    };
    sandboxes.set(input.handle, state);
    persist({
      handle: input.handle,
      status: "ready",
      sandboxPath: workdir,
      port,
      previewUrl,
      ...metadata,
      error: null,
    });
    emit({
      handle: input.handle,
      phase: "ready",
      port,
      previewUrl,
      sandboxPath: workdir,
      projectName: metadata.projectName,
      branch: metadata.branch,
    });

    // Watchdog: clear the map entry if the daemon process exits unexpectedly.
    // Without this the cache returns a stale dead port and the cluster's
    // alive() probe loops forever against a dead upstream.
    if (spawned.exited) {
      spawned.exited.then(() => {
        const current = sandboxes.get(input.handle);
        if (current === state) {
          console.warn(
            `[user-desktop] daemon process exited unexpectedly handle=${input.handle} port=${port} — removing from cache`,
          );
          sandboxes.delete(input.handle);
          persist({
            handle: input.handle,
            status: "stopped",
            sandboxPath: workdir,
            port: null,
            previewUrl: null,
            ...metadata,
            error: null,
          });
          emit({ handle: input.handle, phase: "evicted" });
        } else {
          console.log(
            `[user-desktop] daemon process exited handle=${input.handle} port=${port} (already replaced/removed)`,
          );
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
          console.log(
            `[user-desktop] cache hit handle=${input.handle} port=${existing.port} (alive)`,
          );
          existing.lastUsedAt = Date.now();
          return {
            sandboxApiUrl: existing.sandboxApiUrl,
            previewUrl: existing.previewUrl,
            port: existing.port,
          };
        }
        // Cached entry is dead — tear it down before respawning so the new
        // entry's spawn isn't fighting the corpse for the same workdir.
        console.warn(
          `[user-desktop] cache stale handle=${input.handle} port=${existing.port} — respawning`,
        );
        evictDead(existing);
      }
      const pending = inflight.get(input.handle);
      if (pending) {
        console.log(
          `[user-desktop] joining in-flight ensure handle=${input.handle}`,
        );
        return pending;
      }
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
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const cur = sandboxes.get(handle);
        if (cur) {
          cur.activeDispatchCount = Math.max(0, cur.activeDispatchCount - 1);
        }
      };
    },
    listSandboxes() {
      return [...sandboxes.values()];
    },
    async deleteSandbox(handle) {
      const s = sandboxes.get(handle);
      if (!s) {
        console.log(
          `[user-desktop] delete handle=${handle} (not found, no-op)`,
        );
        return;
      }
      // Never reap a sandbox with a run in flight. The cluster's FS hook reaps
      // on `DaemonUnreachable` (e.g. a git-status poll that timed out against a
      // busy-but-alive daemon); honoring that mid-dispatch SIGTERMs the sandbox,
      // closes its SSE pump, and the run dies with "missing seq" at projection.
      // The dispatch pin already shields LRU eviction — this extends it to the
      // explicit delete path. The cluster's follow-up `ensureSandbox` cache-hits
      // the still-alive sandbox, so a transient timeout self-heals via retry.
      if (s.activeDispatchCount > 0) {
        console.warn(
          `[user-desktop] delete handle=${handle} port=${s.port} REFUSED — ${s.activeDispatchCount} active dispatch(es) in flight`,
        );
        return;
      }
      console.log(`[user-desktop] delete handle=${handle} port=${s.port}`);
      try {
        s.process.kill("SIGTERM");
      } catch {
        // already gone
      }
      sandboxes.delete(handle);
      persist({
        handle,
        status: "stopped",
        sandboxPath: sandboxPath(handle),
        port: null,
        previewUrl: null,
        repoCloneUrl: null,
        branch: null,
        projectName: null,
        error: null,
      });
      emit({ handle, phase: "deleted" });
    },
    async shutdown() {
      console.log(
        `[user-desktop] shutdown — killing ${sandboxes.size} sandbox(es)`,
      );
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
