import { assertSafeDecoBlockKey } from "./deco-block-key";

export type ReferencedBlockSaveFn = (
  blockKey: string,
  data: Record<string, unknown>,
) => void;

interface ReferencedBlockWrite {
  blockKey: string;
  data: Record<string, unknown>;
  base: { value: unknown; fromCache: true };
  create: boolean;
}

/** Guard nested edits by the listing copy their form used, not a later cache value. */
export function createReferencedBlockSaver(
  save: (write: ReferencedBlockWrite) => void,
  blocks: Readonly<Record<string, unknown>>,
): ReferencedBlockSaveFn {
  return (blockKey, data) => {
    assertSafeDecoBlockKey(blockKey);
    save({
      blockKey,
      data,
      base: { value: blocks[blockKey], fromCache: true },
      create: !Object.hasOwn(blocks, blockKey),
    });
  };
}
