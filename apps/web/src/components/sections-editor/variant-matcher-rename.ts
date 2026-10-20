import type { LiveMeta } from "./resolve-schema";
import {
  buildMatcherBlockData,
  buildMatcherBlockReference,
  inlineMatcherRule,
  isSavedMatcherBlockReference,
  unwrapMatcherRule,
} from "./matcher-rules";
import { suggestBlockId, validateBlockId } from "./page-sections";

/**
 * Block-store operations a multivariate FIELD wrapper delegates upward to the
 * sections editor, which owns block persistence (saveBlock/deleteBlock) and
 * orphan cleanup. Both are awaited direct whole-block saves — the wrapper does
 * NOT route these through its debounced `onChange`, so there is never a
 * persisted dangling matcher reference. Only wired for the top-level
 * (global-block) surface where the wrapper value IS the whole block.
 */
export interface VariantMatcherOps {
  /** Promote/rename/inline the variant's matcher. `nextName` `""` inlines. */
  rename: (
    wrapperValue: Record<string, unknown>,
    variantIndex: number,
    nextName: string,
  ) => Promise<void>;
  /** Point the variant at an existing saved global matcher block. */
  selectGlobal: (
    wrapperValue: Record<string, unknown>,
    variantIndex: number,
    blockKey: string,
  ) => Promise<void>;
}

/**
 * The block-store operation a variant rename resolves to. Renaming never adds a
 * name field to the variant — it promotes the inline matcher to a NAMED global
 * matcher block (or renames/inlines an existing one), mirroring how page and
 * section variants are renamed. Kept as a pure decision (no i18n, no async) so
 * every rename handler shares the same branch logic and it stays unit-testable.
 */
export type RenameAction =
  | { kind: "noop" }
  /** Clear the name: replace the block reference with the inline matcher and
   *  garbage-collect the now-possibly-orphaned block. */
  | { kind: "inline"; blockKey: string; inlinedRule: Record<string, unknown> }
  /** The rule already references a saved block: rewrite that block's display
   *  name only; the variant rule is unchanged. */
  | {
      kind: "updateBlock";
      blockKey: string;
      blockData: Record<string, unknown>;
    }
  /** Promote an inline matcher to a new named global block and point the
   *  variant rule at it. */
  | {
      kind: "createBlock";
      blockId: string;
      blockData: Record<string, unknown>;
      reference: Record<string, unknown>;
    }
  | {
      kind: "error";
      reason: "no-matcher-rule" | "unreadable-rule" | "invalid-block-id";
      /** Present for `invalid-block-id` — already-translated from validateBlockId. */
      message?: string;
    };

export function planVariantMatcherRename(
  targetRule: Record<string, unknown> | undefined,
  nextName: string,
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): RenameAction {
  if (!targetRule || typeof targetRule !== "object") {
    return { kind: "error", reason: "no-matcher-rule" };
  }

  const trimmed = nextName.trim();

  if (!trimmed) {
    if (!isSavedMatcherBlockReference(targetRule, decofile, meta)) {
      return { kind: "noop" };
    }
    const blockKey = (targetRule.__resolveType as string) ?? "";
    return {
      kind: "inline",
      blockKey,
      inlinedRule: inlineMatcherRule(targetRule, decofile, meta),
    };
  }

  const unwrapped = unwrapMatcherRule(targetRule, decofile, meta);
  if (!unwrapped) {
    return { kind: "error", reason: "unreadable-rule" };
  }

  if (unwrapped.blockKey) {
    return {
      kind: "updateBlock",
      blockKey: unwrapped.blockKey,
      blockData: buildMatcherBlockData(
        unwrapped.resolveType,
        unwrapped.data,
        trimmed,
      ),
    };
  }

  const blockId = suggestBlockId(trimmed);
  const validationError = validateBlockId(blockId, decofile);
  if (validationError) {
    return {
      kind: "error",
      reason: "invalid-block-id",
      message: validationError,
    };
  }

  return {
    kind: "createBlock",
    blockId,
    blockData: buildMatcherBlockData(
      unwrapped.resolveType,
      unwrapped.data,
      trimmed,
    ),
    reference: buildMatcherBlockReference(blockId),
  };
}
