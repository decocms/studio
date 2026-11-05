/**
 * The v8 Experiments tab's model: the site's A/B tests as the `experiments`
 * block in the draft has them (named-rules.ts), with their status and how
 * they compare with the published site. Pure, for the tab and its tests.
 */

import {
  type NamedRuleEntryState,
  namedRuleEntryState,
  namedRulesRemovedInDraft,
  publishedNamedRuleValue,
} from "@/components/sections-editor/named-rule-edits";
import {
  type ExperimentStatus,
  experimentStatus,
  readNamedRuleBlock,
} from "@/components/sections-editor/named-rules";

export interface ExperimentRowModel {
  name: string;
  share: number;
  status: ExperimentStatus;
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
  /** The published content; `null` while it isn't known. */
  published: Record<string, unknown> | null,
): ExperimentRowModel[] {
  const read = readNamedRuleBlock(decofile, "experiments");
  if (read.kind === "conflict") return [];
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
  published: Record<string, unknown> | null,
): string[] {
  return namedRulesRemovedInDraft(decofile, published, "experiments");
}
