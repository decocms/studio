import type { StudioContext } from "@/core/studio-context";

/** Throws if any `tagIds` entry isn't one of the org's tags — otherwise a
 *  caller could attach another org's tag. */
export async function assertValidTagIds(
  ctx: StudioContext,
  organizationId: string,
  tagIds: readonly string[],
): Promise<void> {
  const orgTags = await ctx.storage.tags.listOrgTags(organizationId);
  const validTagIds = new Set(orgTags.map((t) => t.id));
  for (const tagId of tagIds) {
    if (!validTagIds.has(tagId)) {
      throw new Error(`Tag not found: ${tagId}`);
    }
  }
}
