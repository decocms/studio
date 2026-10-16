import { canonicalBlockJson, mergeBlockJson } from "@decocms/shared/decofile";
import type { ParsedSection } from "./parse-sections";
import type { RawSection } from "./section-types";
import { formatMatcher } from "./format-matcher";
import {
  getMultivariateSectionObject,
  parseSectionFlagVariants,
  unwrapVariantSectionValue,
} from "./section-variants";
import { unwrapSection } from "./unwrap-section";

/**
 * The value an open section form starts from, in the same shape the form
 * edits: what the decofile holds for that section (or one of its variants).
 * Mirrors how selecting a section seeds the form.
 */
export function sectionFormSource(
  raw: RawSection | undefined,
  parsed: ParsedSection | undefined,
  variantIndex: number,
  decofile: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!raw || !parsed) return null;
  if (!parsed.isMultivariate) {
    return unwrapSection(raw, parsed, decofile)?.data ?? null;
  }
  const mvObj = getMultivariateSectionObject(raw, parsed);
  const variant = mvObj
    ? parseSectionFlagVariants(mvObj, formatMatcher)[variantIndex]
    : undefined;
  return variant
    ? (unwrapVariantSectionValue(variant.value, decofile)?.data ?? null)
    : null;
}

/**
 * What an open form's edits are relative to. The form holds a copy of the
 * section, and every autosave writes the whole copy, so a copy that predates
 * another editor's change would silently revert it.
 */
export interface FormBase {
  sectionIndex: number;
  variantIndex: number;
  /** The section as the form last knew it to be stored. */
  base: Record<string, unknown>;
  /** The last value the form itself produced. */
  emitted: unknown;
  /** How many sections the page had when the form started. */
  sectionCount: number;
  /**
   * Every version of the section this form started from or saved, as
   * canonical JSON. A read can answer with one of them after a newer save
   * landed (the provider lags right after a commit); that is the form's own
   * past, not someone else's change.
   */
  own: string[];
  /**
   * What the form shows instead of `base`, while a merge that kept the stored
   * value of a field the user changed waits for them to leave the form
   * (mergedFormDisplay "on-leave"). Their later edits are relative to it.
   */
  displayed?: Record<string, unknown>;
}

const OWN_VERSIONS_KEPT = 50;

/** Record a version this form saved (or started from). */
export function rememberOwnVersion(
  tracked: FormBase,
  value: Record<string, unknown>,
): void {
  tracked.own.push(canonicalBlockJson(value));
  if (tracked.own.length > OWN_VERSIONS_KEPT) tracked.own.shift();
}

/** True when `stored` is a version this form itself started from or saved. */
export function isOwnVersion(
  tracked: FormBase,
  stored: Record<string, unknown>,
): boolean {
  return tracked.own.includes(canonicalBlockJson(stored));
}

/**
 * Track the form's starting point across one change. `shown` is the value the
 * form displayed before the change: when it is not the value the form last
 * produced, something else put it there (opening a section, a reload), so it
 * is a new starting point. Otherwise the same record is updated in place, so
 * a pending autosave holding it sees later updates to `base`.
 */
export function trackFormChange(
  tracked: FormBase | null,
  change: {
    sectionIndex: number;
    variantIndex: number;
    shown: Record<string, unknown> | null;
    next: unknown;
    sectionCount: number;
  },
): FormBase | null {
  const { sectionIndex, variantIndex, shown, next, sectionCount } = change;
  if (
    tracked &&
    tracked.sectionIndex === sectionIndex &&
    tracked.variantIndex === variantIndex &&
    tracked.emitted === shown
  ) {
    tracked.emitted = next;
    return tracked;
  }
  return shown
    ? {
        sectionIndex,
        variantIndex,
        base: shown,
        emitted: next,
        sectionCount,
        own: [canonicalBlockJson(shown)],
      }
    : null;
}

/** True when the stored section is no longer what the form started from. */
export function formSourceMovedOn(
  base: Record<string, unknown>,
  current: Record<string, unknown> | null,
): boolean {
  return (
    current !== null && canonicalBlockJson(base) !== canonicalBlockJson(current)
  );
}

/**
 * True when the stored value at the form's position is a different kind of
 * section than the one the form opened. Its edits can't be applied there.
 */
export function sectionTypeChanged(
  base: Record<string, unknown>,
  stored: Record<string, unknown>,
): boolean {
  return base.__resolveType !== stored.__resolveType;
}

/**
 * Where the section the form opened sits now, when sections were inserted or
 * removed since it started: the one position whose stored value is exactly
 * what the form started from. `"here"` when the page has as many sections as
 * before, so the section at the form's position is the form's own, edited in
 * place (a page can hold identical twins, and following one would write to
 * the wrong section). `"unknown"` when the count changed but the form's
 * section can't be told apart: none or several positions match.
 */
export function findSectionMovedTo(
  base: Record<string, unknown>,
  sections: Array<Record<string, unknown> | null>,
  formIndex: number,
  sectionCountAtStart: number,
): number | "here" | "unknown" {
  if (sections.length === sectionCountAtStart) return "here";
  const started = canonicalBlockJson(base);
  const matches = sections.flatMap((section, i) =>
    i !== formIndex &&
    section !== null &&
    canonicalBlockJson(section) === started
      ? [i]
      : [],
  );
  return matches.length === 1 ? (matches[0] as number) : "unknown";
}

/**
 * When the open form shows the value a save merged onto the stored section.
 *
 * - `"never"`: there is nothing merged, or the form has moved on (another
 *   section, or a newer value than the one merged); it keeps what it shows.
 * - `"on-leave"`: the merge kept the stored value of a field the form changed
 *   while the user is still in the form. Replacing the field under their
 *   cursor would put their next keystrokes after the stored text, and that
 *   mix would be saved as their edit. The form keeps showing what they type
 *   (`FormBase.displayed`: what they change after the merge is saved over
 *   the stored value, what they leave alone keeps it) and re-reads the
 *   stored section once they leave it and its saves have settled.
 * - `"now"`: show it at once.
 */
export function mergedFormDisplay({
  merged,
  tracked,
  current,
  saved,
  keptStored,
  editing,
}: {
  merged: boolean;
  /** The form's record when the save was built. */
  tracked: FormBase | null;
  /** The form's record now. */
  current: FormBase | null;
  /** The value the save was built from. */
  saved: unknown;
  /** The merge kept the stored value of a field the form changed. */
  keptStored: boolean;
  /** Focus is inside the form. */
  editing: boolean;
}): "now" | "on-leave" | "never" {
  if (!merged || !tracked || current !== tracked) return "never";
  if (tracked.emitted !== saved) return "never";
  return keptStored && editing ? "on-leave" : "now";
}

/** True while focus is inside `container` (an input of the open form). */
export function focusInside(
  container: Element | null | undefined,
  active: Element | null | undefined,
): boolean {
  return !!container && !!active && container.contains(active);
}

/**
 * The form's value as an edit of `base`, the section as stored. While the form
 * shows something else (`displayed`, a merge waiting for the user to leave the
 * form), a field the user changes after that is theirs, saved over the stored
 * value they were told about; a field they leave alone keeps the stored value.
 * Without it, what they type after "The latest version was kept" would be
 * merged against the old copy again and dropped.
 */
export function formValueOnBase(
  tracked: FormBase | null,
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (!tracked?.displayed) return value;
  return mergeBlockJson(tracked.displayed, value, tracked.base, {
    prefer: "ours",
  }) as Record<string, unknown>;
}

/** What `displayed` becomes when the form shows `shown` over `base`. */
export function displayedOverBase(
  shown: Record<string, unknown>,
  base: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return canonicalBlockJson(shown) === canonicalBlockJson(base)
    ? undefined
    : shown;
}

/**
 * Stands in `FormBase.displayed` for a value the user edited after the merge,
 * so that value counts as theirs even when they type back the same text (a
 * user insisting on what the field already shows). No stored JSON equals it.
 */
const EDITED_AFTER_MERGE = Object.freeze({
  "\u0000edited after the merge": true,
});

/**
 * Marks in `displayed` every value `next` (the form's new value) changes, as
 * edited by the user (see formValueOnBase). Values it leaves alone stay as
 * shown, so they keep the stored value.
 */
export function markEditedSinceDisplayed(
  displayed: unknown,
  next: unknown,
): unknown {
  if (canonicalBlockJson(displayed) === canonicalBlockJson(next)) {
    return displayed;
  }
  if (
    displayed &&
    next &&
    typeof displayed === "object" &&
    typeof next === "object" &&
    !Array.isArray(displayed) &&
    !Array.isArray(next) &&
    displayed !== EDITED_AFTER_MERGE
  ) {
    const shown = displayed as Record<string, unknown>;
    const now = next as Record<string, unknown>;
    const marked: Record<string, unknown> = { ...shown };
    for (const key of new Set([...Object.keys(shown), ...Object.keys(now)])) {
      marked[key] = markEditedSinceDisplayed(shown[key], now[key]);
    }
    return marked;
  }
  return EDITED_AFTER_MERGE;
}
