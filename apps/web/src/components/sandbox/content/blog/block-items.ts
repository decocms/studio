import { type RawBlock } from "./blocks/block-registry";

/**
 * A block plus a stable client-side id. The id keys the dnd-kit sortable rows
 * and the React list; it is never persisted (the caller owns only the block).
 */
export type BlockItem = { id: string; block: RawBlock };

export function uid(): string {
  return crypto.randomUUID();
}

/** Wrap each block with a fresh id — the initial seed for a document. */
export function seedBlockItems(value: RawBlock[]): BlockItem[] {
  return value.map((block) => ({ id: uid(), block }));
}

/**
 * Rebuild the id-keyed items from a new `value`, preserving each row's existing
 * id by position. An autosave round-trip re-reads the block and hands back a
 * new array (often with new block objects) whose content is identical; minting
 * a fresh id per block would change every React key and remount the whole
 * list — dropping the focused input and scrolling the document back to its
 * first block. Reusing ids keeps keys stable (so no row remounts) while the new
 * `block` still flows in as a prop update for genuinely changed content.
 */
export function reseedBlockItems(
  prev: BlockItem[],
  value: RawBlock[],
): BlockItem[] {
  return value.map((block, i) => {
    const existing = prev[i];
    return { id: existing ? existing.id : uid(), block };
  });
}
