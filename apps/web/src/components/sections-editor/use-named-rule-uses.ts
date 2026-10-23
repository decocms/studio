import { useContentChanges, useContentChangeSides } from "./content-changes";
import { namedRuleUses, type NamedRuleUses } from "./named-rule-uses";
import type { LiveMeta } from "./resolve-schema";
import { useContentBackend } from "./use-content-backend";
import { useDecofileCacheKey } from "./use-decofile";

/**
 * Where the draft uses each A/B test and campaign, marked against the
 * published site: the draft's changes (`changes.list`, polled with the
 * content) and both sides of them (`changes.get`, read once per revision)
 * rebuild what is published. Reads nothing else.
 */
export function useNamedRuleUses(input: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown> | undefined;
  meta: LiveMeta | null | undefined;
}): NamedRuleUses | null {
  const params = {
    orgSlug: input.orgSlug,
    virtualMcpId: input.virtualMcpId,
    branch: input.branch,
  };
  const backend = useContentBackend(input.virtualMcpId, input.branch);
  const cacheKey = useDecofileCacheKey(params);
  const changes = useContentChanges(backend, cacheKey || null);
  const sides = useContentChangeSides(backend, cacheKey || null, changes.data);
  if (!input.decofile) return null;
  return namedRuleUses({
    decofile: input.decofile,
    meta: input.meta,
    changeCount: changes.data
      ? Object.keys(changes.data.changes).length
      : undefined,
    sides: sides.data?.entries,
  });
}
