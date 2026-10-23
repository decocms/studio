import { useQueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import type { LiveMeta } from "./resolve-schema";
import { declaresBuiltInPage } from "./section-catalog";
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

/**
 * The page block with its `seo` set to `rawSeo` (`null`: SEO turned off). On a
 * next-major site turning SEO off drops the field instead: its page schema may
 * list no `seo` at all, and there even `seo: null` is an unknown field that
 * `deco check` (and so the site's build) rejects. v7 pages keep `seo: null`.
 */
export function withPageSeo(
  block: Record<string, unknown>,
  rawSeo: Record<string, unknown> | null,
  meta: LiveMeta | null | undefined,
): Record<string, unknown> {
  if (rawSeo === null && declaresBuiltInPage(meta ?? undefined)) {
    const { seo: _dropped, ...rest } = block;
    return rest;
  }
  return { ...block, seo: rawSeo };
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
  /** The site's schema: decides how turning SEO off is saved. */
  meta?: LiveMeta | null;
  onSaved?: () => void;
}

/** Debounced SEO persist with fire-time decofile merge and explicit flush on close. */
export function useSeoFormSave({
  orgSlug,
  virtualMcpId,
  branch,
  target,
  resolved,
  meta,
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
      return withPageSeo(latest, rawSeo, meta);
    });
  };

  return { persistSeo, persistRawSeo, flush, isPending };
}
