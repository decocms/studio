/**
 * Preview hosts of a monorepo's extra apps (`metadata.runtime.apps`). Each app
 * gets its own host, `<handle>--<slug>`, so the main app's single-level
 * wildcard certificate still covers it. The sandbox daemon routes on the same
 * label (`config.AppSlug`).
 */

/** Names the app to the sandbox daemon when a proxy in between drops the Host. */
export const APP_SLUG_HEADER = "x-sandbox-app";

/** DNS-safe label for an app path: `apps/checkout` → `apps-checkout`. */
export function appSlug(path: string): string {
  return path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** First host label of an app's preview, beside the main app's `handle`. */
export function appHostLabel(handle: string, path: string): string {
  return `${handle}--${appSlug(path)}`;
}

/** Splits a preview host label into the sandbox handle and the app slug, if any. */
export function parseAppHostLabel(label: string): {
  handle: string;
  slug: string | null;
} {
  const i = label.lastIndexOf("--");
  if (i <= 0) return { handle: label, slug: null };
  return { handle: label.slice(0, i), slug: label.slice(i + 2) || null };
}
