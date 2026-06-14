import { onboardingDomain } from "@/telos/domain";
import { resolvePursuitModel } from "@/telos/model";
import type { OnboardingTarget } from "@/telos/target";
import { DBOS, Debouncer } from "@dbos-inc/dbos-sdk";
import { type DomainEvent, Eudaimon, type EventBus } from "@decocms/telos";
import { adaptiveDeliberator } from "../capabilities/deliberator";
import { telosBus } from "./bus";
import { TELOS_QUEUE } from "./queue";
import { requireTelosRuntime } from "./runtime";

// One pursuit cycle for an org: observe the world, measure the gap, deliberate
// (AI when a model is configured, deterministic otherwise), act. The package's
// in-process pursuit events are bridged onto mesh's durable bus; we surface the
// lifecycle moment mesh cares about (the goal reached) and drop the rest. The
// returned `reached` lets the caller stop the recurring loop once the gap closes
// — the striver arrives at its telos and rests.
export async function runPursuitCycle(
  organizationId: string,
): Promise<{ reached: boolean }> {
  const runtime = requireTelosRuntime();
  let reached = false;

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
        await telosBus.publish({
          type: "goal.suggestion",
          organizationId,
          version: event.moverVersion,
          kind: event.kind,
        });
      }
    },
    subscribe() {},
  };

  const eudaimon = new Eudaimon({
    tenant: organizationId,
    ledger: runtime.store.ledger,
    domain: onboardingDomain(runtime.db),
    bus,
    deliberator: adaptiveDeliberator({ resolveModel: resolvePursuitModel }),
  });
  await eudaimon.pursue();

  return { reached };
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
  `${PURSUIT_KEY_PREFIX}${organizationId}:${kind}`;

// The unprompted cadence. Dynamic within [MIN, MAX]; the single seam to evolve
// into an adaptive policy (e.g. faster when close to the goal). For now it rests
// at MAX and lets events pull the next cycle toward MIN.
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
// debounce() starts a workflow, so the re-arm runs in the workflow body — never
// inside a step (steps can't start child workflows).
async function pursuitTickFn(organizationId: string): Promise<void> {
  const { reached } = await DBOS.runStep(
    () => runPursuitCycle(organizationId),
    {
      name: "telos.pursuit:cycle",
    },
  );
  if (!reached) await armPursuit(organizationId, nextPursuitDelayMs());
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
