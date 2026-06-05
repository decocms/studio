/** Deco loader/action resolveType — alphanumeric path segments only. */
const RESOLVE_TYPE_PATTERN = /^[\w./@-]+$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isValidLoaderResolveType(resolveType: string): boolean {
  if (!resolveType || resolveType.includes("..")) return false;
  return RESOLVE_TYPE_PATTERN.test(resolveType);
}

/**
 * Split a block-ref into the single-invoke target Deco expects:
 * POST /deco/invoke/<resolveType> with loader props as the JSON body.
 *
 * Posting to /deco/invoke without a path key is batch mode and treats each
 * top-level field as a separate handler name.
 */
export function parseLoaderInvokeRequest(body: Record<string, unknown>): {
  resolveType: string;
  payload: Record<string, unknown>;
} | null {
  const resolveType =
    typeof body.__resolveType === "string" ? body.__resolveType : null;
  if (!resolveType || !isValidLoaderResolveType(resolveType)) return null;

  const props = asRecord(body.props);
  if (props) {
    return { resolveType, payload: { props } };
  }

  const { __resolveType: _, ...rest } = body;
  return { resolveType, payload: rest };
}

export function buildLoaderInvokeUrl(
  previewBaseUrl: string,
  resolveType: string,
): string {
  const base = previewBaseUrl.replace(/\/+$/, "");
  return `${base}/deco/invoke/${encodeURIComponent(resolveType)}`;
}
