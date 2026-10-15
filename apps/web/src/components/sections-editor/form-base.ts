import { canonicalBlockJson } from "@decocms/shared/decofile";
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
    ? { sectionIndex, variantIndex, base: shown, emitted: next, sectionCount }
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
