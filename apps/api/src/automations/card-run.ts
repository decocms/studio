/**
 * An automation fire that carries a card runs on that card: as the board's
 * own run (`enqueueSuperAgentForTask`), linked to the card, on its repository
 * and pull request, with the board's prompts and tools. The fire workflow
 * takes this branch for any fire with a card target; the trigger only decides
 * when and on which card.
 */

import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import type { StudioContext } from "@/core/studio-context";
import type { Automation } from "@/storage/types";
import { enqueueSuperAgentForTask } from "@/tools/task-board/enqueue-super-agent";
import { emitTaskBoardUpdated } from "@/tools/task-board/run-reactions";
import {
  automationInstruction,
  cardFireFence,
} from "./board-column-transition";
import { IMPLEMENTER_SYSTEM_KEY } from "./builtin";

/** A card a fire runs on: the card, the column the run is for, and the event
 *  that picked it (it keys the run, so a retried fire starts it once). */
export interface CardTarget {
  kind: "card";
  itemId: string;
  columnKey: string;
  eventKey: string;
}

export type CardRunSkip =
  | "card_gone"
  | "moved_on"
  | "busy"
  | "owned"
  | "delegated"
  | "lost_claim"
  | "rejected";

export type CardRunOutcome = { threadId: string } | { skipped: CardRunSkip };

/**
 * Run `automation` on the target card. It skips a card that left the column
 * since, one with a run still going (runs on a card take turns), and one a
 * person owns. An unassigned card is claimed for the agent in the same
 * conditional write that checks its column, so two fires can never both
 * start a run.
 */
export async function runAutomationOnCard(
  ctx: StudioContext,
  automation: Automation,
  triggerId: string,
  target: CardTarget,
): Promise<CardRunOutcome> {
  const item = await ctx.storage.taskBoard.getById(
    target.itemId,
    automation.organization_id,
  );
  if (!item) return { skipped: "card_gone" };
  if (item.status !== target.columnKey) return { skipped: "moved_on" };
  if (
    item.threads.some(
      (t) =>
        t.hasMessages &&
        (t.status === "in_progress" || t.status === "requires_action"),
    )
  ) {
    return { skipped: "busy" };
  }
  if (item.assigneeId && item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID) {
    return { skipped: "owned" };
  }
  // Delegating a card moves it to In Progress and starts its run right away;
  // the implementer is for the cards nobody handed over.
  if (
    automation.system_key === IMPLEMENTER_SYSTEM_KEY &&
    item.assigneeId === SUPER_AGENT_ASSIGNEE_ID
  ) {
    return { skipped: "delegated" };
  }

  let card = item;
  let claimed = false;
  if (!item.assigneeId) {
    const won = await ctx.storage.taskBoard.claimUnassignedForSuperAgent(
      item.id,
      item.organizationId,
      automation.created_by,
      automation.created_by,
      target.columnKey,
    );
    if (!won) return { skipped: "lost_claim" };
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

  const fence = cardFireFence(triggerId, target.eventKey);
  try {
    await enqueueSuperAgentForTask(ctx, card, {
      instruction: automationInstruction(automation.messages) || undefined,
      column: target.columnKey,
      automation: {
        name: automation.name,
        agentId: automation.virtual_mcp_id,
        triggerId,
        fence,
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
    return { skipped: "rejected" };
  }
  return { threadId: fence.threadId };
}
