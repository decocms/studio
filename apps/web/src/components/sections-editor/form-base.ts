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
import { DRAFT_TOMBSTONE_VERSION } from "@decocms/shared/blocks-major";
import { draftVersionOf } from "./draft-version";
import { isIndexStub } from "./hosted-content";

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
 * The version of a saved block a form's save names for the server's stale
 * check (`base`). A form builds on what it last knew to be stored, unless its
 * edits were just merged onto the stored copy.
 *
 * After a refusal, a stored copy that differs from that base and wasn't merged
 * is one of the form's own versions (see `isOwnVersion`). It is either a read
 * lagging behind the branch or the real head, as when a save landed but its
 * answer was lost. Naming it settles which: the form's edits already descend
 * from it, and the server refuses it if the branch holds anything else.
 */
export function formSaveExpects({
  startedFrom,
  stored,
  rebased,
  refused,
}: {
  startedFrom: Record<string, unknown>;
  stored: Record<string, unknown> | null;
  rebased: boolean;
  /** An earlier try of this save was refused as stale. */
  refused: boolean;
}): Record<string, unknown> {
  if (!stored) return startedFrom;
  return rebased || (refused && formSourceMovedOn(startedFrom, stored))
    ? stored
    : startedFrom;
}

/**
 * The content protocol's guard for a section form save (v8; the other
 * backends send the form's `base` instead): `blocks.apply` writes only while
 * the block is still at the version the form's copy was checked against, and
 * a refusal comes back as a `BlockConflictError`, as a legacy 409 does.
 *
 * A saved block (`formBase` given) takes the form's version: read when unset
 * or when the form's edits were just rebased on the stored copy, and moved
 * to each landed save's version. A page (`formBase: null`), rebuilt from the
 * cache, takes the version read each time. Both are read when the save runs,
 * after the branch's earlier saves landed, so a save queued behind the
 * form's own previous one expects that one's version. An unknown version
 * sends no guard.
 *
 * On a hosted v8 draft (`copy` given) a version read is the one of the copy
 * the save was built on, computed from it ({@link draftVersionOf}, the
 * server's own content hash), never the draft's version as the index says
 * it: a poll puts someone else's version in the index before their copy of
 * the block is loaded (and never loads it over a block being saved), so the
 * index's version would let a save built on the copy the form still shows
 * write over a change it never showed. `versionOf` then only says whether
 * the draft holds the block (`null`: main's copy; the tombstone's for one
 * the draft deletes).
 */
export function formSaveGuard({
  formBase,
  rebased,
  versionOf,
  copy,
}: {
  formBase: FormBase | null;
  rebased: boolean;
  versionOf: (blockKey: string) => string | null | undefined;
  /**
   * Hosted v8: the block (the saved block, or the page) as the cache held
   * it when the save was built, the copy the form's check read.
   */
  copy?: { value: unknown };
}): SaveGuard {
  let guarded: string | null = null;
  const guardOf = (version: string | null | undefined) =>
    version === undefined || guarded === null
      ? undefined
      : { [guarded]: version };
  if (copy) {
    return {
      ifMatch: async (blockKey) => {
        guarded = blockKey;
        if (formBase && formBase.version !== undefined && !rebased) {
          return guardOf(formBase.version);
        }
        const version = await copyVersion(versionOf(blockKey), copy.value);
        if (formBase) formBase.version = version;
        return guardOf(version);
      },
      onApplied: (versions) => {
        if (formBase && guarded !== null && Object.hasOwn(versions, guarded)) {
          formBase.version = versions[guarded];
        }
      },
      reloadOnConflict: true,
    };
  }
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
 * The hosted draft's version of `value`, a copy of a block whose version in
 * the draft is `listed`: unknown and "not in the draft" (`null`, main's copy)
 * as listed, the tombstone for a block the draft deletes or one the editor
 * holds no copy of, otherwise the copy's own content hash.
 */
async function copyVersion(
  listed: string | null | undefined,
  value: unknown,
): Promise<string | null | undefined> {
  if (listed === undefined || listed === null) return listed;
  if (listed === DRAFT_TOMBSTONE_VERSION) return listed;
  if (value === undefined || isIndexStub(value)) return listed;
  return draftVersionOf(value);
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

/** The first pause before a refused form save is rebuilt (doubles per try). */
export const CONFLICT_RETRY_BASE_MS = 1_000;

/**
 * How a refused section-form save is retried. A refusal that carried the
 * stored copy (a hosted v8 draft's: it is in the cache already) is rebuilt
 * at once, so the reconcile dialog opens with no pause; otherwise the save
 * waits for the re-read to settle (right after a commit a provider can keep
 * answering the previous head), backing off between tries, and the rebuilt
 * save waits out the usual typing pause.
 */
export function conflictRetry(
  conflicts: number,
  carriedStored: boolean,
): { delay: number; immediate: boolean } {
  return carriedStored
    ? { delay: 0, immediate: true }
    : { delay: CONFLICT_RETRY_BASE_MS * 2 ** conflicts, immediate: false };
}

/** Where a form's save goes, as {@link waitingChoiceBase} compares it. */
export interface WaitingChoiceTarget {
  pageKey: string | null;
  global: boolean;
  pageVariantIndex: number;
  sectionVariantIndex: number;
}

/**
 * The form whose choice between two versions a save waits for: its own,
 * when the user's choice for it waits, else the one waiting for the same
 * section (same page, page variant, section and section variant), whichever
 * form record the save was built from. A save queued before the editor
 * re-read the section, or built from a form record started again since,
 * then waits for the user's choice too, rather than writing over their
 * version while the dialog asks. Null when no choice waits for the section.
 */
export function waitingChoiceBase(
  waiting: ReadonlyArray<{ formBase: FormBase; target: WaitingChoiceTarget }>,
  formBase: FormBase | null,
  target: WaitingChoiceTarget,
  sectionIndex: number,
): FormBase | null {
  if (formBase && waiting.some((item) => item.formBase === formBase)) {
    return formBase;
  }
  const same = waiting.find(
    (item) =>
      item.formBase.sectionIndex === sectionIndex &&
      item.target.pageKey === target.pageKey &&
      item.target.global === target.global &&
      item.target.pageVariantIndex === target.pageVariantIndex &&
      item.target.sectionVariantIndex === target.sectionVariantIndex,
  );
  return same?.formBase ?? null;
}
