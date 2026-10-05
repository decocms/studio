import {
  extractPathParams,
  fillPathTemplate,
} from "@/components/sections-editor/page-path-utils.ts";
import type { LastPreviewPage } from "@/components/sandbox/preview/last-preview-page.ts";
import type { PublishChange } from "./publish-change-summary.ts";

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
