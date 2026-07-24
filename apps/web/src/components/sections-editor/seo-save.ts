import { useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import type { ResolvedSeo, SeoTarget } from "./seo-block";
import { wrapSeoPersistValue } from "./seo-lazy-render";
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
  seoValue: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (target.kind === "page") {
    if (!isPlainObject(latestBlock)) return null;
    const rawForWrap =
      latestBlock.seo !== undefined ? latestBlock.seo : resolved.rawSeoData;
    return {
      ...latestBlock,
      seo: seoValue === null ? null : wrapSeoPersistValue(seoValue, rawForWrap),
    };
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

  const persistSeo = (seoValue: Record<string, unknown> | null) => {
    if (!resolved) return;
    save(resolved.blockKey, () => {
      const decofile = queryClient.getQueryData<Record<string, unknown>>(
        KEYS.decofile(cacheKey),
      );
      const latest = decofile?.[resolved.blockKey];
      return buildSeoSavePayload(target, resolved, latest, seoValue);
    });
  };

  /** Persists the full `page.seo` value (enable/disable, async render toggles). */
  const persistRawSeo = (rawSeo: Record<string, unknown> | null) => {
    if (!resolved || target.kind !== "page") return;
    save(resolved.blockKey, () => {
      const decofile = queryClient.getQueryData<Record<string, unknown>>(
        KEYS.decofile(cacheKey),
      );
      const latest = decofile?.[resolved.blockKey];
      if (!isPlainObject(latest)) return null;
      return { ...latest, seo: rawSeo };
    });
  };

  return { persistSeo, persistRawSeo, flush, isPending };
}
