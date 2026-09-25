/**
 * Which Jira issue a run's tool call is about.
 *
 * A run is dispatched on a SET of issues — one, for a status rule or a
 * per-issue manual run; several, for a manual run started on a batch — and
 * the set is stamped in the run thread's metadata by Studio at dispatch. The
 * tools take an optional `issueKey`: left out, it is the run's issue when the
 * run has one. Named, it may be any issue on the integration's board — a
 * spike opens the issues it spawns, a card's body points at another — and
 * the tools check the board, not the set (`run-tools.ts`).
 */

import type { ThreadMetadata } from "@decocms/shared/entities";

/**
 * The issues a run was dispatched on, from its thread's metadata. Empty when
 * the thread is not a Jira run at all.
 *
 * `jira_issue_keys` is the set. `jira_issue_key` alone is what a run stamped
 * before batches existed carries, and is still that run's whole set.
 */
export function runIssueKeys(
  metadata: ThreadMetadata | null | undefined,
): string[] {
  if (metadata?.source !== "jira") return [];
  const many = metadata.jira_issue_keys;
  if (Array.isArray(many)) {
    const keys = many.filter((k): k is string => typeof k === "string");
    if (keys.length > 0) return keys;
  }
  const one = metadata.jira_issue_key;
  return typeof one === "string" && one !== "" ? [one] : [];
}

/** The issues the run created itself (`JIRA_ISSUE_CREATE`). */
export function runCreatedIssueKeys(
  metadata: ThreadMetadata | null | undefined,
): string[] {
  if (metadata?.source !== "jira") return [];
  const keys = metadata.jira_created_issue_keys;
  return Array.isArray(keys)
    ? keys.filter((k): k is string => typeof k === "string")
    : [];
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

/**
 * The issue a tool call names. `inRun` says whether it is one the run was
 * dispatched on — those need no board check, Studio picked them from the
 * board. Keys compare case-insensitively (a person types `os-12`; Jira says
 * `OS-12`) and a run issue comes back in the run's own spelling.
 */
export function pickIssue(
  runKeys: readonly string[],
  requested: string | undefined,
): { key: string; inRun: boolean } {
  if (runKeys.length === 0) {
    throw new Error("This run is not working on a Jira issue");
  }
  const wanted = requested?.trim().toUpperCase();
  if (!wanted) {
    const only = runKeys[0];
    if (runKeys.length === 1 && only !== undefined) {
      return { key: only, inRun: true };
    }
    throw new Error(
      `This run works on ${runKeys.length} issues (${runKeys.join(", ")}) — pass \`issueKey\` to say which one`,
    );
  }
  const own = runKeys.find((k) => k.toUpperCase() === wanted);
  if (own) return { key: own, inRun: true };
  if (!ISSUE_KEY.test(wanted)) {
    throw new Error(`"${requested}" is not a Jira issue key, e.g. EX-12`);
  }
  return { key: wanted, inRun: false };
}
