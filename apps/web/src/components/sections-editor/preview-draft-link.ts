/**
 * The `?__draft=` value of a hosted v8 site's preview, and the links that
 * carry it. The preview frame, its "Open in new tab", the publish dialog's
 * Preview and the compare's "Open draft" all send exactly this value: the
 * current draft's pointer (`<draft>@<etag>`), with the frame's forced variants
 * and "Preview as" options. Never `off`, and a release's revision id only
 * right after a Publish (below): a draft always exists while the editor is open (the server creates it empty
 * on open, and Publish empties it at the same address), and the site layers
 * it over the release it serves.
 *
 * The frame publishes what it adds to the pointer (forced variants, preview
 * options) per project ({@link publishPreviewDraft}); every link reads them
 * ({@link usePreviewDraftValue}) and applies them to the pointer it reads from
 * the same query, so a link never holds an older version than the frame.
 *
 * One exception, right after a Publish or a "Make current": the draft is
 * empty, so its pointer renders the release the site serves, which it may
 * not have picked up yet (an edge still holding the old `latest.json`, a
 * process between polls). Until the next content change the value is the
 * revision that change made, by its id ({@link holdPreviewRevision}, set by
 * content-sync.ts): the editor keeps showing what was just published. Not
 * with forced variants, which only a draft pointer carries.
 */

import { useSyncExternalStore } from "react";
import {
  isReleaseRevision,
  type PreviewOptions,
  withPreviewOptions,
} from "./preview-link";
import { DRAFT_OFF, withDraftPointer } from "./section-preview-url";
import { withForcedVariants } from "./variant-draft-pointer";

/** What the frame adds to the draft's pointer. */
export interface PreviewDraftModifiers {
  /** Forced variants, as `withForcedVariants` takes them. */
  forcedVariants: string[];
  /** "Preview as": the moment and forced tests. */
  previewOptions: PreviewOptions;
}

/**
 * The exact `__draft` value: the pointer with these forced variants and
 * preview options. `null` without a draft pointer, and for anything that
 * isn't one (`off`, a release's revision id): a hosted preview never asks for those.
 */
export function previewDraftValue(
  input: {
    pointer: string | null | undefined;
    /** The revision a Publish or "Make current" just made ({@link holdPreviewRevision}). */
    heldRevision?: string | null;
  } & PreviewDraftModifiers,
): string | null {
  const { pointer } = input;
  if (!pointer || pointer === DRAFT_OFF) return null;
  const q = pointer.indexOf("?");
  if (isReleaseRevision(q === -1 ? pointer : pointer.slice(0, q))) return null;
  if (pointer.lastIndexOf("@") <= 0) return null;
  if (
    isReleaseRevision(input.heldRevision) &&
    input.forcedVariants.length === 0
  ) {
    return withPreviewOptions(input.heldRevision!, input.previewOptions);
  }
  return withPreviewOptions(
    withForcedVariants(pointer, input.forcedVariants),
    input.previewOptions,
  );
}

/** `pageUrl` carrying `?__draft=<value>`; `null` without a value or a URL. */
export function previewDraftLink(
  pageUrl: string | null | undefined,
  value: string | null,
): string | null {
  if (!pageUrl || !value) return null;
  try {
    return withDraftPointer(pageUrl, value);
  } catch {
    return null;
  }
}

/**
 * The site's page at `path` (resolved against `siteUrl`, the preview server)
 * carrying `?__draft=<value>`; `null` without a value or a resolvable URL.
 */
export function previewDraftPageLink(
  siteUrl: string | null | undefined,
  path: string,
  value: string | null,
): string | null {
  if (!siteUrl || !value) return null;
  try {
    return previewDraftLink(new URL(path, siteUrl).toString(), value);
  } catch {
    return null;
  }
}

const NO_MODIFIERS: PreviewDraftModifiers = {
  forcedVariants: [],
  previewOptions: {},
};

const modifiers = new Map<string, PreviewDraftModifiers>();
const held = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

function notify(scope: string) {
  for (const listener of listeners.get(scope) ?? []) listener();
}

/**
 * The revision the previews of project `scope` show instead of the (empty)
 * draft, until the next content change: a Publish's or a "Make current"'s
 * new revision id, or `null` to go back to the draft pointer.
 */
export function holdPreviewRevision(scope: string, revision: string | null) {
  const next = isReleaseRevision(revision) ? revision! : null;
  if ((held.get(scope) ?? null) === next) return;
  if (next) held.set(scope, next);
  else held.delete(scope);
  notify(scope);
}

/** The revision {@link holdPreviewRevision} holds for `scope`, if any. */
export function getHeldPreviewRevision(scope: string): string | null {
  return held.get(scope) ?? null;
}

function sameModifiers(
  a: PreviewDraftModifiers,
  b: PreviewDraftModifiers,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The frame's modifiers for project `scope` (`contentSyncScope`); `null`
 * when the frame goes away (links then carry the bare pointer).
 */
export function publishPreviewDraft(
  scope: string,
  next: PreviewDraftModifiers | null,
): void {
  const current = modifiers.get(scope) ?? NO_MODIFIERS;
  const value = next ?? NO_MODIFIERS;
  if (sameModifiers(current, value)) return;
  if (next) modifiers.set(scope, value);
  else modifiers.delete(scope);
  notify(scope);
}

/** The frame's modifiers for project `scope`, as last published. */
export function getPreviewDraft(scope: string): PreviewDraftModifiers {
  return modifiers.get(scope) ?? NO_MODIFIERS;
}

function subscribe(scope: string, listener: () => void): () => void {
  let set = listeners.get(scope);
  if (!set) {
    set = new Set();
    listeners.set(scope, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** {@link getPreviewDraft}, kept current. */
function usePreviewDraft(scope: string): PreviewDraftModifiers {
  return useSyncExternalStore(
    (listener) => subscribe(scope, listener),
    () => getPreviewDraft(scope),
    () => NO_MODIFIERS,
  );
}

/** {@link getHeldPreviewRevision}, kept current; `null` without a scope. */
export function useHeldPreviewRevision(scope: string | null): string | null {
  return useSyncExternalStore(
    (listener) => (scope ? subscribe(scope, listener) : () => {}),
    () => (scope ? getHeldPreviewRevision(scope) : null),
    () => null,
  );
}

/** The `__draft` value the frame of `scope` sends, for this `pointer`. */
export function usePreviewDraftValue(
  scope: string,
  pointer: string | null | undefined,
): string | null {
  const current = usePreviewDraft(scope);
  const heldRevision = useHeldPreviewRevision(scope);
  return previewDraftValue({ pointer, heldRevision, ...current });
}
