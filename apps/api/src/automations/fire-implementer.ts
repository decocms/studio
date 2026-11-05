/**
 * A run of the built-in Implementer someone asked for: Run on a card (a
 * delegation), Re-run, a card created or imported for the Super Agent, a
 * retry, a conflict fix. It goes through the automation fire workflow like
 * the Implementer's own fires, as a manual fire: it runs even when the
 * Implementer is off, past the column gates, with the caller's run options.
 *
 * From a request, the fire runs off the queue and its error comes back to the
 * caller, so a refusal still reaches the person who clicked. From inside a
 * workflow or step (an agent's tool call), it is enqueued and its outcome is
 * not waited for.
 */

import { randomUUID } from "node:crypto";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import type { StudioContext } from "@/core/studio-context";
import { getUserId } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import { ensureBuiltinAutomations, IMPLEMENTER_SYSTEM_KEY } from "./builtin";
import type { ManualRun } from "./card-run";
import { enqueueAutomationFire, fireAutomationDirect } from "./dbos-sync";
import type { FireAutomationContext } from "./dbos-workflow";

/** The org's Implementer and its trigger; seeds it when the org has none
 *  yet, so a Run never depends on the boot seed having reached the org. */
async function implementerOf(
  ctx: StudioContext,
  item: TaskBoardItem,
): Promise<{ automationId: string; triggerId: string }> {
  const found = await ctx.storage.automations.findBuiltinTrigger(
    item.organizationId,
    IMPLEMENTER_SYSTEM_KEY,
  );
  if (found) return found;
  await ensureBuiltinAutomations(ctx.db, {
    id: item.organizationId,
    createdBy: getUserId(ctx) ?? item.createdBy,
  });
  const seeded = await ctx.storage.automations.findBuiltinTrigger(
    item.organizationId,
    IMPLEMENTER_SYSTEM_KEY,
  );
  if (!seeded) throw new Error("This organization has no Implementer");
  return seeded;
}

/** Start the Implementer on `item`, which the caller already put in its
 *  lane and handed to the agent. Throws the run's refusal when it waits. */
export async function fireImplementer(
  ctx: StudioContext,
  item: TaskBoardItem,
  run: ManualRun = {},
): Promise<void> {
  const { automationId, triggerId } = await implementerOf(ctx, item);
  const eventKey = `manual:${randomUUID()}`;
  const fire: FireAutomationContext = {
    automationId,
    organizationId: item.organizationId,
    triggerId,
    target: {
      kind: "card",
      itemId: item.id,
      columnKey: item.status,
      eventKey,
      movedBy: getUserId(ctx) ?? null,
      manual: run,
    },
  };
  if (DBOS.isWithinWorkflow()) {
    await enqueueAutomationFire(fire, { idempotencyKey: eventKey });
    return;
  }
  const outcome = await fireAutomationDirect(fire, {
    idempotencyKey: eventKey,
  });
  if ("skipped" in outcome && outcome.error) {
    throw new Error(outcome.error.message);
  }
}

/**
 * Start the Super Agent on a card just delegated to it. Best-effort: the card
 * is already saved, so a dispatch failure (no model configured, say) must not
 * fail the write that delegated it.
 */
export async function reactToSuperAgentDelegation(
  ctx: StudioContext,
  item: TaskBoardItem,
): Promise<void> {
  if (item.assigneeId !== SUPER_AGENT_ASSIGNEE_ID) return;
  await fireImplementer(ctx, item).catch((err) => {
    console.error("[task-board] Super Agent enqueue failed", err);
  });
}
