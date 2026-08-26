/**
 * Reading Jira's Sprint field, and trimming a saved filter's JQL.
 *
 * Sprint is a CUSTOM field, so its id (`customfield_10020`) differs per site
 * and has to be discovered before it can be asked for — {@link
 * findSprintFieldId} over `/rest/api/3/field`. Its value is a list, not one
 * sprint: an issue carried over from a finished sprint stays in both.
 *
 * Pure on purpose — the shapes here are what a tenant's Jira actually sends,
 * which is the part worth pinning in tests.
 */

import { isSprintState, type SprintState } from "@decocms/shared/sprints";

/** Marks the Sprint field among a site's custom fields. */
const SPRINT_FIELD_SCHEMA = "com.pyxis.greenhopper.jira:gh-sprint";

export interface JiraSprintRef {
  /** Jira's own sprint id, as a string — our mirror key. */
  id: string;
  name: string;
  state: SprintState;
  startsAt: Date | null;
  endsAt: Date | null;
}

export interface JiraFieldDescriptor {
  id: string;
  schema?: { custom?: string } | null;
}

/**
 * Every Sprint field on the site, in the order Jira lists them.
 *
 * Plural, not one: Cloud gives each team-managed project its OWN Sprint field,
 * so the first match is only the right field for issues of one project. Empty
 * on a Jira without Jira Software, where sprints don't exist at all.
 */
export function findSprintFieldIds(
  fields: readonly JiraFieldDescriptor[],
): string[] {
  return fields
    .filter((field) => field.schema?.custom === SPRINT_FIELD_SCHEMA)
    .map((field) => field.id);
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * The sprints an issue's Sprint field names.
 *
 * The order Jira sends is NOT chronological — a real issue carried into the
 * running sprint answers `[Sprint 4 (active), Sprint 3 (closed)]`, and another
 * answers `[Sprint 2, Sprint 3, Sprint 1, Sprint 2]`. Nothing here or in
 * {@link pickIssueSprint} may lean on position.
 *
 * Anything unrecognizable is dropped rather than guessed: Jira Server used to
 * send these as `...Sprint@1a2b[id=7,state=ACTIVE,name=…]` strings, and
 * scraping that would put a fabricated sprint on a customer's board. Cloud —
 * the only host this client talks to — sends objects.
 *
 * A `state` Jira has never sent reads as `future`: state only decides where the
 * sprint sorts, and claiming `active` would move the board's default sprint.
 */
export function parseSprintRefs(value: unknown): JiraSprintRef[] {
  if (!Array.isArray(value)) return [];
  const refs: JiraSprintRef[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const id =
      typeof raw.id === "number"
        ? String(raw.id)
        : typeof raw.id === "string" && raw.id !== ""
          ? raw.id
          : null;
    if (id === null) continue;
    const state =
      typeof raw.state === "string" ? raw.state.toLowerCase() : null;
    refs.push({
      id,
      name:
        typeof raw.name === "string" && raw.name ? raw.name : `Sprint ${id}`,
      state: isSprintState(state) ? state : "future",
      startsAt: parseDate(raw.startDate),
      endsAt: parseDate(raw.endDate),
    });
  }
  return refs;
}

/**
 * Which of an issue's sprints the card belongs to.
 *
 * A carried-over issue lists every sprint it has ever been in, so one of them
 * has to be chosen: the running sprint if there is one, else the planned one,
 * else the most recent closed sprint (a card whose only sprint has finished
 * still belongs to that history, not to the backlog).
 *
 * "Most recent" is decided by start date and then by sprint id, never by
 * position — Jira's array is unordered (see {@link parseSprintRefs}), and its
 * sprint ids are handed out in creation order, which is the only tiebreak
 * available for the sprints Jira sends with no dates at all.
 */
export function pickIssueSprint(
  refs: readonly JiraSprintRef[],
): JiraSprintRef | null {
  return (
    newestOf(refs, "active") ??
    newestOf(refs, "future") ??
    newestOf(refs, "closed")
  );
}

function newestOf(
  refs: readonly JiraSprintRef[],
  state: SprintState,
): JiraSprintRef | null {
  let best: JiraSprintRef | null = null;
  for (const ref of refs) {
    if (ref.state === state && (best === null || startsLater(ref, best))) {
      best = ref;
    }
  }
  return best;
}

function startsLater(a: JiraSprintRef, b: JiraSprintRef): boolean {
  if (a.startsAt && b.startsAt) return a.startsAt > b.startsAt;
  if (a.startsAt !== b.startsAt) return a.startsAt !== null;
  return Number(a.id) > Number(b.id);
}

/**
 * Drop a trailing `ORDER BY …` from a JQL string.
 *
 * A board's saved filter ends in one (`ORDER BY Rank ASC`), and the pull ANDs
 * clauses onto that filter and imposes its own ordering — a JQL with an
 * `ORDER BY` in the middle is a syntax error Jira answers 400 to.
 *
 * Quote-aware: `summary ~ "order by rank"` is a search term, not a clause, and
 * cutting there would silently change which issues sync.
 */
export function stripOrderBy(jql: string): string {
  let quote: '"' | "'" | null = null;
  let cut = -1;
  for (let i = 0; i < jql.length; i++) {
    const char = jql[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (
      (char === "o" || char === "O") &&
      /^order\s+by\b/i.test(jql.slice(i, i + 12))
    ) {
      cut = i;
    }
  }
  return (cut === -1 ? jql : jql.slice(0, cut)).trim();
}
