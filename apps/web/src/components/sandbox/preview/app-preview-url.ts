/**
 * Preview hosts for the extra apps of a monorepo (`metadata.runtime.apps`).
 *
 * Each app gets its own host instead of a path prefix: dev servers emit
 * root-relative asset URLs, which a `/checkout/` prefix would break. Hosted
 * previews take a `--<app>` suffix on the handle label so the existing
 * single-level wildcard certificate still covers them; loopback previews use
 * `<app>.localhost`, which browsers resolve to loopback without DNS.
 */

import { appHostLabel, appSlug } from "@decocms/shared/app-preview-host";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Short display name: the last path segment, `apps/checkout` → `checkout`. */
export function appLabel(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? path;
}

/**
 * Preview URL of the app at `path`, derived from the main app's preview URL.
 * Null when either input cannot produce a host.
 */
export function appPreviewUrl(baseUrl: string, path: string): string | null {
  const slug = appSlug(path);
  if (!slug) return null;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (LOOPBACK_HOSTS.has(host)) {
    url.hostname = `${slug}.localhost`;
  } else if (host.endsWith(".localhost")) {
    url.hostname = `${slug}.${host}`;
  } else {
    const [label, ...rest] = host.split(".");
    if (!label || rest.length === 0) return null;
    url.hostname = [appHostLabel(label, path), ...rest].join(".");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** `appPreviewUrl` with the page path the pane's URL bar holds. */
export function withPagePath(appUrl: string, pagePath: string): string {
  const url = new URL(appUrl);
  const trimmed = pagePath.trim();
  const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const [pathname = "/", search = ""] = normalized.split("?");
  url.pathname = pathname;
  url.search = search ? `?${search}` : "";
  return url.toString();
}

/** A typed app path the way the daemon reads it: `./apps/web/` → `apps/web`. */
export function normalizeAppPath(raw: string): string {
  return raw.trim().replace(/^\.?\/+|\/+$/g, "");
}
