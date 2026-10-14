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
  },
): FormBase | null {
  const { sectionIndex, variantIndex, shown, next } = change;
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
    ? { sectionIndex, variantIndex, base: shown, emitted: next }
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
