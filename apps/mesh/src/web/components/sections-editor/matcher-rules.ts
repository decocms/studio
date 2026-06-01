import { isSavedBlockResolveType } from "./block-type-utils";
import { globalSectionLabel } from "./page-list";

export interface UnwrappedMatcherRule {
  resolveType: string;
  data: Record<string, unknown>;
  blockKey?: string;
}

export function isSavedMatcherBlockReference(
  rule: Record<string, unknown> | undefined,
  decofile: Record<string, unknown>,
): boolean {
  if (!rule) return false;
  const rt = (rule.__resolveType as string) ?? "";
  return isSavedBlockResolveType(rt) && rt in decofile;
}

export function unwrapMatcherRule(
  rule: Record<string, unknown> | undefined,
  decofile: Record<string, unknown>,
): UnwrappedMatcherRule | null {
  if (!rule) return null;
  const rt = (rule.__resolveType as string) ?? "";
  if (!rt) return null;

  if (isSavedMatcherBlockReference(rule, decofile)) {
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
): Record<string, unknown> {
  const unwrapped = unwrapMatcherRule(rule, decofile);
  if (!unwrapped) return { __resolveType: "" };
  return { __resolveType: unwrapped.resolveType, ...unwrapped.data };
}

export function resolveEffectiveMatcherRule(
  rule: Record<string, unknown> | undefined,
  decofile: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!rule) return undefined;
  if (isSavedMatcherBlockReference(rule, decofile)) {
    return inlineMatcherRule(rule, decofile);
  }
  return rule;
}

export function resolveVariantRuleLabel(
  rule: Record<string, unknown> | undefined,
  decofile: Record<string, unknown>,
  formatMatcher: (rule?: Record<string, unknown>) => string,
): string {
  if (!rule) return "Default";
  if (isSavedMatcherBlockReference(rule, decofile)) {
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
): { resolveType: string; formValue: Record<string, unknown> } {
  const unwrapped = unwrapMatcherRule(rule, decofile);
  if (!unwrapped) {
    return { resolveType: "", formValue: {} };
  }
  return { resolveType: unwrapped.resolveType, formValue: unwrapped.data };
}
