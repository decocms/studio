/** The one hosted sandbox provider, shared across every API request. */

import type { StudioContext } from "@/core/studio-context";
import type { SandboxProvider } from "@decocms/sandbox/provider";
import type {
  ClaimPhase,
  AgentSandboxProvider,
} from "@decocms/sandbox/provider/agent-sandbox";
import { getDb } from "@/database";
import type { Kysely } from "kysely";
import { meter } from "@/observability";
import type { Database as DatabaseSchema } from "@/storage/types";
import { KyselySandboxProviderStateStore } from "@/storage/sandbox-runner-state";
import { buildCloneInfo } from "@/shared/github-clone-info";
import { CredentialVault } from "@/encryption/credential-vault";
import { getSettings } from "@/settings";
import { parseGithubOwnerRepo } from "@/sandbox/parse-github-clone-url";

// Stashed on globalThis so they survive Bun's `--hot` reload. The preview
// reverse-proxy registered at the top of `apps/api/src/index.ts` is wired
// into the long-lived `Bun.serve` handlers, whose closures capture
// `getOrInitAgentSandboxProvider` from whichever module instance was active
// at boot. Without the global anchor, post-reload preview requests would look
// up runners in a stale module's empty map and re-provision needlessly.
// Symbol.for keeps the same key across module instances.
const RUNNER_KEY = Symbol.for("decocms.sandbox.lifecycle.runner");
const INFLIGHT_KEY = Symbol.for("decocms.sandbox.lifecycle.agent-inflight");
type LifecycleGlobal = {
  [RUNNER_KEY]?: AgentSandboxProvider;
  [INFLIGHT_KEY]?: Promise<AgentSandboxProvider>;
};
const lifecycleGlobal = globalThis as unknown as LifecycleGlobal;

// In-flight instantiate() promise. Two concurrent
// callers on a cold studio would otherwise both miss the resolved-runner
// cache and both call instantiate(); memoizing the promise (and only
// promoting to `runner` once it resolves) collapses them to a single
// build. Cleared on failure so a retry can take a fresh swing.
function resolveOnce(
  build: () => Promise<AgentSandboxProvider>,
): Promise<AgentSandboxProvider> {
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

// Set in prod (k8s behind ingress) so the provider skips the local
// 127.0.0.1 port-forward path and emits a URL the user's browser can
// actually reach. Empty/unset = local forwarder fallback (dev).
function readPreviewUrlPattern(): string | undefined {
  const raw = process.env.STUDIO_SANDBOX_PREVIEW_URL_PATTERN;
  return raw && raw.trim() !== "" ? raw : undefined;
}

// Per-env SandboxTemplate name. The sandbox-env Helm chart suffixes the
// template name with envName so multiple envs share `agent-sandbox-system`
// without collisions; studio in this env must point its claims at the
// matching suffixed name. Empty/unset → AgentSandboxProvider's built-in
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
// sandbox-env helm chart's Secret. Set on the studio side from the same
// Secret so both ends agree on what the warm-pool sentinel is.
//
// Presence flips AgentSandboxProvider into warm-pool mode (claims with
// `warmpool: "default"` + empty env; per-claim token rotated post-bind).
// Empty/unset → legacy cold-start path with per-claim env injection.
function readSandboxSentinelToken(): string | undefined {
  const raw = process.env.STUDIO_SANDBOX_SENTINEL_TOKEN;
  return raw && raw.trim() !== "" ? raw : undefined;
}

// Per-claim HTTPRoute attaches to this Gateway. When NAME + NAMESPACE are
// set alongside STUDIO_SANDBOX_PREVIEW_URL_PATTERN, studio mints one
// HTTPRoute per SandboxClaim so the wildcard Gateway can route directly
// to each sandbox's Service:9000 (studio leaves the data path).
//
// Both required — no default — because the provider is Gateway-API-generic
// (Istio, Envoy Gateway, Cilium, Kong, ...) and there's no portable
// "default gateway namespace": Istio classic uses istio-system, Istio
// ambient prefers a separate `istio-ingress`/`gateway` ns, and other
// implementations vary. A wrong default would silently write routes that
// fail to attach (parentRef → non-existent Gateway) and the failure mode
// is a 404 from the gateway with no log on the studio side.
//
// Both unset → provider falls back to in-process preview proxying (legacy).
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

async function instantiateAgentSandbox(
  db: Kysely<DatabaseSchema>,
): Promise<AgentSandboxProvider> {
  const stateStore = new KyselySandboxProviderStateStore(db);
  const previewUrlPattern = readPreviewUrlPattern();
  // Dynamic import — @kubernetes/client-node is heavy and only needed when
  // hosted sandboxes are enabled. Local-only deployments never load it.
  const { AgentSandboxProvider } = await import(
    "@decocms/sandbox/provider/agent-sandbox"
  );
  // `meter` is reassigned by initObservability() after sdk.start(); read it at
  // construction time so we get the real instruments, not the no-op evaluated
  // at module load.
  const vault = new CredentialVault(getSettings().encryptionKey);
  return new AgentSandboxProvider({
    stateStore,
    previewUrlPattern,
    sandboxTemplateName: readSandboxTemplateName(),
    envName: readEnvName(),
    previewGateway: readPreviewGateway(),
    sentinelToken: readSandboxSentinelToken(),
    meter,
    mintCloneUrl: async (repo, mintOpts) => {
      if (!repo.connectionId) return null;
      const parsed = parseGithubOwnerRepo(repo.cloneUrl);
      if (!parsed) return null;
      const { cloneUrl } = await buildCloneInfo(
        repo.connectionId,
        parsed.owner,
        parsed.name,
        db,
        vault,
        { bufferMs: mintOpts?.bufferMs },
      );
      return cloneUrl;
    },
  });
}

/** Resolve the hosted provider for a request path that requires it. */
export function getAgentSandboxProvider(
  ctx: StudioContext,
): Promise<AgentSandboxProvider> {
  if (!getSettings().agentSandboxEnabled) {
    throw new Error("Agent sandbox is not enabled");
  }
  return getAgentSandboxProviderForTeardown(ctx);
}

/**
 * Recorded hosted claims remain tear-downable after provisioning is disabled.
 * Call only after resolving a canonical agent-sandbox record.
 */
export function getAgentSandboxProviderForTeardown(
  ctx: StudioContext,
): Promise<AgentSandboxProvider> {
  return resolveOnce(() => instantiateAgentSandbox(ctx.db));
}

/**
 * Provider accessor for preview-host proxying, which runs outside a request
 * StudioContext. Disabled deployments return null without importing Kubernetes.
 */
export function getOrInitAgentSandboxProvider(): Promise<AgentSandboxProvider | null> {
  if (!getSettings().agentSandboxEnabled) return Promise.resolve(null);
  return resolveOnce(() => instantiateAgentSandbox(getDb().db));
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

// Same `--hot` reload concern as `runner`/`inflight` above: an in-flight
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
  runner: SandboxProvider,
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
  runner: SandboxProvider,
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
