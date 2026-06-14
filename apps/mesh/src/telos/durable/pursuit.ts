import { onboardingDomain } from "@/telos/domain";
import { resolvePursuitModel } from "@/telos/model";
import type { OnboardingTarget } from "@/telos/target";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { type DomainEvent, Eudaimon, type EventBus } from "@decocms/telos";
import { adaptiveDeliberator } from "../capabilities/deliberator";
import { telosBus } from "./bus";
import { TELOS_QUEUE } from "./queue";
import { requireTelosRuntime } from "./runtime";

// One pursuit cycle for an org: observe the world, measure the gap, deliberate
// (AI when a model is configured, deterministic otherwise), act. The package's
// in-process pursuit events are bridged onto mesh's durable bus; we surface the
// lifecycle moment mesh cares about (the goal reached) and drop the rest. The
// returned `reached` lets the caller stop the recurring schedule once the gap
// closes — the striver arrives at its telos and rests.
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

const PURSUIT_SCHEDULE_PREFIX = "telos-pursuit-";
// Daily, off-peak. The schedule self-deletes once the goal is reached, so it
// only fires while a gap remains; per-org ticks share the telos queue's flow
// control, so a common time is fine.
const PURSUIT_CRON = "23 4 * * *";

function pursuitScheduleName(organizationId: string): string {
  return `${PURSUIT_SCHEDULE_PREFIX}${organizationId}`;
}

// Each scheduled tick re-pursues; reaching the goal removes the schedule, so a
// flourishing org stops costing cycles.
async function pursuitScheduleFn(
  _scheduledTime: Date,
  organizationId: string,
): Promise<void> {
  const { reached } = await DBOS.runStep(
    () => runPursuitCycle(organizationId),
    { name: "telos.pursuit:cycle" },
  );
  if (reached) {
    await DBOS.runStep(() => deleteTelosPursuitSchedule(organizationId), {
      name: "telos.pursuit:rest",
    });
  }
}

let pursuitScheduleWf:
  | ((scheduledTime: Date, organizationId: string) => Promise<void>)
  | null = null;
let registered = false;

// Must run BEFORE DBOS.launch(). Guarded so HMR repeats don't re-register.
export function registerPursuitWorkflows(): void {
  if (registered) return;
  registered = true;
  pursuitScheduleWf = DBOS.registerWorkflow(pursuitScheduleFn, {
    name: "telos.pursuit.schedule",
  });
}

// Install the recurring pursuit schedule for an org (no-op if it already
// exists). Ticks run on the telos queue, under the same flow control as fires.
export async function ensureTelosPursuitSchedule(
  organizationId: string,
): Promise<void> {
  if (!pursuitScheduleWf) {
    throw new Error(
      "[telos] pursuit workflows not registered — registerPursuitWorkflows() must run before DBOS.launch()",
    );
  }
  const name = pursuitScheduleName(organizationId);
  const existing = await DBOS.getSchedule(name);
  if (existing) return;
  try {
    await DBOS.createSchedule({
      scheduleName: name,
      workflowFn: pursuitScheduleWf,
      schedule: PURSUIT_CRON,
      context: organizationId,
      options: { queueName: TELOS_QUEUE },
    });
  } catch (err) {
    // Lost a create race with a concurrent installer — the schedule now exists,
    // which is all we wanted.
    console.warn(
      `[telos] ensure pursuit schedule for ${organizationId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// Stop pursuing: remove the recurring schedule. Safe to call when none exists.
export async function deleteTelosPursuitSchedule(
  organizationId: string,
): Promise<void> {
  try {
    await DBOS.deleteSchedule(pursuitScheduleName(organizationId));
  } catch (err) {
    // Already gone (or never created) — rest is the desired state anyway.
    console.warn(
      `[telos] delete pursuit schedule for ${organizationId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
