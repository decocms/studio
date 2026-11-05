/**
 * Decides which `board_column_transition` triggers (see
 * `board-column-transition.ts`) fire on settled moves: one move once its
 * settle wait ends, or every recent move in the safety-net sweep
 * (`board-column-transition-workflows.ts`). A fire is handed to the
 * automation fire workflow with the card as its target, which runs it there
 * (`card-run.ts`).
 *
 * Both paths can see the same move, and so can two replicas; each fire is
 * claimed in `automation_trigger_fires` before it is handed over, which is
 * what lets exactly one of them run it.
 */

import type { AutomationsStorage } from "@/storage/automations";
import type { TaskBoardStorage } from "@/storage/task-board";
import type { Automation, AutomationTrigger } from "@/storage/types";
import {
  restedOrigin,
  SETTLE_MS,
  transitionMatches,
} from "./board-column-transition";
import { itemHasLiveRun } from "./await-live-run";
import type { FireAutomationContext } from "./dbos-workflow";

type BoardColumnTrigger = AutomationTrigger & { automation: Automation };

/** How far back the sweep reads. Covers a few missed ticks; a move older
 *  than this that never fired is left alone. */
const LOOKBACK_MS = 30 * 60_000;
/** Moves per sweep, across all orgs. */
const BATCH_SIZE = 200;

export interface BoardTransitionDeps {
  automations: AutomationsStorage;
  taskBoard: TaskBoardStorage;
  /** Hand a fire to the automation fire workflow (`enqueueAutomationFire`). */
  fire: (
    ctx: FireAutomationContext,
    opts: { idempotencyKey: string },
  ) => Promise<void>;
  /** Hand it over once no run works the card
   *  (`durableAwaitLiveRunThenFire`). */
  fireAfterLiveRun: (
    ctx: FireAutomationContext,
    opts: { itemId: string; idempotencyKey: string },
  ) => Promise<void>;
}

type SettledMove = Awaited<
  ReturnType<TaskBoardStorage["listSettledTransitions"]>
>[number];

/** Fire the triggers every recent settled move matches. Returns how many
 *  fires it handed over. */
export async function sweepSettledMoves(
  deps: BoardTransitionDeps,
  now: number,
  settleMs = SETTLE_MS,
): Promise<number> {
  return await fireSettledMoves(deps, now, settleMs, {});
}

/** Fire the triggers one move matches, when it is still the card's latest
 *  and has settled. Returns how many fires it handed over. */
export async function settleBoardMove(
  deps: BoardTransitionDeps,
  activityId: string,
  now: number,
  settleMs = SETTLE_MS,
): Promise<number> {
  return await fireSettledMoves(deps, now, settleMs, { activityId });
}

async function fireSettledMoves(
  deps: BoardTransitionDeps,
  now: number,
  settleMs: number,
  filter: { activityId?: string },
): Promise<number> {
  const triggers = await deps.automations.findActiveBoardColumnTriggers();
  if (triggers.length === 0) return 0;
  const byOrg = new Map<string, BoardColumnTrigger[]>();
  for (const trigger of triggers) {
    const org = trigger.automation.organization_id;
    byOrg.set(org, [...(byOrg.get(org) ?? []), trigger]);
  }
  const moves = await deps.taskBoard.listSettledTransitions({
    organizationIds: [...byOrg.keys()],
    since: new Date(now - LOOKBACK_MS),
    settledBefore: new Date(now - settleMs),
    limit: BATCH_SIZE,
    ...filter,
  });

  let fired = 0;
  for (const move of moves) {
    try {
      // A trigger answers the moves made after it existed, not the ones it
      // finds already on the board when it is created.
      const candidates = (byOrg.get(move.organizationId) ?? []).filter(
        (t) =>
          t.column_key === move.to &&
          Date.parse(t.created_at) < Date.parse(move.occurredAt),
      );
      if (candidates.length === 0) continue;
      const from = await originOf(deps.taskBoard, move, settleMs);
      for (const trigger of candidates) {
        if (!transitionMatches(trigger, { from, to: move.to })) continue;
        if (
          !(await deps.automations.claimTriggerFire(
            trigger.id,
            move.activityId,
          ))
        ) {
          continue;
        }
        const fire: FireAutomationContext = {
          automationId: trigger.automation_id,
          organizationId: move.organizationId,
          triggerId: trigger.id,
          target: {
            kind: "card",
            itemId: move.itemId,
            columnKey: move.to,
            eventKey: move.activityId,
            movedBy: move.actorId,
          },
        };
        const idempotencyKey = `board:${trigger.id}:${move.activityId}`;
        // Often the run moved the card itself as its last step; fired now, the
        // card would be skipped as busy.
        if (
          await itemHasLiveRun(deps.taskBoard, move.itemId, move.organizationId)
        ) {
          await deps.fireAfterLiveRun(fire, {
            itemId: move.itemId,
            idempotencyKey,
          });
        } else {
          await deps.fire(fire, { idempotencyKey });
        }
        fired++;
      }
    } catch (err) {
      console.error(
        `[automations] board transition ${move.activityId} failed`,
        err,
      );
    }
  }
  return fired;
}

/** The column the card rested in before the move, which is what a trigger's
 *  `from` is about. */
async function originOf(
  taskBoard: TaskBoardStorage,
  move: SettledMove,
  settleMs: number,
): Promise<string | null> {
  const activity = await taskBoard.listActivity(
    move.itemId,
    move.organizationId,
  );
  const moves = activity.flatMap((entry) => {
    const data = entry.data as { from?: unknown; to?: unknown } | null;
    if (entry.action !== "status_changed" || typeof data?.to !== "string") {
      return [];
    }
    const from = typeof data.from === "string" ? data.from : null;
    return from === data.to
      ? []
      : [{ from, to: data.to, occurredAt: entry.occurredAt }];
  });
  return moves.length > 0 ? restedOrigin(moves, settleMs) : move.from;
}
