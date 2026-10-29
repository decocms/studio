import {
  extractPathParams,
  fillPathTemplate,
  normalizePagePath,
} from "@/components/sections-editor/page-path-utils.ts";
import {
  pagesShowingBlock,
  previewPageForBlock,
} from "@/components/sections-editor/page-list.tsx";
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
 * The page a saved block's change compares on (a Blocks v8 site has no
 * isolated-section route; a v7 site, when its blocks are known): the home
 * page when it shows the block; else the page last previewed, when it shows
 * the block (the edit was made there, and a block whose content depends on
 * the page, e.g. matched by URL, shows that edit only there); else
 * {@link previewPageForBlock}. A dynamic one is filled with the values last
 * typed for it in the preview, else left as its pattern to fill in. `null`
 * when no page shows the block: there is nothing to preview, only the code.
 * `undefined` while the site's blocks aren't known yet.
 */
export function blockComparePath(
  blockKey: string,
  blocks: Record<string, unknown> | null | undefined,
  lastPage: LastPreviewPage | null,
): string | null | undefined {
  if (!blocks) return undefined;
  const first = previewPageForBlock(blocks, blockKey);
  if (!first) return null;
  const page =
    normalizePagePath(first.path) === "/" || !lastPage
      ? first
      : (pagesShowingBlock(blocks, blockKey).find(
          (shown) =>
            shown.key === lastPage.pageKey || shown.path === lastPage.path,
        ) ?? first);
  if (extractPathParams(page.path).length === 0) return page.path;
  if (lastPage?.path !== page.path) return page.path;
  const filled = fillPathTemplate(page.path, lastPage.params);
  return extractPathParams(filled).length === 0 ? filled : page.path;
}

/**
 * The site URL a change compares on: the page `path`, or a saved section on
 * its own (v7's `/live/previews`) when `sectionKey` is set. A Blocks v8 site
 * has no such route: there every change renders on the page `path` (see
 * {@link blockComparePath}).
 */
export function compareUrl(input: {
  previewServerUrl: string;
  /** {@link isolatedSectionKey} of a v7 change that renders on its own. */
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
  | {
      kind: "pointer";
      pointer: string;
      /**
       * The `__draft` the "Open draft" link sends (a hosted draft: the preview
       * frame's, with its forced variants and "Preview as" options); the
       * pointer when absent. The compare's panes render the bare pointer.
       */
      link?: string;
    }
  | { kind: "sandbox"; previewUrl: string };

/**
 * The "Open draft" link for `url`: what {@link compareDraftUrl} renders, with
 * a pointer draft's `link` value when it has one.
 */
export function compareDraftLink(
  url: URL,
  draft: CompareDraft | null,
): string | null {
  if (draft?.kind === "pointer" && draft.link) {
    return withDraftPointer(url.toString(), draft.link);
  }
  return compareDraftUrl(url, draft);
}

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

/**
 * What stands in for a side that has no page to render: a new page has no
 * "before" and a removed page no "after". On a Blocks v8 site (`v8`), only a
 * page: a new or removed block (a saved section, the A/B tests, the
 * campaigns) or code file changes a page that is there on both sides, so both
 * sides render it. On v7, any new or removed change but a code file, as
 * before (a new code file says nothing about whether the page existed).
 */
export function comparePlaceholder(
  change: Pick<PublishChange, "kind" | "status">,
  v8: boolean,
): { before: "new" | null; after: "removed" | null } {
  const page = v8 ? change.kind === "page" : change.kind !== "other";
  return {
    before: page && change.status === "new" ? "new" : null,
    after: page && change.status === "removed" ? "removed" : null,
  };
}
