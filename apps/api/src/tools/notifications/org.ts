import type { StudioContext } from "@/core/studio-context";

export function requireOrg(ctx: StudioContext): string {
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    throw new Error(
      "Organization ID required (no active organization in context)",
    );
  }
  return organizationId;
}

/**
 * Resolve a task through the caller's org before touching a subscription.
 *
 * Subscribing is a write that grants future reads of task content, so an
 * ungated write is a cross-tenant leak, not a tidiness concern.
 */
export async function requireTaskInOrg(
  ctx: StudioContext,
  taskBoardItemId: string,
): Promise<string> {
  const organizationId = requireOrg(ctx);
  const item = await ctx.storage.taskBoard.getById(
    taskBoardItemId,
    organizationId,
  );
  if (!item) throw new Error("Task board item not found");
  return organizationId;
}
