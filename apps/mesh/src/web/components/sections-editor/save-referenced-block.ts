import { assertSafeDecoBlockKey } from "./deco-block-key";

export type ReferencedBlockSaveFn = (
  blockKey: string,
  data: Record<string, unknown>,
) => void;

/** Validates block keys before persisting nested saved-block references. */
export function createReferencedBlockSaver(
  save: (blockKey: string, data: Record<string, unknown>) => void,
): ReferencedBlockSaveFn {
  return (blockKey, data) => {
    assertSafeDecoBlockKey(blockKey);
    save(blockKey, data);
  };
}
