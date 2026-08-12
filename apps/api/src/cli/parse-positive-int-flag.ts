/**
 * Parse a CLI flag as a positive integer, or `undefined` when the flag was
 * not passed. Throws (naming the flag) on anything else — used to fail fast
 * instead of letting `Number(raw)` produce a silent NaN that flows into a
 * pagination limit (e.g. `LIMIT NaN` in a SQL query).
 */
export function parsePositiveIntFlag(
  flag: string,
  raw: string | undefined,
  max?: number,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    (max !== undefined && value > max)
  ) {
    throw new Error(
      `Invalid --${flag} "${raw}" — must be a positive integer${
        max !== undefined ? ` up to ${max}` : ""
      }.`,
    );
  }
  return value;
}
