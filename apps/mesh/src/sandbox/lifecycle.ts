/**
 * Runner singletons, one per kind. VM_DELETE dispatches on the entry's
 * recorded runnerKind (not env), so a pod that flipped STUDIO_SANDBOX_RUNNER
 * between start and stop still tears down the right kind of VM.
 * Boot/shutdown sweeps are Docker-only — other runners' sandboxes outlive
 * mesh by design, so a generic sweep would nuke active user VMs.
 */

import type { MeshContext } from "@/core/mesh-context";
import {
  DockerSandboxRunner,
  resolveRunnerKindFromEnv,
  type RunnerKind,
  type SandboxRunner,
} from "@decocms/sandbox/runner";
import type { ClaimPhase } from "@decocms/sandbox/runner/agent-sandbox";
import { getDb } from "@/database";
import type { Kysely } from "kysely";
import { meter } from "@/observability";
import type { Database as DatabaseSchema } from "@/storage/types";
import { KyselySandboxRunnerStateStore } from "@/storage/sandbox-runner-state";

// Stashed on globalThis so they survive Bun's `--hot` reload. The local
// sandbox ingress is a long-lived `net.Server` registered at the top of
// `apps/mesh/src/index.ts`; it isn't torn down when the entry point
// re-evaluates, and its closure captures `getSharedRunnerIfInit` from
// whichever instance of this module was active at boot. Without the
// global anchor, post-reload requests to `<handle>.localhost:7070` would
// look up runners in a stale module's empty map → 503 "Sandbox Runner
// Not Initialized". Symbol.for keeps the same key across module instances.
const RUNNERS_KEY = Symbol.for("decocms.sandbox.lifecycle.runners");
const INFLIGHT_KEY = Symbol.for("decocms.sandbox.lifecycle.inflight");
type LifecycleGlobal = {
  [RUNNERS_KEY]?: Partial<Record<RunnerKind, SandboxRunner>>;
  [INFLIGHT_KEY]?: Partial<Record<RunnerKind, Promise<SandboxRunner>>>;
};
const lifecycleGlobal = globalThis as unknown as LifecycleGlobal;

const runners: Partial<Record<RunnerKind, SandboxRunner>> = (lifecycleGlobal[
  RUNNERS_KEY
] ??= {});
// In-flight instantiate() promises, memoized per kind. Two concurrent
// callers on a cold mesh would otherwise both miss the resolved-runner
// cache and both call instantiate(); memoizing the promise (and only
// promoting to `runners` once it resolves) collapses them to a single
// build. Cleared on failure so a retry can take a fresh swing.
const inflight: Partial<Record<RunnerKind, Promise<SandboxRunner>>> =
  (lifecycleGlobal[INFLIGHT_KEY] ??= {});

function resolveOnce(
  kind: RunnerKind,
  build: () => Promise<SandboxRunner>,
): Promise<SandboxRunner> {
  const cached = runners[kind];
  if (cached) return Promise.resolve(cached);
  const pending = inflight[kind];
  if (pending) return pending;
  const promise = build()
    .then((runner) => {
      runners[kind] = runner;
      return runner;
    })
    .finally(() => {
      delete inflight[kind];
    });
  inflight[kind] = promise;
  return promise;
}

// Set in prod (k8s/docker behind ingress) so the runner skips the local
// 127.0.0.1 port-forward path and emits a URL the user's browser can
// actually reach. Empty/unset = local forwarder fallback (dev).
function readPreviewUrlPattern(): string | undefined {
  const raw = process.env.STUDIO_SANDBOX_PREVIEW_URL_PATTERN;
  return raw && raw.trim() !== "" ? raw : undefined;
}

// Per-env SandboxTemplate name. The sandbox-env Helm chart suffixes the
// template name with envName so multiple envs share `agent-sandbox-system`
// without collisions; mesh in this env must point its claims at the
// matching suffixed name. Empty/unset → AgentSandboxRunner's built-in
// default ("studio-sandbox") so single-env installs that didn't suffix
// keep working.
function readSandboxTemplateName(): string | undefined {
  const raw = process.env.STUDIO_SANDBOX_TEMPLATE_NAME;
  return raw && raw.trim() !== "" ? raw : undefined;
}

function readEnvName(): string | undefined {
  const raw = process.env.STUDIO_ENV;
  return raw && raw.trim() !== "" ? raw : undefined;
}

// Shared bearer baked into the SandboxTemplate's pod env via the
// sandbox-env helm chart's Secret. Set on the mesh side from the same
// Secret so both ends agree on what the warm-pool sentinel is.
//
// Presence flips AgentSandboxRunner into warm-pool mode (claims with
// `warmpool: "default"` + empty env; per-claim token rotated post-bind).
// Empty/unset → legacy cold-start path with per-claim env injection.
function readSandboxSentinelToken(): string | undefined {
  const raw = process.env.STUDIO_SANDBOX_SENTINEL_TOKEN;
  return raw && raw.trim() !== "" ? raw : undefined;
}

// Per-claim HTTPRoute attaches to this Gateway. When NAME + NAMESPACE are
// set alongside STUDIO_SANDBOX_PREVIEW_URL_PATTERN, mesh mints one
// HTTPRoute per SandboxClaim so the wildcard Gateway can route directly
// to each sandbox's Service:9000 (mesh leaves the data path).
//
// Both required — no default — because the runner is Gateway-API-generic
// (Istio, Envoy Gateway, Cilium, Kong, ...) and there's no portable
// "default gateway namespace": Istio classic uses istio-system, Istio
// ambient prefers a separate `istio-ingress`/`gateway` ns, and other
// implementations vary. A wrong default would silently write routes that
// fail to attach (parentRef → non-existent Gateway) and the failure mode
// is a 404 from the gateway with no log on the mesh side.
//
// Both unset → runner falls back to in-process preview proxying (legacy).
// Half-configured (one set, the other not) → fail fast at boot rather
// than silently choose a behavior the operator didn't ask for.
function readPreviewGateway(): { name: string; namespace: string } | undefined {
  const name = process.env.STUDIO_SANDBOX_PREVIEW_GATEWAY_NAME?.trim();
  const namespace =
    process.env.STUDIO_SANDBOX_PREVIEW_GATEWAY_NAMESPACE?.trim();
  if (!name && !namespace) return undefined;
  if (!name || !namespace) {
    throw new Error(
      "STUDIO_SANDBOX_PREVIEW_GATEWAY_NAME and STUDIO_SANDBOX_PREVIEW_GATEWAY_NAMESPACE must both be set, or both unset. Half-configured per-claim HTTPRoute routing would silently fail to attach.",
    );
  }
  return { name, namespace };
}

async function instantiate(
  kind: RunnerKind,
  db: Kysely<DatabaseSchema>,
): Promise<SandboxRunner> {
  const stateStore = new KyselySandboxRunnerStateStore(db);
  const previewUrlPattern = readPreviewUrlPattern();
  switch (kind) {
    case "host": {
      const { HostSandboxRunner } = await import("@decocms/sandbox/runner");
      const { getSettings } = await import("@/settings");
      return new HostSandboxRunner({
        homeDir: getSettings().dataDir,
        stateStore,
        previewUrlPattern,
      });
    }
    case "docker":
      return new DockerSandboxRunner({ stateStore, previewUrlPattern });
    case "freestyle": {
      // Dynamic import — freestyle SDK is an optionalDependency so
      // docker-only deploys don't need it installed.
      const { FreestyleSandboxRunner } = await import(
        "@decocms/sandbox/runner/freestyle"
      );
      return new FreestyleSandboxRunner({ stateStore });
    }
    case "agent-sandbox": {
      // Dynamic import — @kubernetes/client-node is heavy and only needed
      // when STUDIO_SANDBOX_RUNNER=agent-sandbox. Docker/Freestyle deploys never
      // load it.
      const { AgentSandboxRunner } = await import(
        "@decocms/sandbox/runner/agent-sandbox"
      );
      // `meter` is reassigned by initObservability() after sdk.start(); read
      // it at runner construction (post-init) so we get the real instruments
      // not the no-op evaluated at module load.
      return new AgentSandboxRunner({
        stateStore,
        previewUrlPattern,
        sandboxTemplateName: readSandboxTemplateName(),
        envName: readEnvName(),
        previewGateway: readPreviewGateway(),
        sentinelToken: readSandboxSentinelToken(),
        meter,
      });
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown runner kind: ${String(exhaustive)}`);
    }
  }
}

export function getSharedRunner(ctx: MeshContext): Promise<SandboxRunner> {
  return getRunnerByKind(ctx, resolveRunnerKindFromEnv());
}

/** VM_DELETE uses this so teardown follows the entry's recorded runnerKind. */
export function getRunnerByKind(
  ctx: MeshContext,
  kind: RunnerKind,
): Promise<SandboxRunner> {
  return resolveOnce(kind, () => instantiate(kind, ctx.db));
}

/**
 * Eager runner accessor for paths that need the runner before any user
 * request — preview-host proxying at the Bun.serve layer is the only caller
 * today. Reads the runner kind from env and constructs without a
 * MeshContext (the state store only needs a Kysely instance). Returns null
 * when no runner kind is configured.
 */
export async function getOrInitSharedRunner(): Promise<SandboxRunner | null> {
  let kind: RunnerKind;
  try {
    kind = resolveRunnerKindFromEnv();
  } catch (err) {
    console.warn(
      "[lifecycle] cannot resolve sandbox runner:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  return resolveOnce(kind, () => instantiate(kind, getDb().db));
}

/**
 * Return the active runner iff already constructed — avoids forcing a
 * MeshContext (and DB connection) before any request touches a sandbox.
 * Returns null if env is unresolved.
 */
export function getSharedRunnerIfInit(): SandboxRunner | null {
  let kind: RunnerKind;
  try {
    kind = resolveRunnerKindFromEnv();
  } catch {
    return null;
  }
  return runners[kind] ?? null;
}

/** Narrow to Docker for Docker-only methods (resolveDevPort / resolveDaemonPort). */
export function asDockerRunner(
  runner: SandboxRunner | null,
): DockerSandboxRunner | null {
  return runner instanceof DockerSandboxRunner ? runner : null;
}

// ---------------------------------------------------------------------------
// Shared lifecycle subscriptions (multi-tab dedup)
//
// Each browser tab opening `/api/vm-events` for the same `(orgId, virtualMcpId,
// branch, callerUserId)` produces the same `claimName` — so without dedup,
// every tab opening on agent-sandbox would open its own set of K8s watches
// (Pod / Sandbox CR / Events = 3 long-lived API streams per tab). Real users
// keep 2–3 tabs of the same project open while iterating.
//
// `subscribeLifecycle` collapses those onto a single source generator per
// claim, ref-counted by listener. Last unsubscribe aborts the source and
// removes the cache entry. New subscribers get the most recent phase replayed
// synchronously so they don't appear stuck on `claiming` while waiting for
// the next watch event.
//
// For host/docker/freestyle the source generator yields a single `ready` and
// returns; the dedup machinery still works (each subscriber gets the phase
// replayed) at near-zero cost.
// ---------------------------------------------------------------------------

interface SharedLifecycleEntry {
  /** Last phase emitted by the source. Replayed to late joiners. */
  lastPhase: ClaimPhase | null;
  /** True after the source emitted a terminal (`ready`/`failed`) phase. */
  terminated: boolean;
  /** Active subscriber callbacks. Source is torn down when this hits zero. */
  listeners: Set<(phase: ClaimPhase) => void>;
  /** Aborted when listeners drains; closes the underlying watches. */
  abort: AbortController;
}

// Same `--hot` reload concern as `runners`/`inflight` above: an in-flight
// lifecycle subscription must not be orphaned when the module re-evaluates,
// or two SSE clients on the same claim would each open their own watch.
const SHARED_LIFECYCLES_KEY = Symbol.for(
  "decocms.sandbox.lifecycle.shared-lifecycles",
);
const sharedLifecyclesGlobal = globalThis as unknown as {
  [SHARED_LIFECYCLES_KEY]?: Map<string, SharedLifecycleEntry>;
};
const sharedLifecycles: Map<string, SharedLifecycleEntry> =
  (sharedLifecyclesGlobal[SHARED_LIFECYCLES_KEY] ??= new Map<
    string,
    SharedLifecycleEntry
  >());

export interface LifecycleHandle {
  unsubscribe(): void;
}

/**
 * Subscribe to a SandboxClaim's lifecycle phase stream. Multiple subscribers
 * for the same `claimName` share one underlying watcher; `onPhase` is called
 * for every phase transition observed, plus an immediate replay of the last
 * known phase if the entry already exists.
 *
 * The returned handle's `unsubscribe()` is idempotent. The source watcher is
 * aborted when the last listener drops or when a terminal phase has been
 * observed (whichever comes first).
 */
export function subscribeLifecycle(
  runner: SandboxRunner,
  claimName: string,
  onPhase: (phase: ClaimPhase) => void,
): LifecycleHandle {
  let entry = sharedLifecycles.get(claimName);

  if (entry) {
    // Already terminated entries are kept around only briefly (until the
    // generator's finally clears them) — replay the terminal phase to the
    // new subscriber and skip the listener add. Caller doesn't need more
    // events from a finished lifecycle.
    if (entry.terminated) {
      if (entry.lastPhase) {
        try {
          onPhase(entry.lastPhase);
        } catch {
          /* swallow */
        }
      }
      return { unsubscribe: noopUnsubscribe };
    }
    entry.listeners.add(onPhase);
    if (entry.lastPhase) {
      try {
        onPhase(entry.lastPhase);
      } catch {
        /* swallow */
      }
    }
    return makeUnsubscribeHandle(claimName, entry, onPhase);
  }

  // First subscriber for this claim — create the entry and pump the source.
  const abort = new AbortController();
  const newEntry: SharedLifecycleEntry = {
    lastPhase: null,
    terminated: false,
    listeners: new Set([onPhase]),
    abort,
  };
  sharedLifecycles.set(claimName, newEntry);

  void pumpLifecycleSource(runner, claimName, newEntry);

  return makeUnsubscribeHandle(claimName, newEntry, onPhase);
}

function noopUnsubscribe() {
  /* no-op */
}

function makeUnsubscribeHandle(
  claimName: string,
  entry: SharedLifecycleEntry,
  onPhase: (phase: ClaimPhase) => void,
): LifecycleHandle {
  return {
    unsubscribe() {
      // Guard against the entry having been recycled — only mutate the entry
      // we attached to.
      if (sharedLifecycles.get(claimName) !== entry) return;
      entry.listeners.delete(onPhase);
      if (entry.listeners.size === 0) {
        // Synchronous cleanup avoids a window where a fresh subscribe would
        // attach to a soon-to-be-aborted entry. The source's finally clause
        // only deletes if the map still points at this entry.
        sharedLifecycles.delete(claimName);
        entry.abort.abort();
      }
    },
  };
}

async function pumpLifecycleSource(
  runner: SandboxRunner,
  claimName: string,
  entry: SharedLifecycleEntry,
): Promise<void> {
  let sourceError: unknown = null;
  try {
    for await (const phase of runner.watchClaimLifecycle(
      claimName,
      entry.abort.signal,
    )) {
      if (entry.abort.signal.aborted) break;
      entry.lastPhase = phase;
      const isTerminal = phase.kind === "ready" || phase.kind === "failed";
      if (isTerminal) entry.terminated = true;
      // Snapshot the listener set — a callback may unsubscribe synchronously
      // and we don't want to skip subsequent listeners or re-iterate.
      const snapshot = Array.from(entry.listeners);
      for (const listener of snapshot) {
        try {
          listener(phase);
        } catch {
          /* swallow — one bad subscriber shouldn't break the others */
        }
      }
      if (isTerminal) break;
    }
  } catch (err) {
    sourceError = err;
  } finally {
    // Source ended without a terminal phase (kube client gave up, generator
    // threw, etc) and listeners are still attached — surface a synthetic
    // `failed: unknown` so they don't hang. Listeners that already saw a
    // terminal phase won't trigger this branch (entry.terminated short-
    // circuits the loop earlier).
    if (
      !entry.terminated &&
      !entry.abort.signal.aborted &&
      entry.listeners.size > 0
    ) {
      const synthetic: ClaimPhase = {
        kind: "failed",
        reason: "unknown",
        message:
          sourceError instanceof Error
            ? sourceError.message
            : "Lifecycle watcher ended unexpectedly",
      };
      entry.lastPhase = synthetic;
      entry.terminated = true;
      for (const listener of Array.from(entry.listeners)) {
        try {
          listener(synthetic);
        } catch {
          /* swallow */
        }
      }
    }
    if (sharedLifecycles.get(claimName) === entry) {
      sharedLifecycles.delete(claimName);
    }
  }
}

/**
 * Test-only escape hatch: the in-memory shared-lifecycle cache is pod-local
 * and survives across requests. Tests that exercise the dedup flow need to
 * reset it between runs.
 *
 * @internal
 */
export function __resetSharedLifecyclesForTesting(): void {
  for (const entry of sharedLifecycles.values()) entry.abort.abort();
  sharedLifecycles.clear();
}
