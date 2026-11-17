import { assertSafeDecoBlockKey } from "./deco-block-key";
import {
  type SaveFrom,
  type UseSaveBlockParams,
  useDebouncedSaveBlock,
} from "./use-save-block";

export type ReferencedBlockSaveFn = (
  blockKey: string,
  data: Record<string, unknown>,
) => void;

/** The copy a referenced block's edit is made on; v8 creates a block the listing lacks. */
export function referencedBlockSource(
  blocks: Readonly<Record<string, unknown>>,
  blockKey: string,
  v8: boolean,
): SaveFrom {
  return {
    base: { value: blocks[blockKey], fromCache: true },
    ...(v8 ? { create: !Object.hasOwn(blocks, blockKey) } : {}),
  };
}

/** Saves a block edited inside another form, debounced like any form; its fields read the cache. */
export function useReferencedBlockSaver(
  params: UseSaveBlockParams,
  blocks: Readonly<Record<string, unknown>>,
  opts?: { onSaved?: () => void },
) {
  const debounced = useDebouncedSaveBlock(params, {
    onSaved: opts?.onSaved,
    showEdits: true,
  });
  const save: ReferencedBlockSaveFn = (blockKey, data) => {
    assertSafeDecoBlockKey(blockKey);
    debounced.save(
      blockKey,
      data,
      referencedBlockSource(blocks, blockKey, debounced.v8),
    );
  };
  return {
    save,
    isPending: debounced.isPending,
    isError: debounced.isError,
  };
}
