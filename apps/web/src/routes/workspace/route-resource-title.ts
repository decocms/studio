export interface RouteResourceTarget {
  /** Canonical payload passed to the route's resource viewer. */
  value: string;
  /** Optional resource-derived title; the route supplies its localized fallback. */
  title: string | undefined;
}

/**
 * Agent-provided labels may be schema-valid but visually empty. Prefer a
 * meaningful declared label, then the stable view id; route metadata owns the
 * final localized fallback for a malformed id.
 */
export function resolveAgentViewRouteTitle(
  declaredTitle: string | null | undefined,
  viewId: string,
): string | undefined {
  return declaredTitle?.trim() || viewId.trim() || undefined;
}

/**
 * Resolve an opaque file-like route payload without letting blank or
 * directory-shaped deep links reach a viewer. The returned value is trimmed
 * at the URL boundary; whitespace inside a path or filename is preserved.
 */
export function resolveRouteResourceTarget(
  rawValue: string | null | undefined,
  titleFromLeaf: (leaf: string) => string = (leaf) => leaf,
): RouteResourceTarget | null {
  const value = rawValue?.trim();
  if (!value) return null;

  const leaf = value.split("/").at(-1)?.trim();
  if (!leaf) return null;

  const title = titleFromLeaf(leaf).trim();
  return { value, title: title || undefined };
}
