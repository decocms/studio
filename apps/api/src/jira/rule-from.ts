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

import { z } from "zod";

const MAX_STATUS_NAME_LENGTH = 200;
const MAX_FROM_STATUSES = 50;

export const JiraStatusNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_STATUS_NAME_LENGTH);

export const RuleFromSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("any") }),
    z.object({ kind: z.literal("earlier") }),
    z.object({ kind: z.literal("later") }),
    z.object({
      kind: z.literal("statuses"),
      statuses: z.array(JiraStatusNameSchema).min(1).max(MAX_FROM_STATUSES),
    }),
  ])
  .describe(
    "Which moves into the status count, by where the issue last " +
      "rested: `any`; `earlier` (a column left of this one on the board — " +
      "the normal flow); `later` (a column right of it — sent back); or " +
      "`statuses`, named outright. A move answers ONE trigger: a list naming " +
      "its origin, else the one for its direction, else `any`.",
  );

export type RuleFrom = z.infer<typeof RuleFromSchema>;

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

/** A trigger's origin rule, from its columns. */
export function ruleFromColumns(trigger: {
  from_kind: RuleFrom["kind"] | null;
  from_statuses: string[];
}): RuleFrom {
  return trigger.from_kind === "statuses"
    ? { kind: "statuses", statuses: trigger.from_statuses }
    : { kind: trigger.from_kind ?? "any" };
}

/**
 * Why `from` cannot join `others` on the same status, or null when it can:
 * a move answers one rule, so two with the same origin, or two lists naming
 * the same status, would leave one of them never firing.
 */
export function ruleConflict(
  status: string,
  from: RuleFrom,
  others: readonly RuleFrom[],
): string | null {
  const key = fromKey(from);
  for (const other of others) {
    if (fromKey(other) === key) {
      return `Another trigger on "${status}" already answers the same origin. A move answers one trigger: change that one instead.`;
    }
    const shared = sharedStatuses(from, other);
    if (shared.length > 0) {
      return (
        `Another trigger on "${status}" already answers moves from ` +
        `${shared.map((name) => `"${name}"`).join(", ")}. A move answers ` +
        "one trigger: take the status out of one of the lists."
      );
    }
  }
  return null;
}
