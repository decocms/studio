/**
 * Which Jira issue a run's tool call is about.
 *
 * A run is dispatched on a SET of issues — one, for a status rule or a
 * per-issue manual run; several, for a manual run started on a batch — and
 * the set is stamped in the run thread's metadata by Studio at dispatch. The
 * tools take an optional `issueKey` and this decides what it resolves to: an
 * issue in the set, or the only issue when the set has one and no key was
 * given. Anything else is refused, so a run started on OS-1 cannot be talked
 * into moving OS-2 by a key the model typed.
 */

import type { ThreadMetadata } from "@decocms/shared/entities";

/**
 * The issues a run may act on, from its thread's metadata. Empty when the
 * thread is not a Jira run at all.
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

/**
 * Resolve the issue a tool call names, or throw with the set it may name.
 * Keys compare case-insensitively (a person types `os-12`; Jira says `OS-12`)
 * and the run's own spelling is what comes back.
 */
export function pickRunIssue(
  allowed: readonly string[],
  requested: string | undefined,
): string {
  if (allowed.length === 0) {
    throw new Error("This run is not working on a Jira issue");
  }
  const wanted = requested?.trim();
  if (!wanted) {
    const only = allowed[0];
    if (allowed.length === 1 && only !== undefined) return only;
    throw new Error(
      `This run works on ${allowed.length} issues (${allowed.join(", ")}) — pass \`issueKey\` to say which one`,
    );
  }
  const match = allowed.find((k) => k.toLowerCase() === wanted.toLowerCase());
  if (!match) {
    throw new Error(
      `${wanted} is not an issue this run works on — it works on ${allowed.join(", ")}`,
    );
  }
  return match;
}
