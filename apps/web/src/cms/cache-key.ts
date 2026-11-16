/**
 * The `KEYS.decofile` cache key. Local mode reads a different source (the
 * tunnel) than the branch's git/sandbox, so it gets its own key suffix —
 * shared with `useSaveBlock` so its optimistic writes land where the read
 * looks. Same string ⇒ shared cache; a Local edit never bleeds into the real
 * branch's decofile and vice-versa.
 */
export function decofileCacheKey(input: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  localPreviewUrl?: string | null;
  /** A content-protocol backend's suffix (a `deco serve` endpoint), if any. */
  protocolSuffix?: string | null;
}): string {
  const base = `${input.orgSlug}/${input.virtualMcpId}/${input.branch}`;
  if (input.protocolSuffix) return `${base}${input.protocolSuffix}`;
  return input.localPreviewUrl
    ? `${base}:local:${input.localPreviewUrl}`
    : base;
}

/**
 * The decofile cache key of a content-protocol backend's project (what
 * {@link useDecofileCacheKey} answers for it), for a reader that already
 * holds the backend.
 */
export function protocolDecofileCacheKey(
  params: { orgSlug: string; virtualMcpId: string; branch: string },
  backend: { cacheKeySuffix: string },
): string {
  return decofileCacheKey({
    ...params,
    protocolSuffix: backend.cacheKeySuffix,
  });
}
