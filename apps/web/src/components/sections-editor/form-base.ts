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
import type { SaveGuard } from "./use-save-block";

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
  /** A Blocks v8 site (unwrapSection). */
  v8: boolean,
): Record<string, unknown> | null {
  if (!raw || !parsed) return null;
  if (!parsed.isMultivariate) {
    return unwrapSection(raw, parsed, decofile, v8)?.data ?? null;
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
   * Content protocol (v8): the version of the saved block `base` was stored
   * as, for the save's `ifMatch`. Unset until a save needs it (then read from
   * the version of the copy `base` was checked against), and moved to each
   * landed save's version. Other backends compare `base` itself.
   */
  version?: string | null;
  /**
   * Every version of the section this form started from or saved, as
   * canonical JSON. A read can answer with one of them after a newer save
   * landed (the provider lags right after a commit); that is the form's own
   * past, not someone else's change.
   */
  own: string[];
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
 * The content protocol's guard for a section form save (v8; the other
 * backends send the form's `base` instead): `blocks.apply` writes only while
 * the block is still at the version the form's copy was checked against, and
 * a refusal comes back as a `BlockConflictError`, as a legacy 409 does.
 *
 * A saved block (`formBase` given) takes the form's version: read from the
 * cache (`versionOf`) when unset or when the form's edits were just rebased
 * on the stored copy, and moved to each landed save's version. A page
 * (`formBase: null`), rebuilt from the cache, takes its cached version. Both
 * are read when the save runs, after the branch's earlier saves landed, so a
 * save queued behind the form's own previous one expects that one's version.
 * An unknown version sends no guard.
 */
export function formSaveGuard({
  formBase,
  rebased,
  versionOf,
}: {
  formBase: FormBase | null;
  rebased: boolean;
  versionOf: (blockKey: string) => string | null | undefined;
}): SaveGuard {
  let guarded: string | null = null;
  return {
    ifMatch: (blockKey) => {
      guarded = blockKey;
      if (formBase && (formBase.version === undefined || rebased)) {
        formBase.version = versionOf(blockKey);
      }
      const version = formBase ? formBase.version : versionOf(blockKey);
      return version === undefined ? undefined : { [blockKey]: version };
    },
    onApplied: (versions) => {
      if (formBase && guarded !== null && Object.hasOwn(versions, guarded)) {
        formBase.version = versions[guarded];
      }
    },
    reloadOnConflict: true,
  };
}

/**
 * True when the open form shows, at once, the value a save merged onto the
 * stored section: there is a merge, the form is still on that section (its
 * record now is the one the save was built from) and has not moved past the
 * value saved. The merge kept every value the user changed (values both
 * changed wait for their choice instead, see form-conflict.ts), so nothing
 * under their cursor changes.
 */
export function showMergeInForm({
  merged,
  tracked,
  current,
  saved,
}: {
  merged: boolean;
  /** The form's record when the save was built. */
  tracked: FormBase | null;
  /** The form's record now. */
  current: FormBase | null;
  /** The value the save was built from. */
  saved: unknown;
}): boolean {
  return (
    !!merged && !!tracked && current === tracked && tracked.emitted === saved
  );
}

/** True while focus is inside `container` (an input of the open form). */
export function focusInside(
  container: Element | null | undefined,
  active: Element | null | undefined,
): boolean {
  return !!container && !!active && container.contains(active);
}
