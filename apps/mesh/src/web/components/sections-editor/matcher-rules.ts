import {
  isAutoPreviewBlockKey,
  isManifestMatcherResolveType,
  isSavedBlockResolveType,
} from "./block-type-utils";
import { globalSectionLabel } from "./page-list";
import type { LiveMeta } from "./resolve-schema";

const PAGE_RESOLVE_TYPES = new Set([
  "website/pages/Page.tsx",
  "$live/pages/LivePage.tsx",
]);

export interface UnwrappedMatcherRule {
  resolveType: string;
  data: Record<string, unknown>;
  blockKey?: string;
}

function isMatcherModuleResolveType(resolveType: string): boolean {
  return resolveType.includes("matchers") || resolveType.includes("Match");
}

function isMatcherBlockData(
  blockData: Record<string, unknown>,
  meta?: LiveMeta | null,
): boolean {
  const moduleRt = blockData.__resolveType;
  if (typeof moduleRt !== "string" || !moduleRt) return false;
  if (PAGE_RESOLVE_TYPES.has(moduleRt)) return false;

  if (meta) {
    return isManifestMatcherResolveType(meta, moduleRt);
  }

  return isMatcherModuleResolveType(moduleRt);
}

/** A saved matcher block (a global rule) stored in the decofile. */
export interface SavedMatcherBlock {
  /** Decofile key used as the `__resolveType` reference (e.g. `TestHero`). */
  blockKey: string;
  /** The underlying matcher module (e.g. `website/matchers/random.ts`). */
  matcherResolveType: string;
  /** Optional display name stored on the block. */
  name?: string;
}

/**
 * List all saved matcher blocks (global rules) in the decofile — decofile
 * entries keyed by a bare id (no module path) whose body is a matcher block.
 * These are what the rule picker offers under "Saved rules" so a variant can
 * reference an existing global instead of an inline matcher.
 */
export function listSavedMatcherBlocks(
  meta: LiveMeta | null | undefined,
  decofile: Record<string, unknown>,
): SavedMatcherBlock[] {
  const entries: SavedMatcherBlock[] = [];

  for (const [key, val] of Object.entries(decofile)) {
    if (key.includes("/") || !isSavedBlockResolveType(key)) continue;
    if (isAutoPreviewBlockKey(key)) continue;
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;

    const obj = val as Record<string, unknown>;
    if (!isMatcherBlockData(obj, meta)) continue;

    entries.push({
      blockKey: key,
      matcherResolveType: (obj.__resolveType as string) ?? "",
      name: typeof obj.name === "string" ? obj.name : undefined,
    });
  }

  return entries.sort((a, b) =>
    (a.name ?? a.blockKey).localeCompare(b.name ?? b.blockKey),
  );
}

export function isSavedMatcherBlockReference(
  rule: Record<string, unknown> | undefined,
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): boolean {
  if (!rule) return false;
  const rt = rule.__resolveType;
  if (typeof rt !== "string" || !isSavedBlockResolveType(rt)) return false;
  if (!Object.hasOwn(decofile, rt)) return false;

  const blockData = decofile[rt] as Record<string, unknown>;
  if (!blockData || typeof blockData !== "object" || Array.isArray(blockData)) {
    return false;
  }

  return isMatcherBlockData(blockData, meta);
}

export function getSavedMatcherBlockKey(
  rule: Record<string, unknown> | undefined,
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): string | null {
  if (!isSavedMatcherBlockReference(rule, decofile, meta)) return null;
  return (rule?.__resolveType as string) ?? null;
}

export function unwrapMatcherRule(
  rule: Record<string, unknown> | undefined,
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): UnwrappedMatcherRule | null {
  if (!rule) return null;
  const rt = (rule.__resolveType as string) ?? "";
  if (!rt) return null;

  if (isSavedMatcherBlockReference(rule, decofile, meta)) {
    const blockData = (decofile[rt] as Record<string, unknown>) ?? {};
    const matcherRt = (blockData.__resolveType as string) ?? rt;
    const { __resolveType: _, name: _name, ...data } = blockData;
    return { resolveType: matcherRt, data, blockKey: rt };
  }

  const { __resolveType: _, ...data } = rule;
  return { resolveType: rt, data };
}

export function inlineMatcherRule(
  rule: Record<string, unknown> | undefined,
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): Record<string, unknown> {
  const unwrapped = unwrapMatcherRule(rule, decofile, meta);
  if (!unwrapped) return { __resolveType: "" };
  return { __resolveType: unwrapped.resolveType, ...unwrapped.data };
}

export function resolveEffectiveMatcherRule(
  rule: Record<string, unknown> | undefined,
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): Record<string, unknown> | undefined {
  if (!rule) return undefined;
  if (isSavedMatcherBlockReference(rule, decofile, meta)) {
    return inlineMatcherRule(rule, decofile, meta);
  }
  return rule;
}

export function resolveVariantRuleLabel(
  rule: Record<string, unknown> | undefined,
  decofile: Record<string, unknown>,
  formatMatcher: (rule?: Record<string, unknown>) => string,
  meta?: LiveMeta | null,
): string {
  if (!rule) return "Default";
  if (isSavedMatcherBlockReference(rule, decofile, meta)) {
    const blockKey = (rule.__resolveType as string) ?? "";
    const block = decofile[blockKey] as Record<string, unknown>;
    return globalSectionLabel(blockKey, block);
  }
  return formatMatcher(rule);
}

export function buildMatcherBlockData(
  resolveType: string,
  data: Record<string, unknown>,
  displayName: string,
): Record<string, unknown> {
  return {
    __resolveType: resolveType,
    ...data,
    name: displayName,
  };
}

export function buildMatcherBlockReference(
  blockKey: string,
): Record<string, unknown> {
  return { __resolveType: blockKey };
}

export function readMatcherRuleFormState(
  rule: Record<string, unknown> | undefined,
  decofile: Record<string, unknown>,
  meta?: LiveMeta | null,
): { resolveType: string; formValue: Record<string, unknown> } {
  const unwrapped = unwrapMatcherRule(rule, decofile, meta);
  if (!unwrapped) {
    return { resolveType: "", formValue: {} };
  }
  return { resolveType: unwrapped.resolveType, formValue: unwrapped.data };
}
