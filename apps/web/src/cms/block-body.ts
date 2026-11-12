/** The key that marks an index stub: a block whose body isn't loaded. */
export const INDEX_STUB = "__indexStub";
/** An index stub's direct references (the index's `meta.refs`). */
export const INDEX_STUB_REFS = "__indexRefs";

/** Whether `value` is an index stub (or a copy of one). */
export function isIndexStub(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, INDEX_STUB)
  );
}

/**
 * The names an index stub's block references directly (its index
 * `meta.refs`); `[]` for anything else.
 */
export function indexStubRefs(value: unknown): string[] {
  if (!isIndexStub(value)) return [];
  const refs = (value as Record<string, unknown>)[INDEX_STUB_REFS];
  return Array.isArray(refs)
    ? refs.filter((ref): ref is string => typeof ref === "string")
    : [];
}

/** The names of `set` whose value is an index stub: never written. */
export function stubNames(set: Record<string, unknown> | undefined): string[] {
  return Object.entries(set ?? {})
    .filter(([, value]) => containsIndexStub(value))
    .map(([name]) => name);
}

/** Stubs copied into nested fields are incomplete bodies too. */
function containsIndexStub(value: unknown): boolean {
  if (isIndexStub(value)) return true;
  if (Array.isArray(value)) return value.some(containsIndexStub);
  return (
    !!value &&
    typeof value === "object" &&
    Object.values(value).some(containsIndexStub)
  );
}

/** Only a body may seed an editor; metadata is for listings. */
export function isBlockBody(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !containsIndexStub(value)
  );
}
