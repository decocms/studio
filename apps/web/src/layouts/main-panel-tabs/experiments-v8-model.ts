/**
 * The v8 Experiments tab's model: the site's A/B tests as the `experiments`
 * block in the draft has them (named-rules.ts), with their status, their uses
 * and how they compare with the published site. Pure, for the tab and its
 * tests.
 */

import type { ContentSearchParams } from "@/components/sandbox/content/content-search-params";
import {
  type NamedRuleEntryState,
  namedRuleEntryState,
  namedRulesRemovedInDraft,
  publishedNamedRuleValue,
} from "@/components/sections-editor/named-rule-edits";
import {
  type NamedRuleUseRow,
  type NamedRuleUses,
  namedRuleUseCount,
} from "@/components/sections-editor/named-rule-uses";
import {
  type ExperimentStatus,
  experimentStatus,
  readNamedRuleBlock,
} from "@/components/sections-editor/named-rules";

export interface ExperimentRowModel {
  name: string;
  share: number;
  status: ExperimentStatus;
  /** Pages and sections whose variants use it in the draft. */
  uses: number;
  /** Against the published site; `null` while that isn't known. */
  entryState: NamedRuleEntryState | null;
  /** The share live now, when the draft changed it. */
  publishedShare?: number;
}

const STATUS_ORDER: Record<ExperimentStatus, number> = {
  running: 0,
  everyone: 1,
  off: 2,
};

/**
 * Every test in the draft, running ones first, then those shown to everyone,
 * then those turned off; in the block's order within each.
 */
export function experimentRows(
  decofile: Record<string, unknown>,
  uses: NamedRuleUses | null,
): ExperimentRowModel[] {
  const read = readNamedRuleBlock(decofile, "experiments");
  if (read.kind === "conflict") return [];
  const published = uses?.published ?? null;
  const rows = Object.entries(read.values).map(([name, share], order) => {
    const entryState = namedRuleEntryState(
      published,
      "experiments",
      name,
      share,
    );
    const live =
      entryState === "changed"
        ? publishedNamedRuleValue(published, "experiments", name)
        : undefined;
    return {
      order,
      row: {
        name,
        share,
        status: experimentStatus(share),
        uses: uses ? namedRuleUseCount(uses, "experiments", name) : 0,
        entryState,
        ...(live !== undefined ? { publishedShare: live } : {}),
      } satisfies ExperimentRowModel,
    };
  });
  return rows
    .sort(
      (a, b) =>
        STATUS_ORDER[a.row.status] - STATUS_ORDER[b.row.status] ||
        a.order - b.order,
    )
    .map((entry) => entry.row);
}

/** The published tests the draft deleted: they stop at the next Publish. */
export function removedExperiments(
  decofile: Record<string, unknown>,
  uses: NamedRuleUses | null,
): string[] {
  return namedRulesRemovedInDraft(
    decofile,
    uses?.published ?? null,
    "experiments",
  );
}

/**
 * Where a "Used by" row opens in the site editor: a page by its key, any
 * other block in the Sections list, each on the variant that uses the name.
 * Every place key is written, unset ones as `undefined`, so a place left in
 * the URL by an earlier "Open" never carries over.
 */
export function contentSearchForUse(
  row: Pick<NamedRuleUseRow, "blockKey" | "blockKind" | "focus">,
): Partial<ContentSearchParams> {
  const place = {
    contentPageVariant: row.focus?.pageVariant,
    contentSection: row.focus?.section,
    contentVariant: row.focus?.variant,
  };
  return row.blockKind === "page"
    ? {
        contentPageId: row.blockKey,
        contentCollection: undefined,
        contentItem: undefined,
        ...place,
      }
    : {
        contentPageId: undefined,
        contentCollection: "sections",
        contentItem: row.blockKey,
        ...place,
      };
}
