import { isLazyResolveType } from "@/components/sections-editor/section-lazy";
import { isNeverMatcherResolveType } from "@/components/sections-editor/section-types";
import {
  isVariantsBlockType,
  variantValueOn,
} from "@/components/sections-editor/variant-shape";

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
  /** A Blocks v8 site: its short `multivariate` and `never`, lazy values. */
  v8 = false,
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
  if (
    rt.includes("flags/multivariate") ||
    (v8 && isVariantsBlockType(rt, v8))
  ) {
    const variants = Array.isArray(obj.variants) ? obj.variants : [];
    const allNever =
      variants.length === 0 ||
      variants.every((v) => {
        const rule = (v as { rule?: { __resolveType?: unknown } })?.rule;
        return isNeverMatcherResolveType(rule?.__resolveType, v8);
      });
    if (allNever) return null;
    const keys: string[] = [];
    for (const v of variants) {
      const value = variantValueOn(v, v8);
      if (value && typeof value === "object") {
        for (const k of resolveSectionCandidates(
          value as { __resolveType?: unknown },
          decofile,
          v8,
        ) ?? []) {
          if (!keys.includes(k)) keys.push(k);
        }
      }
    }
    return keys;
  }
  // Suffix-tolerant like every other lazy check; a never-rendering inner = null.
  if (isLazyResolveType(rt)) {
    const inner =
      obj.section && typeof obj.section === "object"
        ? resolveSectionCandidates(
            obj.section as { __resolveType?: unknown },
            decofile,
            v8,
          )
        : [];
    if (inner === null) return null;
    return inner.length ? [rt, ...inner] : [rt];
  }
  return [rt];
}
