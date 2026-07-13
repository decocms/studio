import type { StudioContext } from "@/core/studio-context";

/** Throws unless the org has turned the kanban board on in settings. */
export async function requireKanbanEnabled(
  ctx: StudioContext,
  organizationId: string,
): Promise<void> {
  const settings = await ctx.storage.organizationSettings.get(organizationId);
  if (!settings?.kanban_enabled) {
    throw new Error("Kanban board is not enabled for this organization");
  }
}
