import type { StudioContext } from "@/core/studio-context";

/** Throws unless the org has turned the task board on in settings. */
export async function requireTaskBoardEnabled(
  ctx: StudioContext,
  organizationId: string,
): Promise<void> {
  const settings = await ctx.storage.organizationSettings.get(organizationId);
  if (!settings?.task_board_enabled) {
    throw new Error("Task board is not enabled for this organization");
  }
}
