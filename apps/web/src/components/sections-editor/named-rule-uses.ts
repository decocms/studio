/**
 * "Used by" for the Experiments tab and the Campaigns view: which pages and
 * sections use each A/B test or campaign in the draft the editor works in,
 * each marked against the published site (rule-references.ts). Pure: the
 * views, the hook and the tests share it.
 */

import type { ChangeDetail } from "@decocms/blocks/protocol";
import { pageEntryFromBlock, globalSectionLabel } from "./page-list";
import type { NamedRuleKind } from "./named-rules";
import {
  findRuleReferences,
  findSavedMatcherReferences,
  type MarkedRuleReferences,
  markReferenceStates,
  publishedDecofile,
  type ReferenceState,
} from "./rule-references";
import type { LiveMeta } from "./resolve-schema";

export interface NamedRuleUses {
  refs: MarkedRuleReferences;
  /**
   * The published content, when it is known: the draft has no changes, or
   * both sides of its changes were read. `null` while they load; the marks
   * then all say `published` and the views show none.
   */
  published: Record<string, unknown> | null;
}

/**
 * The draft's uses, marked against the published content. `changeCount` is
 * how many entries the draft changed (`undefined` while the list loads);
 * `sides` both sides of them (`undefined` while they load).
 */
export function namedRuleUses(input: {
  decofile: Record<string, unknown>;
  meta?: LiveMeta | null;
  changeCount: number | undefined;
  sides: Record<string, ChangeDetail> | undefined;
}): NamedRuleUses {
  const draft = findRuleReferences(input.decofile, input.meta);
  const published =
    input.changeCount === 0
      ? input.decofile
      : input.sides
        ? publishedDecofile(input.decofile, input.sides)
        : null;
  if (published === null) {
    return { refs: markReferenceStates(draft, draft), published: null };
  }
  const live =
    published === input.decofile
      ? draft
      : findRuleReferences(published, input.meta);
  return { refs: markReferenceStates(draft, live), published };
}

/** One row of "Used by": a page or a saved section, and how it uses the name. */
export interface NamedRuleUseRow {
  blockKey: string;
  /**
   * A page opens in the editor by its key; a section as a section. A saved
   * rule doesn't open (the editor has no form for one): the pages that use
   * it are listed beside it, and one nothing uses can be removed.
   */
  blockKind: "page" | "section" | "rule";
  /** A saved rule that no page, section or other saved rule uses. */
  unused?: boolean;
  title: string;
  /** A page's path. */
  path?: string;
  /** The variant (1-based) whose rule names it, when it is a variant's rule. */
  variant?: number;
  /** The block reads every test or campaign in its own code. */
  wholeBlock: boolean;
  state: ReferenceState;
}

/**
 * The rows for one name of a kind (or, with `name` null, the blocks that read
 * the whole map), one per block and variant. A block the draft removed is
 * labelled from the published content.
 */
export function namedRuleUseRows(
  uses: NamedRuleUses,
  kind: NamedRuleKind,
  name: string | null,
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): NamedRuleUseRow[] {
  const labelFrom = (blockKey: string) =>
    rowLabel(blockKey, uses, decofile, meta);

  const rows: NamedRuleUseRow[] = [];
  const seen = new Set<string>();
  const push = (row: NamedRuleUseRow) => {
    const key = `${row.blockKey}#${row.variant ?? ""}#${row.wholeBlock}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };
  if (name === null) {
    for (const ref of uses.refs[kind].wholeBlock) {
      push({
        blockKey: ref.blockKey,
        ...labelFrom(ref.blockKey),
        wholeBlock: true,
        state: ref.state,
      });
    }
    return sortRows(rows);
  }
  for (const ref of uses.refs[kind].byName.get(name) ?? []) {
    // A saved rule is listed through the blocks that use it.
    if (ref.savedRule) continue;
    push({
      blockKey: ref.blockKey,
      ...labelFrom(ref.blockKey),
      ...(ref.variant ? { variant: ref.variant.index + 1 } : {}),
      wholeBlock: false,
      state: ref.state,
    });
  }
  return sortRows(rows);
}

/**
 * What keeps a name from being deleted: every block in the draft whose rule
 * names it (a page's or a section's variant, and a saved rule that names it
 * even when nothing uses that rule), one row per block and variant. Uses the
 * draft already removed don't count, nor do sections that read the whole map
 * (a missing name reads false there).
 */
export function namedRuleBlockingRows(
  uses: NamedRuleUses,
  kind: NamedRuleKind,
  name: string,
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): NamedRuleUseRow[] {
  const rows: NamedRuleUseRow[] = [];
  const seen = new Set<string>();
  for (const ref of uses.refs[kind].byName.get(name) ?? []) {
    if (ref.state === "removed-in-draft") continue;
    const variant = ref.variant ? ref.variant.index + 1 : undefined;
    const key = `${ref.blockKey}#${variant ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      blockKey: ref.blockKey,
      // A saved rule is known by its name.
      ...(ref.savedRule
        ? {
            blockKind: "rule" as const,
            title: safeDecode(ref.blockKey),
            unused:
              findSavedMatcherReferences(decofile, ref.blockKey, meta)
                .length === 0,
          }
        : rowLabel(ref.blockKey, uses, decofile, meta)),
      ...(variant ? { variant } : {}),
      wholeBlock: false,
      state: ref.state,
    });
  }
  return sortRows(rows);
}

/** A page by its name and path; anything else as a section. */
function rowLabel(
  blockKey: string,
  uses: NamedRuleUses,
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): Pick<NamedRuleUseRow, "blockKind" | "title" | "path"> {
  const value =
    decofile[blockKey] ??
    (uses.published ? uses.published[blockKey] : undefined);
  const page = pageEntryFromBlock(blockKey, value, meta);
  if (page) return { blockKind: "page", title: page.name, path: page.path };
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    blockKind: "section",
    title: globalSectionLabel(safeDecode(blockKey), record),
  };
}

/** By title, then variant; the uses the draft removed last. */
function sortRows(rows: NamedRuleUseRow[]): NamedRuleUseRow[] {
  const removed = (row: NamedRuleUseRow) =>
    row.state === "removed-in-draft" ? 1 : 0;
  return rows.sort(
    (a, b) =>
      removed(a) - removed(b) ||
      a.title.localeCompare(b.title) ||
      (a.variant ?? 0) - (b.variant ?? 0),
  );
}

/** How many blocks use a name, as the list shows it (removed uses left out). */
export function namedRuleUseCount(
  uses: NamedRuleUses,
  kind: NamedRuleKind,
  name: string,
): number {
  const blocks = new Set<string>();
  for (const ref of uses.refs[kind].byName.get(name) ?? []) {
    if (ref.savedRule || ref.state === "removed-in-draft") continue;
    blocks.add(ref.blockKey);
  }
  return blocks.size;
}

function safeDecode(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}
