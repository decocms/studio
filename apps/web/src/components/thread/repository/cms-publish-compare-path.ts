import {
  extractPathParams,
  fillPathTemplate,
} from "@/components/sections-editor/page-path-utils.ts";
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

/** URL rendering just the global section, on a blank page. */
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
 * The concrete path to render for a change, or "" when it needs one typed in.
 * Global blocks and site settings have no page of their own; the home page is
 * where most of them show. A dynamic page reuses the values last typed into
 * the preview's path bar for that same template.
 */
export function initialComparePath(
  change: Pick<PublishChange, "kind" | "pagePath">,
  lastPage: LastPreviewPage | null,
): string {
  if (change.kind === "block") return "/";
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
