/**
 * Per-claim lifecycle watcher for agent-sandbox SandboxClaims.
 *
 * Bridges the visibility gap between `VM_START` posting a SandboxClaim and
 * the daemon SSE coming online. Synthesizes a coarse phase signal from
 * three K8s primitives:
 *
 *   - the Pod (label-selected by `studio.decocms.com/sandbox-handle`),
 *   - kubelet/scheduler Events on that Pod,
 *   - the Sandbox CR (Ready condition),
 *
 * and emits a typed `ClaimPhase` whenever the inferred phase changes.
 *
 * Single-claim design: one set of watches per subscriber. Lifecycle SSEs
 * are short-lived (~30–120s) so the cost of opening per-claim streams is
 * dominated by the time-to-Ready rather than informer overhead. Avoids the
 * complexity of a shared namespace informer with demux + ref counting.
 *
 * Phase derivation (in order of monotonic forward progress, only the first
 * matching rule applies):
 *
 *   ready              – Sandbox CR has condition Ready=True.
 *   failed             – Pod's main container is in ImagePullBackOff /
 *                        ErrImagePull / CrashLoopBackOff, OR scheduling
 *                        has been failing past `schedulingTimeoutMs`.
 *   warming-daemon     – Container is running but not yet Ready.
 *   starting-container – Image is pulled; container is being created.
 *   pulling-image      – Pull in flight (Pulling event, no Pulled yet).
 *   waiting-for-capacity
 *                      – PodScheduled=False with reason `Unschedulable`,
 *                        or a recent `FailedScheduling` event.
 *   claiming           – Default: SandboxClaim posted, no Pod yet.
 *
 * Container name `sandbox` and pod label `studio.decocms.com/sandbox-handle`
 * are mesh conventions verified against the running cluster — do not rely
 * on operator-set labels (e.g. `agents.x-k8s.io/sandbox-name`), which exist
 * only as truncated `-hash` variants.
 */

import { type KubeConfig } from "@kubernetes/client-node";
import { K8S_CONSTANTS } from "./constants";
import { kubeFetch, readNdJson } from "./client";
import type { SandboxResource } from "./client";
import type { ClaimPhase } from "./lifecycle-types";

export type {
  ClaimFailureReason,
  ClaimPhase,
} from "./lifecycle-types";

const SANDBOX_HANDLE_LABEL = "studio.decocms.com/sandbox-handle";
const MAIN_CONTAINER_NAME = "sandbox";

const DEFAULT_SCHEDULING_TIMEOUT_MS = 5 * 60 * 1000;

export interface WatchClaimLifecycleOptions {
  kc: KubeConfig;
  namespace: string;
  /** SandboxClaim name. Mesh convention: pod name === claim name. */
  claimName: string;
  signal?: AbortSignal;
  /**
   * Hard ceiling for "scheduling never succeeded" — if FailedScheduling has
   * been observed without a successful Pulling/Pulled progression after this
   * many ms from watch start, emit `failed: scheduling-timeout`. Default 5min.
   *
   * On a karpenter cluster this rarely trips (nodes get provisioned within
   * 60–90s); on a fixed-capacity cluster (e.g. local kind) it surfaces a
   * genuine scheduling problem instead of hanging indefinitely.
   */
  schedulingTimeoutMs?: number;
  /**
   * Optional clock injection for tests. Defaults to `Date.now()`.
   */
  now?: () => number;
}

// ---- Internal types ---------------------------------------------------------

interface PodSnapshot {
  /** PodScheduled condition reason when status=False (`Unschedulable`). */
  scheduledFalseReason?: string;
  /** Optional message attached to PodScheduled=False. */
  scheduledFalseMessage?: string;
  /** True once PodScheduled=True is observed. */
  scheduled?: boolean;
  /**
   * Waiting-state reason on the `sandbox` container, if any. Includes
   * `ContainerCreating`, `PodInitializing`, `ImagePullBackOff`,
   * `ErrImagePull`, `CrashLoopBackOff`.
   */
  containerWaitingReason?: string;
  /** True once `sandbox` container's state.running is set. */
  containerRunning?: boolean;
  /** True once `sandbox` container reports `ready: true`. */
  containerReady?: boolean;
}

interface SandboxSnapshot {
  ready?: boolean;
  /**
   * Non-Ready condition reason — surfaced into a `reconciler-error` failure
   * when paired with status=False, otherwise informational.
   */
  notReadyReason?: string;
  notReadyMessage?: string;
}

interface EventsSnapshot {
  /** Last `Pulling` event seen on the pod. */
  hasPulling: boolean;
  /** Last `Pulled` event seen — fires both for fresh pulls and cache hits. */
  hasPulled: boolean;
  /** Most recent `FailedScheduling` event timestamp (ms since epoch). */
  lastFailedSchedulingAt?: number;
  /** Latest scheduling failure message. */
  failedSchedulingMessage?: string;
  /** Latest `Nominated` (karpenter) target nodeclaim, if any. */
  nominatedNodeClaim?: string;
}

interface State {
  pod: PodSnapshot;
  sandbox: SandboxSnapshot;
  events: EventsSnapshot;
  /** First time we observed a Pod/Sandbox/Event for this claim. */
  startedAt: number;
}

type SignalKind = "pod" | "sandbox" | "event" | "tick";

// ---- Public entry point -----------------------------------------------------

/**
 * Async generator that yields `ClaimPhase` whenever the inferred phase
 * changes. Closes the underlying watches when the generator is returned
 * (consumer breaks the loop) or when `signal` aborts.
 *
 * Terminal phases: `ready`, `failed`. Consumers should break the loop when
 * either is observed.
 *
 * Initial phase: emitted synchronously after the first watch handshake. If
 * the claim doesn't exist yet (caller raced VM_START), the first phase is
 * `claiming` and stays there until the operator creates the Sandbox/Pod.
 */
export async function* watchClaimLifecycle(
  opts: WatchClaimLifecycleOptions,
): AsyncGenerator<ClaimPhase, void, unknown> {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const schedulingTimeoutMs =
    opts.schedulingTimeoutMs ?? DEFAULT_SCHEDULING_TIMEOUT_MS;

  const state: State = {
    pod: {},
    sandbox: {},
    events: { hasPulling: false, hasPulled: false },
    startedAt,
  };

  const queue: SignalKind[] = [];
  let pendingResolve: ((s: SignalKind | null) => void) | null = null;
  let closed = false;

  const push = (kind: SignalKind) => {
    if (closed) return;
    if (pendingResolve) {
      const r = pendingResolve;
      pendingResolve = null;
      r(kind);
    } else {
      queue.push(kind);
    }
  };

  const next = (): Promise<SignalKind | null> => {
    if (queue.length > 0) return Promise.resolve(queue.shift()!);
    if (closed) return Promise.resolve(null);
    return new Promise<SignalKind | null>((resolve) => {
      pendingResolve = resolve;
    });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (pendingResolve) {
      const r = pendingResolve;
      pendingResolve = null;
      r(null);
    }
  };

  const controller = new AbortController();
  const onAbort = () => {
    controller.abort();
    close();
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      controller.abort();
      close();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // The only time-based transition the reducer makes is `scheduling-timeout`,
  // which fires when `now() - startedAt > schedulingTimeoutMs` *and* a
  // FailedScheduling event has been observed. A single deadline timer is
  // therefore enough to drive that transition — no need to poll every 5s.
  // Anything earlier is reducer-driven by a fresh pod/sandbox/event signal.
  const deadlineMs = Math.max(0, schedulingTimeoutMs - (now() - startedAt));
  const deadlineTimer = setTimeout(() => push("tick"), deadlineMs + 100);

  // Resolved to the actual pod name when watchPod first observes the pod.
  // For cold-start the pod name equals claimName; for warm-pool adoption the
  // operator binds a pool pod whose generated name differs from the claim.
  // watchEvents needs the real pod name so its involvedObject.name fieldSelector
  // hits the right events.
  let resolvePodName!: (name: string) => void;
  const podNamePromise = new Promise<string>((r) => {
    resolvePodName = r;
  });

  // Run watches concurrently. They each push signals into the queue and
  // never throw out of the watch loop — closure is via `controller.abort()`.
  const watches = Promise.allSettled([
    watchPod(
      opts.kc,
      opts.namespace,
      opts.claimName,
      controller.signal,
      state,
      push,
      now,
      resolvePodName,
    ),
    watchSandbox(
      opts.kc,
      opts.namespace,
      opts.claimName,
      controller.signal,
      state,
      push,
    ),
    watchEvents(
      opts.kc,
      opts.namespace,
      opts.claimName,
      podNamePromise,
      controller.signal,
      state,
      push,
      now,
    ),
  ]);

  try {
    let lastEmittedKey: string | null = null;
    // Monotonic floor: track the highest non-terminal phase we've emitted so
    // we don't regress on transient observations (e.g. a container that
    // briefly enters `terminated` state between restarts has no waiting
    // reason and no `running` flag, which would otherwise reduce to
    // `claiming`). Terminal phases bypass the floor — `failed` must always
    // be emitted regardless of prior progress.
    let highestRank = -1;

    // Emit an initial phase immediately so the caller sees something even
    // before the first watch event lands.
    const initial = derivePhase(state, schedulingTimeoutMs, now);
    lastEmittedKey = phaseKey(initial);
    if (!isTerminal(initial)) highestRank = phaseRank(initial);
    yield initial;
    if (isTerminal(initial)) return;

    while (!closed) {
      const signal = await next();
      if (signal === null) break;

      const phase = derivePhase(state, schedulingTimeoutMs, now);
      // Terminal always wins — but only emit once.
      if (isTerminal(phase)) {
        const key = phaseKey(phase);
        if (key !== lastEmittedKey) {
          lastEmittedKey = key;
          yield phase;
        }
        return;
      }
      const rank = phaseRank(phase);
      if (rank < highestRank) continue; // Don't regress.
      const key = phaseKey(phase);
      if (key !== lastEmittedKey) {
        lastEmittedKey = key;
        highestRank = rank;
        yield phase;
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
    controller.abort();
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    close();
    // Don't surface watch errors back to the consumer — the generator's
    // contract is "phases until terminal or close"; transient kube errors
    // are logged inside the watches.
    await watches.catch(() => {});
  }
}

// ---- Phase reducer ----------------------------------------------------------

/**
 * Pure function over the current observed state. Exported for unit tests —
 * the reducer is the part most likely to need behavior tweaks as we learn
 * more about real-cluster failure modes.
 */
export function derivePhase(
  state: State,
  schedulingTimeoutMs: number,
  now: () => number,
): ClaimPhase {
  const { pod, sandbox, events, startedAt } = state;

  // 1. Terminal: Sandbox CR Ready=True is the canonical "claim is up".
  if (sandbox.ready) return { kind: "ready" };

  // 2. Terminal: container is in a stuck waiting state.
  const containerWaitingReason = pod.containerWaitingReason;
  if (
    containerWaitingReason === "ImagePullBackOff" ||
    containerWaitingReason === "ErrImagePull"
  ) {
    return {
      kind: "failed",
      reason: "image-pull-backoff",
      message:
        "Sandbox image failed to download. The cluster may be missing pull credentials or the image tag may not exist.",
    };
  }
  if (containerWaitingReason === "CrashLoopBackOff") {
    return {
      kind: "failed",
      reason: "crash-loop-backoff",
      message:
        "Sandbox crashed during startup and is now in CrashLoopBackOff. Check pod logs.",
    };
  }

  // 3. Terminal: scheduling timed out. Only consider it a timeout if we
  // have observed at least one FailedScheduling event AND we've waited
  // longer than the threshold AND we still don't have a scheduled pod.
  // Without the FailedScheduling guard, a slow PodScheduled=True transition
  // would prematurely surface as a timeout.
  if (
    !pod.scheduled &&
    events.lastFailedSchedulingAt !== undefined &&
    now() - startedAt > schedulingTimeoutMs
  ) {
    return {
      kind: "failed",
      reason: "scheduling-timeout",
      message:
        events.failedSchedulingMessage ??
        `Pod could not be scheduled within ${Math.round(schedulingTimeoutMs / 1000)}s.`,
    };
  }

  // 4. warming-daemon: container is running, just hasn't reached Ready yet.
  if (pod.containerRunning && !pod.containerReady) {
    return { kind: "warming-daemon", since: startedAt };
  }

  // 5. pulling-image: a Pulling event has fired but Pulled hasn't yet.
  // Checked before `starting-container` because it's the more specific signal
  // during the ContainerCreating window — if we know an image pull is in
  // flight, the user wants to see that, not the generic "starting" phase.
  if (events.hasPulling && !events.hasPulled) {
    return { kind: "pulling-image", since: startedAt };
  }

  // 6. starting-container: pod has been scheduled and we're past pulling but
  // the container isn't running yet. Covers three real-cluster sub-states the
  // user-facing UI shouldn't need to distinguish:
  //   - `ContainerCreating` waiting reason (with or without a `Pulled` event;
  //     the event can lag the container-status update, or be absent entirely
  //     when the image is already cached on a fresh node).
  //   - `PodInitializing` waiting reason (init containers / volume mounts).
  //   - Pod scheduled but kubelet hasn't reported any containerStatus yet —
  //     a brief gap that would otherwise fall through to `claiming` and get
  //     pinned by the monotonic floor at the prior `waiting-for-capacity`.
  if (
    containerWaitingReason === "ContainerCreating" ||
    containerWaitingReason === "PodInitializing" ||
    (pod.scheduled && !pod.containerRunning)
  ) {
    return { kind: "starting-container", since: startedAt };
  }

  // 7. waiting-for-capacity: PodScheduled=False with reason Unschedulable,
  // or a recent FailedScheduling. Surface karpenter's `Nominated` target
  // when present so the UI can say "provisioning a new node".
  const isUnschedulable =
    pod.scheduledFalseReason === "Unschedulable" ||
    (events.lastFailedSchedulingAt !== undefined && !pod.scheduled);
  if (isUnschedulable) {
    return {
      kind: "waiting-for-capacity",
      since: startedAt,
      message: events.failedSchedulingMessage ?? pod.scheduledFalseMessage,
      nodeClaim: events.nominatedNodeClaim,
    };
  }

  // 8. Default: claim posted, no informative pod state yet.
  return { kind: "claiming", since: startedAt };
}

function isTerminal(phase: ClaimPhase): boolean {
  return phase.kind === "ready" || phase.kind === "failed";
}

/**
 * Ordinal rank for non-terminal phases. Used by the generator's monotonic
 * floor to suppress transient regressions. Terminal phases are not ranked
 * (the generator handles them separately).
 */
function phaseRank(phase: ClaimPhase): number {
  switch (phase.kind) {
    case "claiming":
      return 0;
    case "waiting-for-capacity":
      return 1;
    case "pulling-image":
      return 2;
    case "starting-container":
      return 3;
    case "warming-daemon":
      return 4;
    case "ready":
    case "failed":
      return 99;
  }
}

/**
 * Stable string key per phase identity. Used to dedupe consecutive identical
 * phases without firing on incidental timestamp churn. `since` is excluded
 * from the key (it's a constant per-stream value), but `message`/`nodeClaim`
 * variants are included so we re-emit when capacity diagnostics change.
 */
function phaseKey(phase: ClaimPhase): string {
  switch (phase.kind) {
    case "claiming":
    case "pulling-image":
    case "starting-container":
    case "warming-daemon":
      return phase.kind;
    case "waiting-for-capacity":
      return `waiting-for-capacity:${phase.message ?? ""}:${phase.nodeClaim ?? ""}`;
    case "ready":
      return "ready";
    case "failed":
      return `failed:${phase.reason}:${phase.message}`;
  }
}

// ---- Watch loops ------------------------------------------------------------

interface PodResource {
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
  };
  status?: {
    conditions?: Array<{
      type?: string;
      status?: string;
      reason?: string;
      message?: string;
    }>;
    containerStatuses?: Array<{
      name?: string;
      ready?: boolean;
      state?: {
        waiting?: { reason?: string; message?: string };
        running?: { startedAt?: string };
        terminated?: { reason?: string };
      };
    }>;
  };
}

interface KubeEvent {
  reason?: string;
  message?: string;
  type?: "Normal" | "Warning";
  lastTimestamp?: string;
  eventTime?: string;
  involvedObject?: {
    kind?: string;
    name?: string;
    namespace?: string;
  };
}

interface WatchEnvelope<T> {
  type: "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK" | "ERROR";
  object: T;
}

async function watchPod(
  kc: KubeConfig,
  namespace: string,
  claimName: string,
  signal: AbortSignal,
  state: State,
  push: (k: SignalKind) => void,
  now: () => number,
  onPodName: (name: string) => void,
): Promise<void> {
  // labelSelector pins to mesh-managed claims; fieldSelector by name is
  // belt-and-suspenders (operator names pod after the claim).
  const path =
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods` +
    `?watch=true&labelSelector=${encodeURIComponent(`${SANDBOX_HANDLE_LABEL}=${claimName}`)}`;

  return runWatch<PodResource>({
    kc,
    path,
    signal,
    label: `pod/${claimName}`,
    onEvent: (envelope) => {
      if (envelope.type !== "ADDED" && envelope.type !== "MODIFIED") return;
      // No name-equality guard: in warm-pool mode the adopted pod's name
      // is the pool pod's generated name (e.g. `studio-sandbox-kind-abcde`),
      // not the claim handle. The labelSelector above already pins to the
      // pod the operator stamped with `sandbox-handle=<claimName>`, so the
      // first match IS the right pod regardless of its name.
      const pod = envelope.object;
      if (pod.metadata?.name) onPodName(pod.metadata.name);
      applyPodSnapshot(pod, state, now);
      push("pod");
    },
  });
}

function applyPodSnapshot(pod: PodResource, state: State, _now: () => number) {
  const conditions = pod.status?.conditions ?? [];
  const scheduled = conditions.find((c) => c.type === "PodScheduled");
  if (scheduled?.status === "True") {
    state.pod.scheduled = true;
    state.pod.scheduledFalseReason = undefined;
    state.pod.scheduledFalseMessage = undefined;
  } else if (scheduled?.status === "False") {
    state.pod.scheduled = false;
    state.pod.scheduledFalseReason = scheduled.reason;
    state.pod.scheduledFalseMessage = scheduled.message;
  }

  const main = (pod.status?.containerStatuses ?? []).find(
    (c) => c.name === MAIN_CONTAINER_NAME,
  );
  if (main) {
    state.pod.containerWaitingReason = main.state?.waiting?.reason;
    state.pod.containerRunning = !!main.state?.running;
    state.pod.containerReady = main.ready === true;
  }
}

async function watchSandbox(
  kc: KubeConfig,
  namespace: string,
  claimName: string,
  signal: AbortSignal,
  state: State,
  push: (k: SignalKind) => void,
): Promise<void> {
  const path =
    `/apis/${K8S_CONSTANTS.CLAIM_API_GROUP}/${K8S_CONSTANTS.CLAIM_API_VERSION}` +
    `/namespaces/${encodeURIComponent(namespace)}/${K8S_CONSTANTS.CLAIM_PLURAL}` +
    `?watch=true&fieldSelector=${encodeURIComponent(`metadata.name=${claimName}`)}`;

  return runWatch<SandboxResource>({
    kc,
    path,
    signal,
    label: `sandboxclaim/${claimName}`,
    onEvent: (envelope) => {
      if (envelope.type !== "ADDED" && envelope.type !== "MODIFIED") return;
      const claim = envelope.object;
      const ready = claim.status?.conditions?.find((c) => c.type === "Ready");
      if (!ready) return;
      if (ready.status === "True") {
        state.sandbox.ready = true;
        state.sandbox.notReadyReason = undefined;
        state.sandbox.notReadyMessage = undefined;
      } else {
        state.sandbox.ready = false;
        state.sandbox.notReadyReason = ready.reason;
        state.sandbox.notReadyMessage = ready.message;
      }
      push("sandbox");
    },
  });
}

async function watchEvents(
  kc: KubeConfig,
  namespace: string,
  claimName: string,
  podNamePromise: Promise<string>,
  signal: AbortSignal,
  state: State,
  push: (k: SignalKind) => void,
  now: () => number,
): Promise<void> {
  // Resolve the actual pod name before subscribing to events. For cold-start
  // the pod name equals claimName so this is a no-op; for warm-pool adoption
  // the operator binds a pool pod whose name differs from the claim handle,
  // and involvedObject.name must match the real pod name to receive events.
  // Falls back to claimName if the signal aborts before a pod is seen.
  const podName = await Promise.race([
    podNamePromise,
    new Promise<string>((resolve) => {
      if (signal.aborted) {
        resolve(claimName);
        return;
      }
      signal.addEventListener("abort", () => resolve(claimName), {
        once: true,
      });
    }),
  ]);

  if (signal.aborted) return;

  const path =
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/events` +
    `?watch=true&fieldSelector=${encodeURIComponent(
      `involvedObject.name=${podName},involvedObject.kind=Pod`,
    )}`;

  return runWatch<KubeEvent>({
    kc,
    path,
    signal,
    label: `events/${claimName}`,
    onEvent: (envelope) => {
      if (envelope.type !== "ADDED" && envelope.type !== "MODIFIED") return;
      const event = envelope.object;
      const reason = event.reason;
      if (!reason) return;
      switch (reason) {
        case "Pulling":
          state.events.hasPulling = true;
          break;
        case "Pulled":
          state.events.hasPulling = true;
          state.events.hasPulled = true;
          break;
        case "FailedScheduling":
          state.events.lastFailedSchedulingAt = now();
          state.events.failedSchedulingMessage = event.message;
          break;
        case "Nominated": {
          // Karpenter message form:
          //   "Pod should schedule on: nodeclaim/sandbox-fr6gf"
          // Best-effort parse — when the format drifts we just lose the
          // optional nodeClaim sub-message, the phase still progresses.
          const match = event.message?.match(/nodeclaim\/([\w-]+)/);
          if (match) state.events.nominatedNodeClaim = match[1];
          break;
        }
        default:
          return;
      }
      push("event");
    },
  });
}

interface RunWatchOpts<T> {
  kc: KubeConfig;
  path: string;
  signal: AbortSignal;
  label: string;
  onEvent: (envelope: WatchEnvelope<T>) => void;
}

/**
 * Watch loop with reconnect. K8s watch streams close on their own (300s
 * timeout, control-plane upgrade) — we re-establish until the abort signal
 * fires. Reconnect uses exponential backoff to avoid hammering the API
 * server during a control-plane outage.
 *
 * Errors are logged and swallowed: the generator's contract is to keep
 * yielding phases as long as it can; a transient watch failure shouldn't
 * tear down the user-facing SSE.
 */
async function runWatch<T>(opts: RunWatchOpts<T>): Promise<void> {
  const { kc, path, signal, label, onEvent } = opts;
  let attempt = 0;
  while (!signal.aborted) {
    try {
      const resp = await kubeFetch(kc, {
        method: "GET",
        path,
        signal,
        headers: { accept: "application/json" },
      });
      if (!resp.ok || !resp.body) {
        // Drain body before throwing so the connection can be reused.
        try {
          await resp.body?.cancel();
        } catch {
          /* ignore */
        }
        throw new Error(
          `watch handshake failed: ${resp.status} ${resp.statusText}`,
        );
      }
      attempt = 0;
      for await (const envelope of readNdJson<WatchEnvelope<T>>(resp.body)) {
        if (signal.aborted) return;
        try {
          onEvent(envelope);
        } catch (err) {
          // A bad event shouldn't crash the watch.
          console.warn(
            `[lifecycle-watcher] ${label} onEvent threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[lifecycle-watcher] ${label} watch ended: ${msg}`);
    }
    if (signal.aborted) return;
    // Backoff: 250ms, 500ms, 1s, 2s, capped at 5s.
    const delayMs = Math.min(250 * 2 ** attempt, 5_000);
    attempt += 1;
    await sleep(delayMs, signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
