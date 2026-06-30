import { defaultVariantRule } from "../section-types";
import { isDefaultVariantRule } from "../section-variants";

export interface MediaVariant {
  rule: Record<string, unknown>;
  value: string;
}

export interface MediaMultivariateWrapper {
  __resolveType: string;
  variants: MediaVariant[];
}

/** Type guard for the multivariate media wrapper shape. */
export function isMediaMultivariateWrapper(
  value: unknown,
): value is MediaMultivariateWrapper {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.__resolveType === "string" && Array.isArray(obj.variants);
}

/** Extract the variants array from a multivariate wrapper. */
export function parseMediaVariants(
  value: MediaMultivariateWrapper,
): MediaVariant[] {
  return value.variants.map((v) => ({
    rule: (v.rule as Record<string, unknown>) ?? defaultVariantRule(),
    value: typeof v.value === "string" ? v.value : "",
  }));
}

/** Convert a plain URL string into a multivariate wrapper with two "always" variants. */
export function wrapAsMediaMultivariate(
  url: string,
  resolveType: string,
): MediaMultivariateWrapper {
  return {
    __resolveType: resolveType,
    variants: [
      { rule: defaultVariantRule(), value: url },
      { rule: defaultVariantRule(), value: url },
    ],
  };
}

/** Pick the "always" variant URL (or last), return plain string. */
export function flattenMediaMultivariate(
  wrapper: MediaMultivariateWrapper,
): string {
  const variants = wrapper.variants;
  if (variants.length === 0) return "";

  const always = variants.find((v) =>
    isDefaultVariantRule(v.rule as Record<string, unknown> | undefined),
  );
  if (always) return typeof always.value === "string" ? always.value : "";

  const last = variants[variants.length - 1];
  return typeof last?.value === "string" ? last.value : "";
}

/** Add a variant cloned from last. */
export function appendMediaVariant(
  wrapper: MediaMultivariateWrapper,
): MediaMultivariateWrapper {
  const variants = [...wrapper.variants];
  const last = variants[variants.length - 1];
  const newVariant: MediaVariant = {
    rule: defaultVariantRule(),
    value: last ? (typeof last.value === "string" ? last.value : "") : "",
  };
  return { ...wrapper, variants: [...variants, newVariant] };
}

/** Remove variant at index. Returns null if only 1 variant remains (can't delete). */
export function deleteMediaVariant(
  wrapper: MediaMultivariateWrapper,
  index: number,
): MediaMultivariateWrapper | null {
  if (wrapper.variants.length <= 1) return null;
  const variants = [...wrapper.variants];
  variants.splice(index, 1);
  return { ...wrapper, variants };
}

/** Clone variant at index, inserting the clone right after. */
export function duplicateMediaVariant(
  wrapper: MediaMultivariateWrapper,
  index: number,
): MediaMultivariateWrapper {
  const variants = [...wrapper.variants];
  const source = variants[index];
  if (!source) return wrapper;
  variants.splice(index + 1, 0, structuredClone(source));
  return { ...wrapper, variants };
}

/** Reorder variants by moving from one index to another. */
export function reorderMediaVariant(
  wrapper: MediaMultivariateWrapper,
  from: number,
  to: number,
): MediaMultivariateWrapper {
  const variants = [...wrapper.variants];
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= variants.length ||
    to >= variants.length
  ) {
    return wrapper;
  }
  const [moved] = variants.splice(from, 1);
  if (!moved) return wrapper;
  variants.splice(to, 0, moved);
  return { ...wrapper, variants };
}

/** Update the URL at a given variant index. */
export function updateMediaVariantValue(
  wrapper: MediaMultivariateWrapper,
  index: number,
  url: string,
): MediaMultivariateWrapper {
  const variants = [...wrapper.variants];
  const current = variants[index];
  if (!current) return wrapper;
  variants[index] = { ...current, value: url };
  return { ...wrapper, variants };
}

/** Update the matcher rule at a given variant index. */
export function updateMediaVariantRule(
  wrapper: MediaMultivariateWrapper,
  index: number,
  rule: Record<string, unknown>,
): MediaMultivariateWrapper {
  const variants = [...wrapper.variants];
  const current = variants[index];
  if (!current) return wrapper;
  variants[index] = { ...current, rule };
  return { ...wrapper, variants };
}
