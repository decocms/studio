/**
 * Hold a fire until the run working its card ends, durably.
 *
 * A run's last step is often moving its card or Jira issue on, and that move
 * fires the next automation while the run is still finishing. Fired at once,
 * the board skips the card as busy, and a Jira fire stops the run mid-report.
 * So the producer hands such a fire here instead: the workflow checks the card
 * between durable sleeps and enqueues the fire once no run is live, or when
 * the wait runs out. The fire's own gates still decide whether it runs.
 */

import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { LIVE_RUN_WAITS_QUEUE } from "@/dispatch-queue/queue-names";
import type { TaskBoardStorage } from "@/storage/task-board";
import { hasLiveRun } from "./card-run";
import type { FireAutomationContext } from "./dbos-workflow";

/** Between checks of the card. */
const POLL_MS = 15_000;
/** Ten minutes of checks; a run still live after that gets the fire anyway. */
const MAX_CHECKS = 40;

const WORKFLOW_NAME = "durableAwaitLiveRunThenFire";

interface AwaitLiveRunInput {
  fire: FireAutomationContext;
  /** The card, or the anchor card of a Jira issue. */
  itemId: string;
  idempotencyKey: string;
}

export interface AwaitLiveRunRuntime {
  taskBoard: Pick<TaskBoardStorage, "getById">;
  /** Hand the fire to the automation fire workflow (`enqueueAutomationFire`). */
  fire: (
    ctx: FireAutomationContext,
    opts: { idempotencyKey: string },
  ) => Promise<void>;
  systemDatabaseUrl: string;
}

let runtime: AwaitLiveRunRuntime | null = null;

/** Set at boot. Unset (scripts and tests that never boot the app), a waiting
 *  fire is handed over at once. */
export function setAwaitLiveRunRuntime(rt: AwaitLiveRunRuntime): void {
  runtime = rt;
}

/** Whether a run still works the item. A card that is gone has none. */
export async function itemHasLiveRun(
  taskBoard: Pick<TaskBoardStorage, "getById">,
  itemId: string,
  organizationId: string,
): Promise<boolean> {
  const item = await taskBoard.getById(itemId, organizationId);
  return item !== null && hasLiveRun(item);
}

async function liveRunStep(input: AwaitLiveRunInput): Promise<boolean> {
  if (!runtime) return false;
  return await itemHasLiveRun(
    runtime.taskBoard,
    input.itemId,
    input.fire.organizationId,
  );
}

async function fireStep(input: AwaitLiveRunInput): Promise<void> {
  if (!runtime) return;
  await runtime.fire(input.fire, { idempotencyKey: input.idempotencyKey });
}

async function durableAwaitLiveRunThenFireFn(
  input: AwaitLiveRunInput,
): Promise<void> {
  for (let check = 0; check < MAX_CHECKS; check++) {
    const live = await DBOS.runStep(() => liveRunStep(input), {
      name: "liveRun",
    });
    if (!live) break;
    await DBOS.sleep(POLL_MS);
  }
  await DBOS.runStep(() => fireStep(input), { name: "fire" });
}

let registered: typeof durableAwaitLiveRunThenFireFn | null = null;

/**
 * Fire once no run works `itemId`. Producers call it from workflow steps, where
 * the in-process API would refuse to start a workflow, so the queue row is
 * written through a client there. Keyed by the fire's idempotency key, so a
 * move handed over twice waits once.
 */
export async function durableAwaitLiveRunThenFire(
  fire: FireAutomationContext,
  opts: { itemId: string; idempotencyKey: string },
): Promise<void> {
  const rt = runtime;
  if (!rt || !registered) {
    await rt?.fire(fire, { idempotencyKey: opts.idempotencyKey });
    return;
  }
  const input: AwaitLiveRunInput = { fire, ...opts };
  const workflowID = `await-live-run:${fire.automationId}:${opts.idempotencyKey}`;
  if (!DBOS.isWithinWorkflow()) {
    await DBOS.startWorkflow(registered, {
      workflowID,
      queueName: LIVE_RUN_WAITS_QUEUE,
    })(input);
    return;
  }
  const client = await DBOSClient.create({
    systemDatabaseUrl: rt.systemDatabaseUrl,
    systemDatabaseSchemaName: "dbos",
    systemDatabasePoolSize: 1,
  });
  try {
    await client.enqueue<typeof durableAwaitLiveRunThenFireFn>(
      {
        workflowName: WORKFLOW_NAME,
        queueName: LIVE_RUN_WAITS_QUEUE,
        workflowID,
      },
      input,
    );
  } finally {
    await client.destroy();
  }
}

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
 * step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerAwaitLiveRunWorkflow(): void {
  if (registered) return;
  registered = DBOS.registerWorkflow(durableAwaitLiveRunThenFireFn, {
    name: WORKFLOW_NAME,
  });
}
