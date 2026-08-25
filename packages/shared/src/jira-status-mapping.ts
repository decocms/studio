/**
 * The Jira ↔ board status mapping, and the three questions asked of it.
 *
 * The shape is lane → the Jira statuses that mean it, IN BOARD ORDER. Several
 * Jira statuses collapsing into one lane is the normal case: a team with
 * separate "Code Review" and "QA" columns runs both as In Review. So the
 * mapping is many-to-one on the pull, and has to CHOOSE on the push. Order is
 * what makes that choice deterministic and meaningful — position 0 is the
 * lane's leftmost Jira column, which is where a card entering the lane belongs.
 *
 * The legacy shape was the inverse, status → lane, which left the push
 * iterating `Object.entries`: jsonb orders keys by length and then bytes, so
 * the Jira column a card landed in was decided by how many characters its
 * status name happened to have. {@link normalizeStatusMapping} still accepts
 * that shape so a rolling deploy keeps syncing, but nothing writes it.
 *
 * Lanes are plain strings here. Each side narrows at its own boundary (Zod on
 * the server, the tool-IO type on the web) — the questions below are the same
 * whatever the lane vocabulary is.
 */

/** Lane → its Jira statuses, leftmost board column first. */
export type JiraStatusMapping = Record<string, string[]>;

/** The pre-array shape: Jira status name → lane. */
type LegacyJiraStatusMapping = Record<string, string>;

function isLegacyShape(
  raw: Record<string, unknown>,
): raw is LegacyJiraStatusMapping {
  return Object.values(raw).every((v) => typeof v === "string");
}

/**
 * Read a stored mapping in either shape, dropping anything malformed.
 *
 * A Jira status may name only one lane — the settings UI cannot produce a
 * status in two, and honouring one would make the pull's answer depend on
 * iteration order, which is the whole defect this shape exists to remove. The
 * first lane claiming a status keeps it.
 *
 * A legacy row comes back in whatever order Postgres hands its jsonb keys back
 * in, because the old shape never recorded one. That preserves today's
 * arbitrary push target for the length of a rolling deploy rather than fixing
 * it; migration 178 is what fixes it, per row, for good.
 */
export function normalizeStatusMapping(raw: unknown): JiraStatusMapping {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const entries = raw as Record<string, unknown>;

  if (isLegacyShape(entries)) {
    const out: JiraStatusMapping = {};
    for (const [statusName, lane] of Object.entries(entries)) {
      if (!statusName || !lane) continue;
      (out[lane] ??= []).push(statusName);
    }
    return out;
  }

  const out: JiraStatusMapping = {};
  const claimed = new Set<string>();
  for (const [lane, statuses] of Object.entries(entries)) {
    if (!lane || !Array.isArray(statuses)) continue;
    const kept = statuses.filter(
      (s): s is string =>
        typeof s === "string" && s.length > 0 && !claimed.has(s),
    );
    for (const s of kept) claimed.add(s);
    if (kept.length > 0) out[lane] = kept;
  }
  return out;
}

/** Jira status name → lane, for the pull. Built once per sync, not per issue. */
export function laneIndex(mapping: JiraStatusMapping): Map<string, string> {
  const index = new Map<string, string>();
  for (const [lane, statuses] of Object.entries(mapping)) {
    for (const status of statuses) {
      if (!index.has(status)) index.set(status, lane);
    }
  }
  return index;
}

/** A lane's Jira statuses, leftmost board column first. */
export function jiraStatusesForLane(
  mapping: JiraStatusMapping,
  lane: string,
): string[] {
  return mapping[lane] ?? [];
}

/**
 * What the push should do with a card that just entered `lane`.
 *
 * `already-in-lane` is the load-bearing no-op: the issue is somewhere in this
 * lane's own statuses, so whoever put it there — a person on the Jira board, or
 * a later sub-stage move — owns its position within the lane, and dragging it
 * back to position 0 would fight them every tick.
 *
 * `unreachable` is separated from the no-ops so the caller can say so. A lane
 * mapped to a status the issue's workflow will not transition to is a silent
 * dead end otherwise: the card moves on the Studio board and never on Jira's.
 */
export type StatusPushPlan =
  | { kind: "transition"; targetName: string }
  | { kind: "noop"; reason: "unmapped" | "already-in-lane" }
  | { kind: "unreachable"; targets: string[] };

/**
 * The half of the plan that needs nothing from Jira, so a caller can settle the
 * common cases before paying for a `listTransitions` round-trip. Both no-ops
 * are common: most board writes are on lanes the org never mapped, and a card
 * moving within its lane's own statuses hits `already-in-lane` every tick.
 */
export function statusPushNoop(
  mapping: JiraStatusMapping,
  lane: string,
  currentJiraStatus: string | null,
): "unmapped" | "already-in-lane" | null {
  const targets = jiraStatusesForLane(mapping, lane);
  if (targets.length === 0) return "unmapped";
  if (currentJiraStatus && targets.includes(currentJiraStatus)) {
    return "already-in-lane";
  }
  return null;
}

export function planStatusPush(args: {
  mapping: JiraStatusMapping;
  lane: string;
  /** Where the linked issue was last known to be. */
  currentJiraStatus: string | null;
  /** Status names the issue can transition to right now. */
  availableTransitions: string[];
}): StatusPushPlan {
  const reason = statusPushNoop(
    args.mapping,
    args.lane,
    args.currentJiraStatus,
  );
  if (reason) return { kind: "noop", reason };
  const targets = jiraStatusesForLane(args.mapping, args.lane);
  const reachable = new Set(args.availableTransitions);
  const targetName = targets.find((t) => reachable.has(t));
  return targetName
    ? { kind: "transition", targetName }
    : { kind: "unreachable", targets };
}
