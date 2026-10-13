/**
 * Fires `board_column_transition` triggers (see `board-column-transition.ts`)
 * on settled moves: one move once its settle wait ends, or every recent move
 * in the safety-net sweep (`board-column-transition-workflows.ts`).
 *
 * Both paths can see the same move, and so can two replicas; each fire is
 * claimed in `automation_trigger_fires` before it starts, which is what lets
 * exactly one of them run it.
 */

import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import type { StudioContextFactory } from "@/automations/fire";
import type { StudioContext } from "@/core/studio-context";
import type { AutomationsStorage } from "@/storage/automations";
import type { TaskBoardStorage } from "@/storage/task-board";
import type {
  Automation,
  AutomationTrigger,
  TaskBoardItem,
} from "@/storage/types";
import { enqueueSuperAgentForTask } from "@/tools/task-board/enqueue-super-agent";
import { emitTaskBoardUpdated } from "@/tools/task-board/run-reactions";
import {
  automationInstruction,
  cardFireFence,
  restedOrigin,
  SETTLE_MS,
  transitionMatches,
} from "./board-column-transition";

type BoardColumnTrigger = AutomationTrigger & { automation: Automation };

type CardFireOutcome =
  | { fired: true }
  | {
      fired: false;
      reason: "moved_on" | "busy" | "owned" | "lost_claim" | "rejected";
    };

/**
 * Run `automation` on the card that entered its trigger's column.
 *
 * The run is a board run (`enqueueSuperAgentForTask`): linked to the card,
 * on the card's repository and pull request, with the board's tools. It
 * skips a card that moved on since, one with a run still going (runs on a
 * card take turns), and one a person owns. An unassigned card is claimed for
 * the agent in the same conditional write that checks its column, so two
 * fires can never both start a run.
 */
async function fireAutomationOnCard(
  ctx: StudioContext,
  trigger: BoardColumnTrigger,
  item: TaskBoardItem,
  eventKey: string,
): Promise<CardFireOutcome> {
  const { automation } = trigger;
  if (item.status !== trigger.column_key) {
    return { fired: false, reason: "moved_on" };
  }
  if (
    item.threads.some(
      (t) =>
        t.hasMessages &&
        (t.status === "in_progress" || t.status === "requires_action"),
    )
  ) {
    return { fired: false, reason: "busy" };
  }
  if (item.assigneeId && item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID) {
    return { fired: false, reason: "owned" };
  }

  let card = item;
  let claimed = false;
  if (!item.assigneeId) {
    const won = await ctx.storage.taskBoard.claimUnassignedForSuperAgent(
      item.id,
      item.organizationId,
      automation.created_by,
      automation.created_by,
      trigger.column_key,
    );
    if (!won) return { fired: false, reason: "lost_claim" };
    card = won;
    claimed = true;
    await ctx.storage.taskBoard
      .recordActivity({
        taskBoardItemId: item.id,
        action: "assignee_changed",
        actorId: null,
        data: { from: null, to: SUPER_AGENT_ASSIGNEE_ID },
      })
      .catch(() => {});
    emitTaskBoardUpdated(item.organizationId, won);
  }

  try {
    await enqueueSuperAgentForTask(ctx, card, {
      instruction: automationInstruction(automation.messages) || undefined,
      column: trigger.column_key,
      automation: {
        name: automation.name,
        agentId: automation.virtual_mcp_id,
        triggerId: trigger.id,
        fence: cardFireFence(trigger.id, eventKey),
      },
    });
  } catch (err) {
    console.warn(
      `[automations] "${automation.name}" on card ${item.id} was not dispatched:`,
      err instanceof Error ? err.message : err,
    );
    if (claimed) {
      const released = await ctx.storage.taskBoard.unassignSuperAgent(
        item.id,
        item.organizationId,
        automation.created_by,
      );
      if (released) emitTaskBoardUpdated(item.organizationId, released);
    }
    return { fired: false, reason: "rejected" };
  }
  await ctx.storage.automations
    .updateTriggerLastRunAt(trigger.id, new Date().toISOString())
    .catch(() => {});
  return { fired: true };
}

/** How far back the sweep reads. Covers a few missed ticks; a move older
 *  than this that never fired is left alone. */
const LOOKBACK_MS = 30 * 60_000;
/** Moves per sweep, across all orgs. */
const BATCH_SIZE = 200;

export interface BoardTransitionDeps {
  automations: AutomationsStorage;
  taskBoard: TaskBoardStorage;
  contextFactory: StudioContextFactory;
}

type SettledMove = Awaited<
  ReturnType<TaskBoardStorage["listSettledTransitions"]>
>[number];

/** Fire the triggers every recent settled move matches. Returns how many
 *  runs it started. */
export async function sweepSettledMoves(
  deps: BoardTransitionDeps,
  now: number,
  settleMs = SETTLE_MS,
): Promise<number> {
  return await fireSettledMoves(deps, now, settleMs, {});
}

/** Fire the triggers one move matches, when it is still the card's latest
 *  and has settled. Returns how many runs it started. */
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
        if (await fire(deps, trigger, move)) fired++;
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

async function fire(
  deps: BoardTransitionDeps,
  trigger: BoardColumnTrigger,
  move: SettledMove,
): Promise<boolean> {
  const ctx = await deps.contextFactory(
    move.organizationId,
    trigger.automation.created_by,
  );
  if (!ctx) {
    console.warn(
      `[automations] "${trigger.automation.name}" skipped: its creator left the org`,
    );
    return false;
  }
  const item = await deps.taskBoard.getById(move.itemId, move.organizationId);
  if (!item) return false;
  const outcome = await fireAutomationOnCard(
    ctx,
    trigger,
    item,
    move.activityId,
  );
  if (!outcome.fired) {
    console.log(
      `[automations] "${trigger.automation.name}" skipped card ${item.id}: ${outcome.reason}`,
    );
  }
  return outcome.fired;
}
