/** Minimal branch description needed to infer the active branch from a value. */
export interface InlineUnionBranchLike {
  discriminators?: Record<string, string | number>;
  /** All property keys of the branch object schema. */
  propertyKeys: string[];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Pick which union branch a stored value belongs to.
 *
 * 1. If a branch has const discriminator fields (e.g. `name: "max-age"`) and the
 *    value matches all of them, that branch wins — unambiguous.
 * 2. Otherwise score branches by how many of their own (non-discriminator)
 *    fields are actually set in the value (Location vs Map is disjoint, so this
 *    is decisive). Ties and empty values fall back to the first branch.
 */
export function inferInlineUnionIndex(
  value: unknown,
  branches: readonly InlineUnionBranchLike[],
): number {
  if (branches.length === 0) return 0;
  const obj = asObject(value);

  for (let i = 0; i < branches.length; i++) {
    const disc = branches[i]!.discriminators;
    if (disc && Object.keys(disc).length > 0) {
      const matches = Object.entries(disc).every(([k, v]) => obj[k] === v);
      if (matches) return i;
    }
  }

  let bestIndex = 0;
  let bestScore = -1;
  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i]!;
    const discKeys = new Set(Object.keys(branch.discriminators ?? {}));
    const ownKeys = branch.propertyKeys.filter((k) => !discKeys.has(k));
    const score = ownKeys.filter(
      (k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== "",
    ).length;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}
