import { useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";
import type { ResolvedSeo, SeoTarget } from "./seo-block";
import { useDebouncedSaveBlock } from "./use-save-block";

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/**
 * Merges edited SEO into the latest decofile block at save time (read-modify-write),
 * so concurrent section/name/path edits are not clobbered by a render-time snapshot.
 */
export function buildSeoSavePayload(
  target: SeoTarget,
  resolved: ResolvedSeo,
  latestBlock: unknown,
  seoValue: Record<string, unknown>,
): Record<string, unknown> | null {
  if (target.kind === "page") {
    if (!isPlainObject(latestBlock)) return null;
    return { ...latestBlock, seo: seoValue };
  }
  if (!isPlainObject(latestBlock)) return null;
  if (resolved.siteKind === "block") return seoValue;
  return { ...latestBlock, seo: seoValue };
}

export function activeSeoResolveType(
  effectiveSeo: Record<string, unknown>,
  resolved: ResolvedSeo,
): string {
  const rt = effectiveSeo.__resolveType;
  return typeof rt === "string" && rt.length > 0 ? rt : resolved.seoResolveType;
}

interface UseSeoFormSaveParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  target: SeoTarget;
  resolved: ResolvedSeo | null;
  onSaved?: () => void;
}

/** Debounced SEO persist with fire-time decofile merge and explicit flush on close. */
export function useSeoFormSave({
  orgSlug,
  virtualMcpId,
  branch,
  target,
  resolved,
  onSaved,
}: UseSeoFormSaveParams) {
  const queryClient = useQueryClient();
  const cacheKey = `${orgSlug}/${virtualMcpId}/${branch}`;
  const { save, flush, isPending } = useDebouncedSaveBlock(
    { orgSlug, virtualMcpId, branch },
    { onSaved },
  );

  const persistSeo = (seoValue: Record<string, unknown>) => {
    if (!resolved) return;
    save(resolved.blockKey, () => {
      const decofile = queryClient.getQueryData<Record<string, unknown>>(
        KEYS.decofile(cacheKey),
      );
      const latest = decofile?.[resolved.blockKey];
      return buildSeoSavePayload(target, resolved, latest, seoValue);
    });
  };

  return { persistSeo, flush, isPending };
}
