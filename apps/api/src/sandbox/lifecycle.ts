/** Hosted sandbox provider lifecycle. */

import type { StudioContext } from "@/core/studio-context";
import type {
  ClaimPhase,
  HostedSandboxProvider,
} from "@decocms/sandbox/provider";
import type { SandboxImage } from "@decocms/shared/git-providers";
import { getDb } from "@/database";
import { CredentialVault } from "@/encryption/credential-vault";
import { getSettings } from "@/settings";
import type { SandboxControllerSettings } from "@/settings/types";
import { sandboxCredentialMinters } from "@/sandbox/credential-mint";

// Stashed on globalThis so they survive Bun's `--hot` reload. The preview
// reverse-proxy registered at the top of `apps/api/src/index.ts` is wired
// into the long-lived `Bun.serve` handlers, whose closures capture
// `getOrInitSharedRunner` from whichever instance of this module was active
// at boot. Without the global anchor, post-reload preview requests would look
// up a runner in a stale module's empty cache and re-provision needlessly.
// Symbol.for keeps the same key across module instances.
const RUNNER_KEY = Symbol.for("decocms.sandbox.lifecycle.agent-sandbox-runner");
const INFLIGHT_KEY = Symbol.for(
  "decocms.sandbox.lifecycle.agent-sandbox-inflight",
);
type LifecycleGlobal = {
  [RUNNER_KEY]?: HostedSandboxProvider;
  [INFLIGHT_KEY]?: Promise<HostedSandboxProvider>;
};
const lifecycleGlobal = globalThis as unknown as LifecycleGlobal;

// An in-flight instantiate() promise is memoized globally. Two concurrent
// callers on a cold studio would otherwise both miss the resolved-runner
// cache and both call instantiate(); memoizing the promise (and only
// promoting it to the runner slot once it resolves) collapses them to a single
// build. Cleared on failure so a retry can take a fresh swing.
function resolveOnce(
  build: () => Promise<HostedSandboxProvider>,
): Promise<HostedSandboxProvider> {
  const cached = lifecycleGlobal[RUNNER_KEY];
  if (cached) return Promise.resolve(cached);
  const pending = lifecycleGlobal[INFLIGHT_KEY];
  if (pending) return pending;
  const promise = build()
    .then((runner) => {
      lifecycleGlobal[RUNNER_KEY] = runner;
      return runner;
    })
    .finally(() => {
      delete lifecycleGlobal[INFLIGHT_KEY];
    });
  lifecycleGlobal[INFLIGHT_KEY] = promise;
  return promise;
}

/**
 * The sandbox controller owns claims, pools and credential refresh; Studio
 * keeps only the daemon conversation.
 */
async function instantiate(
  controller: SandboxControllerSettings,
): Promise<HostedSandboxProvider> {
  const { RemoteSandboxProvider } = await import(
    "@decocms/sandbox/provider/remote"
  );
  const [cert, key, ca] = await Promise.all([
    Bun.file(controller.certPath).text(),
    Bun.file(controller.keyPath).text(),
    Bun.file(controller.caPath).text(),
  ]);
  return new RemoteSandboxProvider({
    baseUrl: controller.url,
    tls: { cert, key, ca },
  });
}

/** Resolves the provider whenever the settings name a controller. */
function resolveProvider(): Promise<HostedSandboxProvider> {
  const controller = getSettings().sandboxController;
  if (!controller) {
    return Promise.reject(
      new Error(
        "Agent sandbox is disabled. Set STUDIO_AGENT_SANDBOX_ENABLED=true and the STUDIO_SANDBOX_CONTROLLER_* settings to enable it.",
      ),
    );
  }
  return resolveOnce(() => instantiate(controller));
}

/**
 * Start the mTLS listener the controller calls back on, when agent sandboxes
 * are enabled with a callback port. Null otherwise: nothing listens, and the
 * callback paths exist nowhere else.
 */
export async function startSandboxControllerCallbacks(): Promise<{
  stop(): Promise<void>;
} | null> {
  const controller = getSettings().sandboxController;
  if (!controller?.callbackPort) return null;
  const [
    { createSandboxControllerCallbackApp, serveSandboxControllerCallbacks },
    { parseTenantPools },
    { listStatesByCloneSource, listStatesByTenant },
  ] = await Promise.all([
    import("@/sandbox/controller-callbacks"),
    import("@decocms/sandbox/provider/tenant-pools"),
    import("@/storage/sandbox-runner-state"),
  ]);
  const [cert, key, ca] = await Promise.all([
    Bun.file(controller.certPath).text(),
    Bun.file(controller.keyPath).text(),
    Bun.file(controller.caPath).text(),
  ]);
  const { db } = getDb();
  const minters = sandboxCredentialMinters(
    db,
    new CredentialVault(getSettings().encryptionKey),
  );
  const app = createSandboxControllerCallbackApp({
    statesByCloneSource: (source) => listStatesByCloneSource(db, source),
    statesByTenant: (tenant) => listStatesByTenant(db, tenant),
    tenantPools: parseTenantPools(process.env.STUDIO_SANDBOX_TENANT_POOLS),
    mintCloneUrl: minters.mintCloneUrl,
    mintOrgFsConfig: minters.mintOrgFsConfig,
  });
  const server = serveSandboxControllerCallbacks({
    port: controller.callbackPort,
    tls: { cert, key, ca },
    app,
  });
  console.log(
    `[lifecycle] sandbox controller callbacks listening on :${server.port} (mTLS)`,
  );
  return { stop: () => server.stop(true) };
}

/** Resolve the hosted provider for enabled user-facing operations. */
export function getAgentSandboxProvider(
  _ctx: StudioContext,
): Promise<HostedSandboxProvider> {
  if (!getSettings().agentSandboxEnabled) {
    throw new Error(
      "Agent sandbox is disabled. Set STUDIO_AGENT_SANDBOX_ENABLED=true to enable it.",
    );
  }
  return resolveProvider();
}

/** Image variants a repository can pick; none while hosted sandboxes are off. */
export async function listSandboxImages(
  ctx: StudioContext,
): Promise<SandboxImage[]> {
  if (!getSettings().agentSandboxEnabled) return [];
  return (await getAgentSandboxProvider(ctx)).listSandboxImages();
}

/**
 * Resolve the hosted provider for teardown. Shares the singleton used by
 * user-facing operations; with agent sandboxes off there is no controller to
 * reach, and this rejects.
 */
export function getAgentSandboxProviderForTeardown(
  _ctx: StudioContext,
): Promise<HostedSandboxProvider> {
  return resolveProvider();
}

/**
 * Eager provider accessor for paths that need the provider before any user
 * request — preview-host proxying at the Bun.serve layer is the only caller
 * today. Returns null when hosted agent sandboxes are disabled.
 */
export async function getOrInitSharedRunner(): Promise<HostedSandboxProvider | null> {
  if (!getSettings().agentSandboxEnabled) return null;
  return resolveProvider();
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

// Same `--hot` reload concern as the runner/inflight slots above: an in-flight
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

type LifecycleWatcher = Pick<HostedSandboxProvider, "watchClaimLifecycle">;

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
  runner: LifecycleWatcher,
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
  runner: LifecycleWatcher,
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
