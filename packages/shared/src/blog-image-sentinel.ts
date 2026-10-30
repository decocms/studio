/**
 * The note a drafting model leaves where it wants a picture.
 *
 * `generate:a child's desk in morning light` is an instruction, not an
 * address. Something has to turn it into one, and whatever did not has to
 * blank it: shipped as written it renders a broken image on a published page.
 *
 * Here rather than beside the generator because both sides of the
 * `apps/web ↛ apps/api` wall persist posts — the illustrator tool on the
 * server, the editor's save in the browser — and a sentinel that survives
 * either path is the same broken image. One implementation, no drift.
 */

/** What a model writes into an image prop when it wants one generated. */
export const IMAGE_SENTINEL = "generate:";

/** Where a sentinel sits in a props object, and what it asked for. */
export interface SentinelRequest {
  path: (string | number)[];
  prompt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Every sentinel in a value, wherever it is.
 *
 * Deliberately blind to the block's schema. A schema walk can only find props
 * a site declared as images, and a site whose image prop is a plain
 * `{ type: "string" }` — no `format: image-uri` — declares none. By the time
 * this runs the draft has already said what it wanted by writing the sentinel,
 * and taking its word is the only thing that works everywhere.
 */
export function sentinelRequests(
  value: unknown,
  path: (string | number)[] = [],
): SentinelRequest[] {
  if (typeof value === "string") {
    if (!value.startsWith(IMAGE_SENTINEL)) return [];
    const prompt = value.slice(IMAGE_SENTINEL.length).trim();
    return prompt ? [{ path, prompt }] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, i) => sentinelRequests(entry, [...path, i]));
  }
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, child]) =>
    sentinelRequests(child, [...path, key]),
  );
}

/** The same value with every sentinel blanked. Everything else untouched. */
export function clearSentinels<T>(value: T): T {
  if (typeof value === "string") {
    return (value.startsWith(IMAGE_SENTINEL) ? "" : value) as T;
  }
  if (Array.isArray(value)) return value.map(clearSentinels) as T;
  const record = asRecord(value);
  if (!record) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    out[key] = clearSentinels(child);
  }
  return out as T;
}
