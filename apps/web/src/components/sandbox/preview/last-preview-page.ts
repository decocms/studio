/** Last page visited in the preview, persisted to localStorage per project+branch. */
export interface LastPreviewPage {
  /** Page path, possibly a template (e.g. `/blog/:slug`). */
  path: string;
  /** Page block key pinned in the picker; null for plain in-iframe navigation. */
  pageKey: string | null;
  /** Values for `:param` tokens in the path template. */
  params: Record<string, string>;
}

export function lastPreviewPageKey(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
): string {
  return `deco:preview:last-page:${orgSlug}:${virtualMcpId}:${branch}`;
}

/** Validate a raw localStorage value; null for anything malformed. */
export function parseLastPreviewPage(
  raw: string | null,
): LastPreviewPage | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    if (typeof obj.path !== "string" || !obj.path.startsWith("/")) return null;
    const pageKey = typeof obj.pageKey === "string" ? obj.pageKey : null;
    const params: Record<string, string> = {};
    if (obj.params && typeof obj.params === "object") {
      for (const [key, value] of Object.entries(obj.params)) {
        if (typeof value === "string") params[key] = value;
      }
    }
    return { path: obj.path, pageKey, params };
  } catch {
    return null;
  }
}

export function readLastPreviewPage(key: string): LastPreviewPage | null {
  try {
    return parseLastPreviewPage(localStorage.getItem(key));
  } catch {
    return null;
  }
}

export function writeLastPreviewPage(key: string, page: LastPreviewPage): void {
  try {
    localStorage.setItem(key, JSON.stringify(page));
  } catch {
    // Quota exceeded / privacy mode — persistence is best-effort.
  }
}
