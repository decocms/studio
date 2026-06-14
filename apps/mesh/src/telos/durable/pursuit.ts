import { onboardingDomain, type OnboardingState } from "@/telos/domain";
import { resolvePursuitModel } from "@/telos/model";
import type { OnboardingTarget } from "@/telos/target";
import { DBOS, Debouncer } from "@dbos-inc/dbos-sdk";
import { type DomainEvent, Eudaimon, type EventBus } from "@decocms/telos";
import { adaptiveDeliberator } from "../capabilities/deliberator";
import { telosBus } from "./bus";
import { telosSalt } from "./dev-salt";
import { TELOS_QUEUE } from "./queue";
import { requireTelosRuntime } from "./runtime";

// The agent's latest recommended next step for an org — captured from the cycle's
// suggestion so the UI can surface it (SSE is ephemeral; this survives a reload
// within the pod). Single-pod cache; persist if it must cross pods.
export interface PursuitSuggestion {
  kind: string;
  reason?: string;
  version: number;
}
const latestSuggestion = new Map<string, PursuitSuggestion>();
export function getLatestSuggestion(
  organizationId: string,
): PursuitSuggestion | null {
  return latestSuggestion.get(organizationId) ?? null;
}

// Last observed (goal version + metrics) per org — the diff-gate's memory. A cycle
// whose goal AND observed world are unchanged skips deliberation (no model call),
// so activity noise and idle ticks are cheap. Keyed on version too, so a new goal
// (e.g. a progression rung) always deliberates even if the metrics haven't moved.
// In-memory: after a restart the first cycle just deliberates once (treated as new).
const lastObserved = new Map<string, { version: number; sig: string }>();

// A stable signature of the observed world, for diff-gating.
const sigOf = (state: OnboardingState): string =>
  [...state.connectedTools].sort().join("|");

const readReason = (payload: unknown): string | undefined => {
  if (payload && typeof payload === "object" && "reason" in payload) {
    const reason = (payload as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : undefined;
  }
  return undefined;
};

// The shape a cycle reports back so the loop can decide what to do next.
export interface PursuitOutcome {
  reached: boolean;
  // No installed goal — nothing to pursue; the loop must not re-arm.
  noGoal?: boolean;
  // Did the observed world move since the last cycle? Drives diff-gating + cadence.
  changed?: boolean;
  // The agent's advisory pause before the next cycle, if it decided one.
  sleepMs?: number;
}

// One pursuit cycle for an org: observe the world, and only when it has moved,
// deliberate (AI when a model is configured, deterministic otherwise) and act.
// The package's in-process pursuit events are bridged onto mesh's durable bus; we
// surface what mesh cares about — goal reached, the recommended next step — and
// drop the rest. The returned outcome lets the loop rest, re-arm, or stop.
export async function runPursuitCycle(
  organizationId: string,
): Promise<PursuitOutcome> {
  const runtime = requireTelosRuntime();
  const domain = onboardingDomain(runtime.db);

  // No goal yet (e.g. an activity pull for an org mid-onboarding) → nothing to do.
  let mover: Awaited<ReturnType<typeof runtime.store.ledger.latest>>;
  try {
    mover = await runtime.store.ledger.latest(organizationId);
  } catch {
    return { reached: false, noGoal: true };
  }

  const state = await domain.observe(organizationId);

  const sig = sigOf(state);

  if (domain.satisfied(state, mover.target)) {
    lastObserved.set(organizationId, { version: mover.version, sig });
    await telosBus.publish({
      type: "goal.reached",
      organizationId,
      version: mover.version,
    });
    return { reached: true };
  }

  // Diff-gate: only spend deliberation when the goal or the connected tools
  // actually moved. Unchanged cycles re-arm cheaply with no model call.
  const prev = lastObserved.get(organizationId);
  const changed = !prev || prev.version !== mover.version || prev.sig !== sig;
  lastObserved.set(organizationId, { version: mover.version, sig });
  if (!changed) return { reached: false, changed: false };

  let reached = false;
  let sleepMs: number | undefined;

  const bus: EventBus<OnboardingTarget> = {
    async publish(event: DomainEvent<OnboardingTarget>) {
      if (event.type === "unmovedMover.reached") {
        reached = true;
        await telosBus.publish({
          type: "goal.reached",
          organizationId,
          version: event.moverVersion,
        });
      } else if (event.type === "eudaimon.action.suggested") {
        const reason = readReason(event.payload);
        latestSuggestion.set(organizationId, {
          kind: event.kind,
          reason,
          version: event.moverVersion,
        });
        await telosBus.publish({
          type: "goal.suggestion",
          organizationId,
          version: event.moverVersion,
          kind: event.kind,
          reason,
        });
      } else if (event.type === "eudaimon.pursued") {
        sleepMs = event.nextReviewMs;
      }
    },
    subscribe() {},
  };

  const eudaimon = new Eudaimon({
    tenant: organizationId,
    ledger: runtime.store.ledger,
    domain,
    bus,
    deliberator: adaptiveDeliberator({ resolveModel: resolvePursuitModel }),
  });
  await eudaimon.pursue();

  return { reached, changed: true, sleepMs };
}

// === The pursuit schedule: a self-re-arming debounced loop ===
//
// DBOS gives us a debouncer; we don't need a schedules table. Each cycle re-arms
// the next one after a dynamic delay clamped to [MIN, MAX]; reaching the goal
// simply stops the re-arm (the striver rests). Event triggers debounce the SAME
// key to pull the next cycle sooner, coalescing with the scheduled tick — so a
// goal runs at least on its cadence AND promptly on relevant events, never twice
// at once. "Many schedules" = more keys; "always ≥1 basic" = ensure the basic key.

const HOUR_MS = 60 * 60 * 1000;
const positiveMs = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Cadence bounds. Configurable in code now (env overrides), runtime later. MAX
// also caps the debounce deadline, so a live loop fires within MAX of its arm
// even under a stream of event triggers.
const PURSUIT_MIN_MS = positiveMs(process.env.TELOS_PURSUIT_MIN_MS, HOUR_MS);
const PURSUIT_MAX_MS = Math.max(
  PURSUIT_MIN_MS,
  positiveMs(process.env.TELOS_PURSUIT_MAX_MS, 24 * HOUR_MS),
);
// The revival heartbeat for the safety net (default daily, off-peak).
const PURSUIT_SAFETY_NET_CRON =
  process.env.TELOS_PURSUIT_SAFETY_NET_CRON ?? "23 3 * * *";

const clampDelay = (ms: number): number =>
  Math.min(PURSUIT_MAX_MS, Math.max(PURSUIT_MIN_MS, ms));

const PURSUIT_KEY_PREFIX = "telos:pursuit:";
const pursuitKey = (organizationId: string, kind = "basic"): string =>
  `${PURSUIT_KEY_PREFIX}${organizationId}:${kind}${telosSalt()}`;

// Fallback cadence when the agent doesn't decide one (deterministic cycles, or an
// AI cycle that didn't set nextReviewMinutes). Rests at MAX; events still pull the
// next cycle toward MIN.
const nextPursuitDelayMs = (): number => clampDelay(PURSUIT_MAX_MS);

// Cheap reached-check (observe only, no deliberation) so the safety net doesn't
// wake a resting, already-flourishing goal.
async function isGoalReached(organizationId: string): Promise<boolean> {
  const runtime = requireTelosRuntime();
  const domain = onboardingDomain(runtime.db);
  const mover = await runtime.store.ledger.latest(organizationId);
  const state = await domain.observe(organizationId);
  return domain.satisfied(state, mover.target);
}

// One tick of the loop: pursue, then re-arm the next unless the goal is reached.
// The pause is what the AGENT decided this cycle (clamped to [MIN, MAX]), else the
// fallback cadence. The re-arm is a debounced wait — durable, and an event can cut
// it short by debouncing the same key. debounce() starts a workflow, so it runs in
// the workflow body, never inside a step.
async function pursuitTickFn(organizationId: string): Promise<void> {
  const { reached, noGoal, changed, sleepMs } = await DBOS.runStep(
    () => runPursuitCycle(organizationId),
    { name: "telos.pursuit:cycle" },
  );
  // Reached → rest. No goal → nothing to pursue. Neither re-arms.
  if (reached || noGoal) return;
  // Stay responsive while the world is moving (the agent's pace, or MIN), back off
  // to MAX when idle. Activity pulls (pullPursuit) cut below MIN when the user acts.
  const delay = changed ? (sleepMs ?? PURSUIT_MIN_MS) : PURSUIT_MAX_MS;
  await armPursuit(organizationId, delay);
}

// Safety net: a goal whose loop chain dies (e.g. a tick fails permanently) would
// silently stop being pursued. This re-arms the basic loop for every not-yet-
// reached goal on a heartbeat — cheap insurance that every goal keeps striving.
async function pursuitSafetyNetFn(
  _scheduledTime: Date,
  _startedAt: Date,
): Promise<void> {
  const runtime = requireTelosRuntime();
  const tenants = await DBOS.runStep(
    () => Promise.resolve(runtime.store.ledger.tenants()),
    { name: "telos.pursuit:safety-net-tenants" },
  );
  for (const organizationId of tenants) {
    const reached = await DBOS.runStep(() => isGoalReached(organizationId), {
      name: "telos.pursuit:safety-net-check",
    });
    if (!reached) await armPursuit(organizationId, nextPursuitDelayMs());
  }
}

let pursuitTickWf: ((organizationId: string) => Promise<void>) | null = null;
let pursuitDebouncer: Debouncer<[string], void> | null = null;
let registered = false;

// Must run BEFORE DBOS.launch(). Guarded so HMR repeats don't re-register.
export function registerPursuitWorkflows(): void {
  if (registered) return;
  registered = true;
  pursuitTickWf = DBOS.registerWorkflow(pursuitTickFn, {
    name: "telos.pursuit.tick",
  });
  pursuitDebouncer = new Debouncer<[string], void>({
    workflow: pursuitTickWf,
    // The MAX bound: a live loop fires within this window of its arm.
    debounceTimeoutMs: PURSUIT_MAX_MS,
    // Ticks run on the telos queue, under the same flow control as fires.
    startWorkflowParams: { queueName: TELOS_QUEUE },
  });
  DBOS.registerScheduled(pursuitSafetyNetFn, {
    name: "telos.pursuit.safety-net",
    crontab: PURSUIT_SAFETY_NET_CRON,
    queueName: TELOS_QUEUE,
  });
}

function armPursuit(organizationId: string, delayMs: number): Promise<unknown> {
  if (!pursuitDebouncer) {
    throw new Error(
      "[telos] pursuit workflows not registered — registerPursuitWorkflows() must run before DBOS.launch()",
    );
  }
  return pursuitDebouncer.debounce(
    pursuitKey(organizationId),
    clampDelay(delayMs),
    organizationId,
  );
}

// Ensure the goal's basic pursuit loop is running. Idempotent: the debouncer
// coalesces by key, so re-calling (on goal.installed, from the safety net, or on
// an event) won't fork the loop. Pass a short delay to pull the next cycle sooner
// — this is also the hook for event-triggered pursuit. MUST be called from a
// workflow body, not a step (it starts a workflow).
export function ensureTelosPursuitSchedule(
  organizationId: string,
  delayMs: number = nextPursuitDelayMs(),
): Promise<unknown> {
  return armPursuit(organizationId, delayMs);
}

// The reactive pull: org activity (a state-mutating tool call, a fired automation)
// debounces the SAME pursuit key with a short delay, so a burst of activity
// coalesces into one cycle seconds after it settles. This intentionally bypasses
// the MIN cadence floor — reactivity is the whole point. No-ops if the loop isn't
// registered yet, or for orgs with no goal (the tick guards that). Safe to call
// often and from anywhere (no DBOS context needed beyond a launched runtime).
const PURSUIT_PULL_MS = positiveMs(process.env.TELOS_PURSUIT_PULL_MS, 5_000);
export function pullPursuit(organizationId: string): Promise<unknown> {
  if (!pursuitDebouncer) return Promise.resolve();
  return pursuitDebouncer.debounce(
    pursuitKey(organizationId),
    Math.max(1_000, PURSUIT_PULL_MS),
    organizationId,
  );
}
