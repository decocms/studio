/**
 * "Used by" for the Experiments tab and the Campaigns view: which pages and
 * sections use each A/B test or campaign in the draft the editor works in,
 * each marked against the published site (rule-references.ts). Pure: the
 * views, the hook and the tests share it.
 */

import type { ChangeDetail } from "@decocms/blocks/protocol";
import { pageEntryFromBlock, globalSectionLabel } from "./page-list";
import {
  NAMED_RULE_KINDS,
  namedRuleExists,
  type NamedRuleKind,
  namedRuleSupport,
  readNamedRuleBlock,
} from "./named-rules";
import {
  findRuleReferences,
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
 * Results by the identity of their inputs: the draft, the schema and the
 * sides are the query cache's objects, which stay the same until they
 * change, so a view that renders again (the Publish review, the tabs) reads
 * the result it already has instead of walking the whole draft again. Held
 * weakly: a draft no one holds any more drops its results.
 */
interface MemoNode {
  weak: WeakMap<object, MemoNode>;
  strong: Map<unknown, MemoNode>;
  value?: unknown;
  has: boolean;
}

const newMemoNode = (): MemoNode => ({
  weak: new WeakMap(),
  strong: new Map(),
  has: false,
});

const MEMO_ROOTS = new Map<string, MemoNode>();

function memoized<V>(
  name: string,
  keys: readonly unknown[],
  compute: () => V,
): V {
  let node: MemoNode = MEMO_ROOTS.get(name) ?? newMemoNode();
  MEMO_ROOTS.set(name, node);
  for (const key of keys) {
    const isObject =
      (typeof key === "object" && key !== null) || typeof key === "function";
    let next: MemoNode | undefined = isObject
      ? node.weak.get(key as object)
      : node.strong.get(key);
    if (!next) {
      next = newMemoNode();
      if (isObject) node.weak.set(key as object, next);
      else node.strong.set(key, next);
    }
    node = next;
  }
  if (!node.has) {
    node.value = compute();
    node.has = true;
  }
  return node.value as V;
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
  return memoized(
    "uses",
    [input.decofile, input.meta, input.changeCount, input.sides],
    () => computeNamedRuleUses(input),
  );
}

function computeNamedRuleUses(input: {
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
  /** A page opens in the editor by its key; a section as a section. */
  blockKind: "page" | "section";
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

/**
 * The names the draft's rules use that don't exist (`namedRuleExists`: not
 * in its `experiments` or `campaigns` block, or with a value Studio can't
 * read): deleted, discarded, removed in another tab, never created or typed
 * by hand. Nothing is blocked for them; the views point them out so the
 * editor picks another, creates it or removes the variant. Uses the draft
 * already removed don't count.
 */
export function missingNamedRules(
  uses: NamedRuleUses,
  kind: NamedRuleKind,
  decofile: Record<string, unknown>,
): string[] {
  return memoized("missing", [uses, decofile, kind], () => {
    const read = readNamedRuleBlock(decofile, kind);
    if (read.kind === "conflict") return [];
    const missing: string[] = [];
    for (const [name, refs] of uses.refs[kind].byName) {
      if (namedRuleExists(read, name)) continue;
      if (refs.some((ref) => ref.state !== "removed-in-draft")) {
        missing.push(name);
      }
    }
    return missing;
  });
}

/**
 * The pages and sections whose rules name a test or campaign that doesn't
 * exist, one row per block and variant, as "Used by" lists them.
 */
export function missingNamedRuleRows(
  uses: NamedRuleUses,
  kind: NamedRuleKind,
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): NamedRuleUseRow[] {
  return missingRowsAndNames(uses, kind, decofile, meta).rows;
}

/**
 * How many distinct missing names those rows come from, so the line above
 * them says "a test" or "tests".
 */
export function missingNamedRuleRowNames(
  uses: NamedRuleUses,
  kind: NamedRuleKind,
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): number {
  return missingRowsAndNames(uses, kind, decofile, meta).names;
}

function missingRowsAndNames(
  uses: NamedRuleUses,
  kind: NamedRuleKind,
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): { rows: NamedRuleUseRow[]; names: number } {
  return memoized("missingRows", [uses, decofile, meta, kind], () => {
    const rows: NamedRuleUseRow[] = [];
    const seen = new Set<string>();
    let names = 0;
    for (const name of missingNamedRules(uses, kind, decofile)) {
      let listed = false;
      for (const row of namedRuleUseRows(uses, kind, name, decofile, meta)) {
        if (row.state === "removed-in-draft") continue;
        listed = true;
        const key = `${row.blockKey}#${row.variant ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
      }
      if (listed) names++;
    }
    return { rows: sortRows(rows), names };
  });
}

/** The kinds the site's schema has built in. */
function availableKinds(meta: LiveMeta | null | undefined): NamedRuleKind[] {
  return NAMED_RULE_KINDS.filter(
    (kind) => namedRuleSupport(meta, kind) === "available",
  );
}

/** The draft's uses on its own (no published side), as the Publish review reads them. */
function draftUses(
  decofile: Record<string, unknown>,
  meta: LiveMeta | null | undefined,
): NamedRuleUses {
  return namedRuleUses({ decofile, meta, changeCount: 0, sides: undefined });
}

/**
 * Per block, the kinds whose names its rules use but that don't exist, for
 * the kinds the site's schema has built in. The Publish review flags those
 * cards; nothing is blocked.
 */
export function blocksUsingMissingNamedRules(
  decofile: Record<string, unknown>,
  meta: LiveMeta | null | undefined,
): Map<string, NamedRuleKind[]> {
  return memoized("blocksUsingMissing", [decofile, meta], () => {
    const out = new Map<string, NamedRuleKind[]>();
    const kinds = availableKinds(meta);
    if (kinds.length === 0) return out;
    const uses = draftUses(decofile, meta);
    for (const kind of kinds) {
      for (const name of missingNamedRules(uses, kind, decofile)) {
        for (const ref of uses.refs[kind].byName.get(name) ?? []) {
          const list = out.get(ref.blockKey) ?? [];
          if (!list.includes(kind)) list.push(kind);
          out.set(ref.blockKey, list);
        }
      }
    }
    return out;
  });
}

/** How many pages and how many sections, counted apart so the copy says each. */
export interface NamedRuleUseCounts {
  pages: number;
  sections: number;
}

/** Where missing names are used, and how many distinct names are missing. */
export interface MissingNamedRuleUseCounts extends NamedRuleUseCounts {
  /** Distinct names, so the copy says "a test" or "tests". */
  names: number;
}

/**
 * Per kind the site's schema has built in, how many pages and how many
 * sections use a test or campaign that doesn't exist, and how many such names. The Publish review
 * says so on the A/B tests or Campaigns card, since those pages may have no
 * card of their own; nothing is blocked.
 */
export function missingNamedRuleUseCounts(
  decofile: Record<string, unknown>,
  meta: LiveMeta | null | undefined,
): Map<NamedRuleKind, MissingNamedRuleUseCounts> {
  return memoized("missingUseCounts", [decofile, meta], () => {
    const out = new Map<NamedRuleKind, MissingNamedRuleUseCounts>();
    const kinds = availableKinds(meta);
    if (kinds.length === 0) return out;
    const uses = draftUses(decofile, meta);
    for (const kind of kinds) {
      const blocks = new Set<string>();
      let names = 0;
      for (const name of missingNamedRules(uses, kind, decofile)) {
        let counted = false;
        for (const ref of uses.refs[kind].byName.get(name) ?? []) {
          if (ref.savedRule) continue;
          blocks.add(ref.blockKey);
          counted = true;
        }
        if (counted) names++;
      }
      const counts = countByKind(blocks, uses, decofile, meta);
      if (counts.pages + counts.sections > 0) {
        out.set(kind, { ...counts, names });
      }
    }
    return out;
  });
}

/** How many blocks use a name, as the list shows it (removed uses left out). */
export function namedRuleUseCount(
  uses: NamedRuleUses,
  kind: NamedRuleKind,
  name: string,
): number {
  return usingBlocks(uses, kind, name).size;
}

/**
 * How many pages and how many sections use a name in the draft (removed
 * uses left out): the Delete toast says each.
 */
export function namedRuleUseCounts(
  decofile: Record<string, unknown>,
  meta: LiveMeta | null | undefined,
  kind: NamedRuleKind,
  name: string,
): NamedRuleUseCounts {
  const uses = draftUses(decofile, meta);
  return countByKind(usingBlocks(uses, kind, name), uses, decofile, meta);
}

function usingBlocks(
  uses: NamedRuleUses,
  kind: NamedRuleKind,
  name: string,
): Set<string> {
  const blocks = new Set<string>();
  for (const ref of uses.refs[kind].byName.get(name) ?? []) {
    if (ref.savedRule || ref.state === "removed-in-draft") continue;
    blocks.add(ref.blockKey);
  }
  return blocks;
}

function countByKind(
  blocks: Iterable<string>,
  uses: NamedRuleUses,
  decofile: Record<string, unknown>,
  meta: LiveMeta | null | undefined,
): NamedRuleUseCounts {
  const counts: NamedRuleUseCounts = { pages: 0, sections: 0 };
  for (const blockKey of blocks) {
    if (rowLabel(blockKey, uses, decofile, meta).blockKind === "page") {
      counts.pages++;
    } else {
      counts.sections++;
    }
  }
  return counts;
}

function safeDecode(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}
