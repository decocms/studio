/**
 * Parse a CLI flag as a positive integer, or `undefined` when the flag was
 * not passed. Throws (naming the flag) on anything else — used to fail fast
 * instead of letting `Number(raw)` produce a silent NaN that flows into a
 * pagination limit (e.g. `LIMIT NaN` in a SQL query).
 */
export function parsePositiveIntFlag(
  flag: string,
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid --${flag} "${raw}" — must be a positive integer.`);
  }
  return value;
}
