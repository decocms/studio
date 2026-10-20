import {
  extractPathParams,
  fillPathTemplate,
} from "@/components/sections-editor/page-path-utils.ts";
import { previewPageForBlock } from "@/components/sections-editor/page-list.tsx";
import { isSectionResolveType } from "@/components/sections-editor/section-array-field.ts";
import { DEFAULT_LIVE_PAGE_RESOLVE_TYPE } from "@/components/sections-editor/section-catalog.ts";
import {
  globalSectionPreviewUrl,
  withDraftPointer,
} from "@/components/sections-editor/section-preview-url.ts";
import type { LastPreviewPage } from "@/components/sandbox/preview/last-preview-page.ts";
import type { PublishChange } from "./publish-change-summary.ts";

/** Block key of a global section, which renders on its own instead of inside a page. */
export function isolatedSectionKey(
  change: Pick<
    PublishChange,
    "kind" | "blockKey" | "isSiteApp" | "fromJson" | "toJson"
  >,
): string | null {
  if (change.kind !== "block" || change.isSiteApp || !change.blockKey) {
    return null;
  }
  const resolveType = (change.toJson ?? change.fromJson)?.__resolveType;
  return typeof resolveType === "string" && isSectionResolveType(resolveType)
    ? change.blockKey
    : null;
}

/**
 * Whether the reviewer chooses the page: a dynamic page needs its params, and
 * a non-section block can show on any page. A static page is its own path.
 */
export function isComparePathEditable(
  change: Pick<PublishChange, "kind" | "pagePath">,
): boolean {
  if (change.kind !== "page") return true;
  return !change.pagePath || extractPathParams(change.pagePath).length > 0;
}

/**
 * URL rendering just the global section, on a blank page — the v7 runtime's
 * `/live/previews` route. A Blocks v8 site has no such route (it answers 404):
 * there a saved section compares on a page that shows it
 * ({@link blockComparePath}), never through this.
 */
export function compareSectionUrl(
  previewServerUrl: string,
  blockKey: string,
): URL | null {
  try {
    return globalSectionPreviewUrl(
      previewServerUrl,
      DEFAULT_LIVE_PAGE_RESOLVE_TYPE,
      blockKey,
    );
  } catch {
    return null;
  }
}

/**
 * The page a saved block's change compares on, on a Blocks v8 site (which
 * has no isolated-section route): {@link previewPageForBlock}, the home page
 * first; a dynamic one filled with the values last typed for it in the
 * preview, else left as its pattern to fill in. `null` when no page shows
 * the block: there is nothing to preview, only the code. `undefined` while
 * the site's blocks aren't known yet.
 */
export function blockComparePath(
  blockKey: string,
  blocks: Record<string, unknown> | null | undefined,
  lastPage: LastPreviewPage | null,
): string | null | undefined {
  if (!blocks) return undefined;
  const page = previewPageForBlock(blocks, blockKey);
  if (!page) return null;
  if (extractPathParams(page.path).length === 0) return page.path;
  if (lastPage?.path !== page.path) return page.path;
  const filled = fillPathTemplate(page.path, lastPage.params);
  return extractPathParams(filled).length === 0 ? filled : page.path;
}

/**
 * The site URL a change compares on. A saved section renders on its own
 * (v7's `/live/previews`), except on a Blocks v8 site, where it — like every
 * other change — renders on the page `path` (see {@link blockComparePath}).
 */
export function compareUrl(input: {
  previewServerUrl: string;
  /** {@link isolatedSectionKey} of the change. */
  sectionKey: string | null;
  path: string;
  /** A Blocks v8 site (the content protocol). */
  v8: boolean;
}): URL | null {
  return input.sectionKey && !input.v8
    ? compareSectionUrl(input.previewServerUrl, input.sectionKey)
    : comparePageUrl(input.previewServerUrl, input.path);
}

/**
 * The concrete path to render for a change, or "" when it needs one typed in.
 * Global blocks, site settings and code have no page of their own; the home
 * page is where most of them show. A dynamic page reuses the values last typed into
 * the preview's path bar for that same template.
 */
export function initialComparePath(
  change: Pick<PublishChange, "kind" | "pagePath">,
  lastPage: LastPreviewPage | null,
): string {
  if (change.kind !== "page") return "/";
  const template = change.pagePath;
  if (!template) return "";
  if (extractPathParams(template).length === 0) return template;
  if (lastPage?.path !== template) return "";
  const filled = fillPathTemplate(template, lastPage.params);
  return extractPathParams(filled).length === 0 ? filled : "";
}

/**
 * Site URL for a typed path, or null while it is empty, still a pattern, or
 * resolves off the live site (`//host/x`) — the draft URL carries a signed
 * grant that must only ever reach the site's own origin.
 */
export function comparePageUrl(
  previewServerUrl: string,
  path: string,
): URL | null {
  const trimmed = path.trim();
  if (!trimmed || extractPathParams(trimmed).length > 0) return null;
  try {
    const site = new URL(previewServerUrl);
    const url = new URL(
      trimmed.startsWith("/") ? trimmed : `/${trimmed}`,
      site,
    );
    return url.origin === site.origin ? url : null;
  } catch {
    return null;
  }
}

/** Where the unpublished side renders: Fast Preview's `?__draft=` pointer on
 *  the live site, or a coding session's sandbox dev server. */
export type CompareDraft =
  | { kind: "pointer"; pointer: string }
  | { kind: "sandbox"; previewUrl: string };

/** The live-site `url` rendered with the unpublished changes, or null without a draft. */
export function compareDraftUrl(
  url: URL,
  draft: CompareDraft | null,
): string | null {
  if (!draft) return null;
  if (draft.kind === "pointer") {
    return withDraftPointer(url.toString(), draft.pointer);
  }
  try {
    return new URL(`${url.pathname}${url.search}`, draft.previewUrl).href;
  } catch {
    return null;
  }
}

/** Content renders on the live site either way; a code change only renders on a sandbox. */
export function canRenderCompare(
  kind: PublishChange["kind"],
  previewServerUrl: string | null,
  draft: CompareDraft | null,
): boolean {
  if (previewServerUrl === null) return false;
  return kind !== "other" || draft?.kind === "sandbox";
}
