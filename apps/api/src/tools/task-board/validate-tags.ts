import type { StudioContext } from "@/core/studio-context";

/** Throws if any `tagIds` entry isn't one of the org's tags — otherwise a
 *  caller could attach another org's tag. Also validates for duplicates and
 *  empty strings in the input. */
export async function assertValidTagIds(
  ctx: StudioContext,
  organizationId: string,
  tagIds: readonly string[],
): Promise<void> {
  const seenIds = new Set<string>();
  const duplicates: string[] = [];
  const emptyIds: number[] = [];

  for (let i = 0; i < tagIds.length; i++) {
    const tagId = tagIds[i]!;
    if (tagId === "") {
      emptyIds.push(i);
    } else if (seenIds.has(tagId)) {
      duplicates.push(tagId);
    }
    seenIds.add(tagId);
  }

  if (emptyIds.length > 0) {
    throw new Error(
      `Invalid tag IDs: empty strings at positions ${emptyIds.join(", ")}`,
    );
  }

  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate tag IDs: ${[...new Set(duplicates)].join(", ")}`,
    );
  }

  const orgTags = await ctx.storage.tags.listOrgTags(organizationId);
  const validTagIds = new Set(orgTags.map((t) => t.id));
  const invalidIds: string[] = [];

  for (const tagId of seenIds) {
    if (!validTagIds.has(tagId)) {
      invalidIds.push(tagId);
    }
  }

  if (invalidIds.length > 0) {
    throw new Error(
      `Tags not found in organization ${organizationId}: ${invalidIds.join(", ")}`,
    );
  }
}
