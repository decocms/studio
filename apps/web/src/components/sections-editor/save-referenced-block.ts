import { assertSafeDecoBlockKey } from "./deco-block-key";

export type ReferencedBlockSaveFn = (
  blockKey: string,
  data: Record<string, unknown>,
) => void;

interface ReferencedBlockWrite {
  blockKey: string;
  data: Record<string, unknown>;
  base?: { value: unknown; fromCache: true };
  create?: boolean;
}

/** V8 guards the displayed copy; legacy keeps its existing call-time cache base. */
export function createReferencedBlockSaver(
  save: (write: ReferencedBlockWrite) => void,
  blocks: Readonly<Record<string, unknown>>,
  v8: boolean,
): ReferencedBlockSaveFn {
  return (blockKey, data) => {
    assertSafeDecoBlockKey(blockKey);
    save({
      blockKey,
      data,
      ...(v8
        ? {
            base: { value: blocks[blockKey], fromCache: true as const },
            create: !Object.hasOwn(blocks, blockKey),
          }
        : {}),
    });
  };
}
