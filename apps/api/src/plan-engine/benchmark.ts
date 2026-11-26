/** Normalizes what the user or the model wrote into a clean domain. */
export function normalizeDomain(raw: string): string | null {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}

/** How many stores the benchmark compares. */
export const MAX_COMPETITORS = 5;
