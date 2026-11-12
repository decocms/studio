import { z } from "zod";
import { isBlockBody } from "./block-body";
import type { CmsBlocksResult, ContentIndex } from "./hosted-content";

const blocksResultSchema = z.object({
  blocks: z.record(
    z.string(),
    z.record(z.string(), z.unknown()).refine(isBlockBody),
  ),
  versions: z.record(z.string(), z.string().min(1)),
  missing: z.array(z.string()),
});

/** Each requested name must have exactly one complete body/version or be missing. */
export function parseBlocksResult(
  value: unknown,
  requested: readonly string[],
): CmsBlocksResult {
  const result = blocksResultSchema.parse(value);
  const bodies = Object.keys(result.blocks);
  const versions = Object.keys(result.versions);
  const answered = [...bodies, ...result.missing];
  const names = new Set(requested);
  if (
    versions.length !== bodies.length ||
    bodies.some((name) => !Object.hasOwn(result.versions, name)) ||
    answered.length !== names.size ||
    new Set(answered).size !== answered.length ||
    answered.some((name) => !names.has(name))
  )
    throw new Error(
      "The CMS block response did not account for the requested names",
    );
  return result;
}

export interface BlockLoadSnapshot {
  index: ContentIndex | undefined;
  blocks: Record<string, unknown>;
  versions: Record<string, string>;
}

/** Optimistic bodies remain editable; their last confirmed version must match the index. */
export function blockIsLoaded(
  snapshot: BlockLoadSnapshot,
  name: string,
): boolean {
  const entry = snapshot.index?.entries[name];
  return (
    !!entry &&
    isBlockBody(snapshot.blocks[name]) &&
    snapshot.versions[name] === entry.version
  );
}

/** A read may fill its cache slot only if no edit, deletion or newer read replaced it. */
export function adoptBlockLoad(
  started: BlockLoadSnapshot,
  current: BlockLoadSnapshot,
  result: CmsBlocksResult,
): {
  blocks: Record<string, unknown>;
  versions: Record<string, string>;
  refreshIndex: boolean;
} {
  const accepted = new Map<string, Record<string, unknown>>();
  let refreshIndex = false;
  for (const [name, body] of Object.entries(result.blocks)) {
    const entry = current.index?.entries[name];
    if (!entry) continue;
    if (result.versions[name] !== entry.version) {
      // If the index did not move, the server has moved beyond our index.
      refreshIndex ||= entry.version === started.index?.entries[name]?.version;
      continue;
    }
    if (
      current.blocks[name] !== started.blocks[name] ||
      current.versions[name] !== started.versions[name]
    )
      continue;
    accepted.set(name, body);
  }
  // A missing answer does not delete an indexed body: refresh the index first.
  refreshIndex ||= result.missing.some(
    (name) => !!current.index?.entries[name],
  );
  return {
    blocks: accepted.size
      ? { ...current.blocks, ...Object.fromEntries(accepted) }
      : current.blocks,
    versions: accepted.size
      ? {
          ...current.versions,
          ...Object.fromEntries(
            [...accepted.keys()].map((name) => [name, result.versions[name]!]),
          ),
        }
      : current.versions,
    refreshIndex,
  };
}

/** The parent's displayed snapshot must arrive before a form can seed from it. */
export function blocksAreLoaded(
  snapshot: BlockLoadSnapshot,
  names: readonly string[],
  listing?: Record<string, unknown>,
): boolean {
  return (
    !!snapshot.index &&
    names.every((name) =>
      snapshot.index?.entries[name]
        ? blockIsLoaded(snapshot, name) &&
          (!listing || listing[name] === snapshot.blocks[name])
        : !listing || listing[name] === undefined,
    )
  );
}
