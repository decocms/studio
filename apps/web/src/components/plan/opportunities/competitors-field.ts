/**
 * The competitors list the member edits before saving it to the engine. The
 * engine normalizes and checks every domain again; this keeps the list clean
 * while it is typed.
 */

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** A typed or pasted store as the engine stores it: the host only, so a
 *  rejection names the same domain the chip shows. */
export function normalizeDraft(raw: string): string | null {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "");
  return DOMAIN.test(host) ? host : null;
}

/** The engine treats "www.x" and "x" as the same store. */
const storeOf = (domain: string) => domain.replace(/^www\./, "");

export function addDomain(
  list: string[],
  raw: string,
): { list: string[]; error: "invalid" | "duplicate" | null } {
  const domain = normalizeDraft(raw);
  if (!domain) return { list, error: "invalid" };
  if (list.some((d) => storeOf(d) === storeOf(domain))) {
    return { list, error: "duplicate" };
  }
  return { list: [...list, domain], error: null };
}

/** A list from the engine as the form edits it and saves it back: each
 *  domain normalized, once per store, what does not parse left out. */
export function cleanList(list: readonly string[]): string[] {
  return list.reduce<string[]>((kept, raw) => addDomain(kept, raw).list, []);
}

/** An empty list would hand the choice back to the engine, which is not
 *  what saving here means. */
export function canSave(list: string[]): boolean {
  return list.length > 0;
}
