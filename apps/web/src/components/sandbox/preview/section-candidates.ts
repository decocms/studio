import { isLazyResolveType } from "@/components/sections-editor/section-lazy";
import { NEVER_MATCHER_RESOLVE_TYPE } from "@/components/sections-editor/section-types";

/**
 * Candidate top-level `data-manifest-key`s a page section can render as, used
 * iframe-side to align the editable run within the DOM. Saved-block refs
 * (globals) resolve to their underlying component. A Lazy returns BOTH its
 * loader key and the inner section's key — the classic runtime keeps the Lazy
 * wrapper at top level, TanStack renders the inner section directly.
 * Multivariate flags collect every variant's possible key; when NO variant can
 * ever render (all gated by `never` — the hidden-section shape) the flag
 * resolves to nothing and produces no DOM node at all, signalled as null so
 * the iframe alignment doesn't consume a DOM node for it.
 */
export function resolveSectionCandidates(
  section: { __resolveType?: unknown; section?: unknown; variants?: unknown },
  decofile: Record<string, unknown>,
): string[] | null {
  let obj: { __resolveType?: unknown; section?: unknown; variants?: unknown } =
    section;
  let rt = typeof obj?.__resolveType === "string" ? obj.__resolveType : "";
  for (let i = 0; rt && i < 5; i++) {
    const block = decofile[rt];
    if (block && typeof block === "object" && "__resolveType" in block) {
      const next = (block as { __resolveType?: unknown }).__resolveType;
      if (typeof next === "string" && next && next !== rt) {
        obj = block as typeof obj;
        rt = next;
        continue;
      }
    }
    break;
  }
  if (!rt) return [];
  // Multivariate (A/B) renders one of its variants — collect every variant's
  // possible key so it matches whichever rendered (NOT a blind wildcard, which
  // could otherwise grab an adjacent framework section). When EVERY variant is
  // gated by a `never` matcher (the hidden-section shape) the flag renders
  // nothing → null. A partially-never multivariate keeps all variants' keys:
  // a never variant can still render under a matcher override.
  if (rt.includes("flags/multivariate")) {
    const variants = Array.isArray(obj.variants) ? obj.variants : [];
    const allNever =
      variants.length === 0 ||
      variants.every((v) => {
        const rule = (v as { rule?: { __resolveType?: unknown } })?.rule;
        return rule?.__resolveType === NEVER_MATCHER_RESOLVE_TYPE;
      });
    if (allNever) return null;
    const keys: string[] = [];
    for (const v of variants) {
      const value = (v as { value?: unknown })?.value;
      if (value && typeof value === "object") {
        for (const k of resolveSectionCandidates(
          value as { __resolveType?: unknown },
          decofile,
        ) ?? []) {
          if (!keys.includes(k)) keys.push(k);
        }
      }
    }
    return keys;
  }
  // A Lazy whose inner section can never render effectively renders nothing.
  // Suffix-tolerant (and covering SingleDeferred) like every other lazy check —
  // a strict equality here silently dropped the inner key from the candidates,
  // so the wrapper-less TanStack render matched nothing.
  if (isLazyResolveType(rt)) {
    const inner =
      obj.section && typeof obj.section === "object"
        ? resolveSectionCandidates(
            obj.section as { __resolveType?: unknown },
            decofile,
          )
        : [];
    if (inner === null) return null;
    return inner.length ? [rt, ...inner] : [rt];
  }
  return [rt];
}
