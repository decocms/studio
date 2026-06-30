import { defaultVariantRule } from "../section-types";
import { isDefaultVariantRule } from "../section-variants";

export interface MultivariateVariant {
  rule: Record<string, unknown>;
  value: unknown;
}

export interface MultivariateWrapper {
  __resolveType: string;
  variants: MultivariateVariant[];
}

/** Type guard for the multivariate wrapper shape. */
export function isMultivariateWrapper(
  value: unknown,
): value is MultivariateWrapper {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.__resolveType === "string" && Array.isArray(obj.variants);
}

/** Convert a plain value into a multivariate wrapper with two "always" variants. */
export function wrapAsMultivariate(
  value: unknown,
  resolveType: string,
): MultivariateWrapper {
  return {
    __resolveType: resolveType,
    variants: [
      { rule: defaultVariantRule(), value: structuredClone(value) },
      { rule: defaultVariantRule(), value: structuredClone(value) },
    ],
  };
}

/** Pick the "always" variant value (or last). */
export function flattenMultivariate(wrapper: MultivariateWrapper): unknown {
  const variants = wrapper.variants;
  if (variants.length === 0) return undefined;

  const always = variants.find((v) =>
    isDefaultVariantRule(v.rule as Record<string, unknown> | undefined),
  );
  if (always) return always.value;

  return variants[variants.length - 1]?.value;
}

/** Add a variant cloned from last. */
export function appendVariant(
  wrapper: MultivariateWrapper,
): MultivariateWrapper {
  const variants = [...wrapper.variants];
  const last = variants[variants.length - 1];
  const newVariant: MultivariateVariant = {
    rule: defaultVariantRule(),
    value: last ? structuredClone(last.value) : undefined,
  };
  return { ...wrapper, variants: [...variants, newVariant] };
}

/** Remove variant at index. Returns null if only 1 variant remains (can't delete). */
export function deleteVariant(
  wrapper: MultivariateWrapper,
  index: number,
): MultivariateWrapper | null {
  if (wrapper.variants.length <= 1) return null;
  const variants = [...wrapper.variants];
  variants.splice(index, 1);
  return { ...wrapper, variants };
}

/** Clone variant at index, inserting the clone right after. */
export function duplicateVariant(
  wrapper: MultivariateWrapper,
  index: number,
): MultivariateWrapper {
  const variants = [...wrapper.variants];
  const source = variants[index];
  if (!source) return wrapper;
  variants.splice(index + 1, 0, structuredClone(source));
  return { ...wrapper, variants };
}

/** Reorder variants by moving from one index to another. */
export function reorderVariant(
  wrapper: MultivariateWrapper,
  from: number,
  to: number,
): MultivariateWrapper {
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

/** Update the value at a given variant index. */
export function updateVariantValue(
  wrapper: MultivariateWrapper,
  index: number,
  value: unknown,
): MultivariateWrapper {
  const variants = [...wrapper.variants];
  const current = variants[index];
  if (!current) return wrapper;
  variants[index] = { ...current, value };
  return { ...wrapper, variants };
}

/** Update the matcher rule at a given variant index. */
export function updateVariantRule(
  wrapper: MultivariateWrapper,
  index: number,
  rule: Record<string, unknown>,
): MultivariateWrapper {
  const variants = [...wrapper.variants];
  const current = variants[index];
  if (!current) return wrapper;
  variants[index] = { ...current, rule };
  return { ...wrapper, variants };
}
