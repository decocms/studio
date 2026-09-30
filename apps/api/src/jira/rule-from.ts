/**
 * Which moves into a status a rule answers, by where the card came from.
 *
 * A status can carry several rules, one per origin: the implementing column
 * does one thing with a card arriving from the backlog and another with one a
 * reviewer or the client sent back. "Earlier" and "later" are the board's
 * column order, so a rule survives columns being added or renamed; a list
 * names statuses outright, for the moves order cannot tell apart.
 *
 * The origin is where the card last RESTED (`settle.ts`), not the column it
 * was dropped through.
 */

export type RuleFrom =
  | { kind: "any" }
  | { kind: "earlier" }
  | { kind: "later" }
  | { kind: "statuses"; statuses: string[] };

/** Where the origin sits relative to the destination on the board, or null
 *  when either is off it or both share a column. */
export type Direction = "earlier" | "later" | null;

/** Trimmed, one of each regardless of case, in a stable order — so the same
 *  list typed twice is the same rule. */
export function normalizeFrom(from: RuleFrom): RuleFrom {
  if (from.kind !== "statuses") return { kind: from.kind };
  const seen = new Map<string, string>();
  for (const raw of from.statuses) {
    const name = raw.trim();
    if (name && !seen.has(name.toLowerCase())) {
      seen.set(name.toLowerCase(), name);
    }
  }
  const statuses = [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, name]) => name);
  return { kind: "statuses", statuses };
}

/** The rule's identity within its status: at most one rule per key. */
export function fromKey(from: RuleFrom): string {
  const normal = normalizeFrom(from);
  if (normal.kind !== "statuses") return normal.kind;
  return `statuses:${normal.statuses.map((s) => s.toLowerCase()).join("\n")}`;
}

/** Statuses two lists on the same destination both claim. Two such rules
 *  would leave the move they share with no single answer. */
export function sharedStatuses(a: RuleFrom, b: RuleFrom): string[] {
  if (a.kind !== "statuses" || b.kind !== "statuses") return [];
  const other = new Set(b.statuses.map((s) => s.toLowerCase()));
  return a.statuses.filter((s) => other.has(s.toLowerCase()));
}

/**
 * The one rule a move answers to: a list naming the origin, else the rule for
 * its direction, else the one for any origin. Never two — two runs on one
 * card would each supersede the other.
 */
export function pickRule<R extends { from: RuleFrom }>(
  rules: readonly R[],
  origin: string | null,
  direction: Direction,
): R | null {
  const named = origin?.toLowerCase();
  return (
    rules.find(
      (r) =>
        r.from.kind === "statuses" &&
        named !== undefined &&
        r.from.statuses.some((s) => s.toLowerCase() === named),
    ) ??
    (direction ? rules.find((r) => r.from.kind === direction) : undefined) ??
    rules.find((r) => r.from.kind === "any") ??
    null
  );
}

/** `columns` is each board column's status ids, left to right. */
export function directionOf(
  columns: readonly (readonly string[])[],
  fromId: string | null,
  toId: string | null,
): Direction {
  if (!fromId || !toId) return null;
  const from = columns.findIndex((ids) => ids.includes(fromId));
  const to = columns.findIndex((ids) => ids.includes(toId));
  if (from < 0 || to < 0 || from === to) return null;
  return from < to ? "earlier" : "later";
}

/** Whether picking between these rules needs the board's column order. */
export function needsDirection(rules: readonly { from: RuleFrom }[]): boolean {
  return rules.some(
    (r) => r.from.kind === "earlier" || r.from.kind === "later",
  );
}
