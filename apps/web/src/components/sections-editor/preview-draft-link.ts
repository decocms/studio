/**
 * The `?__draft=` value of a hosted v8 site's preview, and the links that
 * carry it. The preview frame, its "Open in new tab", the publish dialog's
 * Preview and the compare's "Open draft" all send exactly this value: the
 * current draft's pointer (`<draft>@<etag>`), with the frame's forced variants
 * and "Preview as" options. Never `off` and never a release's commit SHA: a
 * draft always exists while the editor is open (the server creates it empty
 * on open, and Publish empties it at the same address), and the site layers
 * it over the release it serves.
 *
 * The frame publishes what it adds to the pointer (forced variants, preview
 * options) per project ({@link publishPreviewDraft}); every link reads them
 * ({@link usePreviewDraftValue}) and applies them to the pointer it reads from
 * the same query, so a link never holds an older version than the frame.
 */

import { useSyncExternalStore } from "react";
import {
  type ContentEditsTarget,
  flushContentEdits,
  settleContentEdits,
} from "./content-sync";
import {
  isReleaseSha,
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
 * isn't one (`off`, a release's SHA): a hosted preview never asks for those.
 */
export function previewDraftValue(
  input: { pointer: string | null | undefined } & PreviewDraftModifiers,
): string | null {
  const { pointer } = input;
  if (!pointer || pointer === DRAFT_OFF) return null;
  const q = pointer.indexOf("?");
  if (isReleaseSha(q === -1 ? pointer : pointer.slice(0, q))) return null;
  if (pointer.lastIndexOf("@") <= 0) return null;
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
const listeners = new Map<string, Set<() => void>>();

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
  for (const listener of listeners.get(scope) ?? []) listener();
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

/** The `__draft` value the frame of `scope` sends, for this `pointer`. */
export function usePreviewDraftValue(
  scope: string,
  pointer: string | null | undefined,
): string | null {
  const current = usePreviewDraft(scope);
  return previewDraftValue({ pointer, ...current });
}

/**
 * Opens a draft link in a new tab with the edits made so far in it: their
 * armed autosaves are sent and `buildUrl` runs once they landed, so the link
 * carries their version (read it from the cache, not from a render). The tab
 * opens at the click, as a popup opened later is blocked, and goes to the
 * link once it is known; without one it closes.
 */
export function openDraftTab(
  target: ContentEditsTarget,
  buildUrl: () => string | null,
): void {
  if (!flushContentEdits(target)) {
    const url = buildUrl();
    if (url) window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  void settleContentEdits(target).then(() => {
    if (!tab) return;
    const url = buildUrl();
    if (url) tab.location.href = url;
    else tab.close();
  });
}
