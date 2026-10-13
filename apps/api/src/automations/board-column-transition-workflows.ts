/**
 * The two durable halves of the `board_column_transition` trigger, in the
 * shape of the Jira trigger's (`jira/dbos-jira-trigger-sweep.ts`).
 *
 * The settle wait: a lane move into a column some active trigger watches
 * starts a workflow that sleeps through the settle window, then fires on the
 * move if it is still the card's latest. A durable sleep, so a pod restarting
 * mid-wait resumes it; keyed by the activity row, so the move is waited on
 * once.
 *
 * The safety net: every five minutes, fire on every recent settled move. A
 * wait that was never enqueued (the listener failed, or the move was logged
 * by a pod that had not set it) costs latency instead of a missed run; the
 * per-move claim makes the overlap free.
 */

import { DBOS, DBOSClient, SchedulerMode } from "@dbos-inc/dbos-sdk";
import { BOARD_TRANSITIONS_QUEUE } from "@/dispatch-queue/queue-names";
import type { BoardMove } from "@/storage/task-board";
import { SETTLE_MS } from "./board-column-transition";
import {
  type BoardTransitionDeps,
  settleBoardMove,
  sweepSettledMoves,
} from "./board-column-transition-fire";

/** Every five minutes. */
const SWEEP_CRONTAB = "*/5 * * * *";

/** Past the settle window, so the move reads as settled when this pod's clock
 *  runs a little behind the one that logged it. */
const CLOCK_SKEW_MS = 2_000;

export interface BoardTransitionRuntime extends BoardTransitionDeps {
  systemDatabaseUrl: string;
  settleMs: number;
}

let runtime: BoardTransitionRuntime | null = null;

/** Set at boot when BOARD_TRANSITION_TRIGGERS_ENABLED is on. Unset, both
 *  workflows do nothing, so a wait enqueued before the flag was turned off
 *  ends quietly. */
export function setBoardTransitionRuntime(rt: BoardTransitionRuntime): void {
  runtime = rt;
}

/** The step body must never throw. */
async function settleStep(activityId: string): Promise<number> {
  if (!runtime) return 0;
  try {
    return await settleBoardMove(
      runtime,
      activityId,
      Date.now(),
      runtime.settleMs,
    );
  } catch (err) {
    console.error(
      `[automations] settling board move ${activityId} failed`,
      err,
    );
    return 0;
  }
}

async function sweepStep(): Promise<number> {
  if (!runtime) return 0;
  try {
    return await sweepSettledMoves(runtime, Date.now(), runtime.settleMs);
  } catch (err) {
    console.error("[automations] board transition sweep failed", err);
    return 0;
  }
}

async function boardTransitionSettleWorkflowFn(
  activityId: string,
): Promise<void> {
  await DBOS.sleep((runtime?.settleMs ?? SETTLE_MS) + CLOCK_SKEW_MS);
  await DBOS.runStep(() => settleStep(activityId), {
    name: "settleBoardMove",
  });
}

async function boardTransitionSweepWorkflowFn(
  _scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  const fired = await DBOS.runStep(() => sweepStep(), {
    name: "sweepBoardMoves",
  });
  if (fired > 0) {
    console.log(
      `[automations] board transition sweep started ${fired} run(s) the settle wait missed`,
    );
  }
}

const SETTLE_WORKFLOW_NAME = "boardTransitionSettleWorkflow";
let registeredSettle: typeof boardTransitionSettleWorkflowFn | null = null;

/**
 * Start the settle wait for `move` when a trigger in its org watches the
 * column it entered. Moves are logged from request handlers and from inside
 * DBOS workflows and steps (a run's terminal hook opens a review); inside one,
 * the in-process API would either refuse (`startWorkflow` from a step) or
 * record a child in the caller's step sequence, so the queue row is written
 * through a client instead.
 */
export async function onBoardMove(move: BoardMove): Promise<void> {
  const rt = runtime;
  if (!rt || !registeredSettle) return;
  if (
    !(await rt.automations.hasActiveBoardColumnTrigger(
      move.taskBoardItemId,
      move.to,
    ))
  ) {
    return;
  }
  const workflowID = `board-settle:${move.activityId}`;
  if (!DBOS.isWithinWorkflow()) {
    await DBOS.startWorkflow(registeredSettle, {
      workflowID,
      queueName: BOARD_TRANSITIONS_QUEUE,
    })(move.activityId);
    return;
  }
  const client = await DBOSClient.create({
    systemDatabaseUrl: rt.systemDatabaseUrl,
    systemDatabaseSchemaName: "dbos",
    systemDatabasePoolSize: 1,
  });
  try {
    await client.enqueue<typeof boardTransitionSettleWorkflowFn>(
      {
        workflowName: SETTLE_WORKFLOW_NAME,
        queueName: BOARD_TRANSITIONS_QUEUE,
        workflowID,
      },
      move.activityId,
    );
  } finally {
    await client.destroy();
  }
}

let registeredSweep: typeof boardTransitionSweepWorkflowFn | null = null;

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflows. Changing their STEP SEQUENCE (add/remove/reorder
 * a step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerBoardTransitionWorkflows(): void {
  if (registeredSweep) return;
  registeredSettle = DBOS.registerWorkflow(boardTransitionSettleWorkflowFn, {
    name: SETTLE_WORKFLOW_NAME,
  });
  registeredSweep = DBOS.registerWorkflow(boardTransitionSweepWorkflowFn, {
    name: "boardTransitionSweepWorkflow",
  });
  DBOS.registerScheduled(registeredSweep, {
    name: "boardTransitionSweepWorkflow",
    crontab: SWEEP_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
