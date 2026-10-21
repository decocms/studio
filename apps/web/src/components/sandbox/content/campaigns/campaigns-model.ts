/**
 * The Campaigns view's model (a Blocks v8 site): every campaign of the saved
 * block `campaigns` (type `date-windows`, name → one `{ start?, end? }`
 * window) in the draft, with its status at a moment, its uses and how it
 * compares with the published site, plus where its bar falls on a timeline.
 * Every date rule names a campaign, so this is the whole calendar of a v8
 * site. Pure, for the view and its tests.
 */

import {
  type NamedRuleEntryState,
  namedRuleEntryState,
  namedRulesRemovedInDraft,
  publishedNamedRuleValue,
} from "@/components/sections-editor/named-rule-edits";
import {
  type NamedRuleUses,
  namedRuleUseCount,
} from "@/components/sections-editor/named-rule-uses";
import {
  type CampaignWindow,
  readNamedRuleBlock,
} from "@/components/sections-editor/named-rules";

/**
 * Where a campaign is at a moment, as the site decides it (`start`
 * inclusive, `end` exclusive, a missing bound open):
 *
 * - `running`: the moment is inside its window;
 * - `upcoming` / `ended`: before its start / at or after its end;
 * - `always`: no dates at all, so it always runs;
 * - `unreadable`: a date the site can't read, so it never runs.
 */
export type CampaignStatus =
  | "running"
  | "upcoming"
  | "ended"
  | "always"
  | "unreadable";

/** A window's bounds as times; `NaN` for a bound that doesn't parse. */
function bounds(window: CampaignWindow): {
  start: number | null;
  end: number | null;
} {
  return {
    start: window.start ? Date.parse(window.start) : null,
    end: window.end ? Date.parse(window.end) : null,
  };
}

export function campaignStatus(
  window: CampaignWindow,
  now: Date,
): CampaignStatus {
  const { start, end } = bounds(window);
  if (Number.isNaN(start) || Number.isNaN(end)) return "unreadable";
  if (start === null && end === null) return "always";
  const at = now.getTime();
  if (start !== null && at < start) return "upcoming";
  if (end !== null && at >= end) return "ended";
  return "running";
}

export interface CampaignRowModel {
  name: string;
  window: CampaignWindow;
  status: CampaignStatus;
  /** Pages and sections whose variants use it in the draft. */
  uses: number;
  /** Against the published site; `null` while that isn't known. */
  entryState: NamedRuleEntryState | null;
  /** The window live now, when the draft changed it. */
  publishedWindow?: CampaignWindow;
}

const STATUS_ORDER: Record<CampaignStatus, number> = {
  running: 0,
  upcoming: 1,
  always: 2,
  unreadable: 3,
  ended: 4,
};

/**
 * Every campaign in the draft: running first, then upcoming (soonest first),
 * those with no dates, unreadable ones, and ended ones (latest first).
 */
export function campaignRows(
  decofile: Record<string, unknown>,
  uses: NamedRuleUses | null,
  now: Date,
): CampaignRowModel[] {
  const read = readNamedRuleBlock(decofile, "campaigns");
  if (read.kind === "conflict") return [];
  const published = uses?.published ?? null;
  const rows = Object.entries(read.values).map(([name, window]) => {
    const entryState = namedRuleEntryState(
      published,
      "campaigns",
      name,
      window,
    );
    const live =
      entryState === "changed"
        ? publishedNamedRuleValue(published, "campaigns", name)
        : undefined;
    return {
      name,
      window,
      status: campaignStatus(window, now),
      uses: uses ? namedRuleUseCount(uses, "campaigns", name) : 0,
      entryState,
      ...(live !== undefined ? { publishedWindow: live } : {}),
    } satisfies CampaignRowModel;
  });
  const startOf = (row: CampaignRowModel) =>
    row.window.start ? Date.parse(row.window.start) : 0;
  const endOf = (row: CampaignRowModel) =>
    row.window.end ? Date.parse(row.window.end) : 0;
  return rows.sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    if (a.status === "upcoming") return startOf(a) - startOf(b);
    if (a.status === "ended") return endOf(b) - endOf(a);
    return 0;
  });
}

/** The published campaigns the draft deleted: they stop at the next Publish. */
export function removedCampaigns(
  decofile: Record<string, unknown>,
  uses: NamedRuleUses | null,
): string[] {
  return namedRulesRemovedInDraft(
    decofile,
    uses?.published ?? null,
    "campaigns",
  );
}

/** A campaign's bar on a timeline from `rangeStart` to `rangeEnd`. */
export interface TimelineBar {
  /** Percent of the range from its start. */
  left: number;
  width: number;
  /** The window goes on before / after what the range shows. */
  openStart: boolean;
  openEnd: boolean;
}

/**
 * Where a window falls on a timeline, or `null` when it is outside it (or
 * can't be read). An open bound runs to the range's edge and fades there.
 */
export function timelineBar(
  window: CampaignWindow,
  rangeStart: Date,
  rangeEnd: Date,
): TimelineBar | null {
  const { start, end } = bounds(window);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const from = rangeStart.getTime();
  const to = rangeEnd.getTime();
  const total = to - from;
  if (total <= 0) return null;
  const barStart = start ?? Number.NEGATIVE_INFINITY;
  const barEnd = end ?? Number.POSITIVE_INFINITY;
  if (barEnd <= from || barStart >= to || barEnd <= barStart) return null;
  const left = Math.max(barStart, from);
  const right = Math.min(barEnd, to);
  return {
    left: ((left - from) / total) * 100,
    width: ((right - left) / total) * 100,
    openStart: barStart < from,
    openEnd: barEnd > to,
  };
}
