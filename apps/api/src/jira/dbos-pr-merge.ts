/**
 * Durable merge of the pull requests a batch of Jira issues carries.
 *
 * A workflow rather than the tool's own body because of what a batch actually
 * is: eight issues, up to two repositories each, and three remote calls per
 * repository — read the issue's links, read the pull request, merge it. Held
 * inside one HTTP request that is ~40 sequential calls to two providers, and a
 * request that dies halfway leaves NOBODY knowing which of them landed. The
 * merges already happened; only the record of them is lost.
 *
 * So the tool starts this and returns, and the outcome is written where the
 * rest of the integration writes: a comment on the issue. That is also the
 * first time a merge leaves any trace on the card at all.
 *
 * Replay safety rests on reading each pull request's state before merging it.
 * A step that crashed between merging and commenting re-runs whole, and the
 * second pass sees `merged` and reports it instead of merging again — so the
 * one side-effecting call in here is naturally idempotent, which is what makes
 * a per-issue step (rather than a step per call) safe.
 *
 * Runtime deps come from a module-level registry wired by app boot via
 * `setJiraPrMergeRuntime` BEFORE `DBOS.launch()`.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import { changeRequestClientForOrigin } from "@/git-providers";
import type { Database } from "@/storage/types";
import { buildOrgContext } from "@/tools/task-board/org-context";
import { JiraClient } from "./client";
import { pullRequestsFromLinks } from "./pr-link";
import { startJiraRunForIssue } from "./trigger";

export interface JiraPrMergeInput {
  organizationId: string;
  issueKeys: string[];
  actorId: string;
}

export interface JiraPrMergeRuntime {
  db: Kysely<Database>;
}

let runtime: JiraPrMergeRuntime | null = null;

/** Wire deps for the workflow body. Safe to call before `DBOS.launch()`: it
 *  only writes a module-level pointer, no DBOS API calls. */
export function setJiraPrMergeRuntime(rt: JiraPrMergeRuntime): void {
  runtime = rt;
}

function requireRuntime(): JiraPrMergeRuntime {
  if (!runtime) {
    throw new Error(
      "[jira-pr-merge] runtime not initialized — setJiraPrMergeRuntime() must run before the workflow fires",
    );
  }
  return runtime;
}

type PrOutcome = {
  repo: string;
  url: string;
  status: "merged" | "resolving" | "blocked" | "not_open" | "error";
  detail?: string;
};

/** One line of the comment this leaves on the issue. */
function line(o: PrOutcome): string {
  const what =
    o.status === "merged"
      ? "merged"
      : o.status === "resolving"
        ? "conflicts — an agent is rebasing it"
        : o.status === "not_open"
          ? "is not open; a person closed it"
          : (o.detail ?? o.status);
  return `- ${o.repo} ${o.url} — ${what}`;
}

/**
 * One issue, folded to a result. NEVER throws: one issue whose repository lost
 * its credential must not skip the merges of the seven after it.
 */
async function mergeOneIssue(
  input: JiraPrMergeInput,
  issueKey: string,
): Promise<{ issueKey: string; outcomes: PrOutcome[]; error?: string }> {
  try {
    const ctx = await buildOrgContext(
      requireRuntime().db,
      input.organizationId,
    );
    if (!ctx) return { issueKey, outcomes: [], error: "organization is gone" };
    const integration = await ctx.storage.jiraIntegrations.getByOrg(
      input.organizationId,
    );
    if (!integration) {
      return { issueKey, outcomes: [], error: "Jira is no longer connected" };
    }
    const jira = new JiraClient(
      integration.siteUrl,
      integration.email,
      integration.apiToken,
    );
    const prs = pullRequestsFromLinks(await jira.listRemoteLinks(issueKey));
    if (prs.length === 0) {
      return { issueKey, outcomes: [], error: "no pull request on this issue" };
    }

    const outcomes: PrOutcome[] = [];
    const conflicted: Array<{ number: number; url: string }> = [];
    for (const pr of prs) {
      const repo = pr.repo.path;
      const client = await changeRequestClientForOrigin(
        ctx,
        input.organizationId,
        { repo: pr.repo },
      );
      if (!client) {
        outcomes.push({
          repo,
          url: pr.url,
          status: "error",
          detail: `no credential for ${repo}`,
        });
        continue;
      }
      // Read before merging: this is what makes a replayed step safe, and it
      // is also what keeps a superseded-but-closed pull request from being
      // revived — someone closed it, and that is their decision.
      const current = await client.read(pr.number);
      if (current && current.state !== "open") {
        outcomes.push({
          repo,
          url: pr.url,
          status: current.state === "merged" ? "merged" : "not_open",
        });
        continue;
      }
      const outcome = await client.merge(pr.number);
      if (outcome.merged) {
        outcomes.push({ repo, url: pr.url, status: "merged" });
      } else if (outcome.reason === "conflict") {
        conflicted.push({ number: pr.number, url: pr.url });
        outcomes.push({ repo, url: pr.url, status: "resolving" });
      } else {
        outcomes.push({
          repo,
          url: pr.url,
          status: "blocked",
          detail: outcome.detail,
        });
      }
    }

    // ONE run per issue however many of its pull requests conflict: a run
    // accumulates checkouts, so the same agent rebases both halves, and two
    // runs on one issue would supersede each other anyway.
    if (conflicted.length > 0) {
      await startJiraRunForIssue(ctx, integration, issueKey, {
        instruction:
          conflicted.length === 1
            ? null
            : `These pull requests on this issue no longer merge cleanly: ${conflicted
                .map((c) => c.url)
                .join(
                  ", ",
                )}. Rebase EACH onto its base branch and push it, updating the same pull request. They are halves of one change — leaving either behind ships it broken.`,
        actorId: input.actorId,
        pr: conflicted[0],
        resolveConflict: true,
      });
    }

    // The record, on the card. Nothing else writes it — a merge used to leave
    // no trace on the issue at all.
    await jira
      .addComment(issueKey, [`**Merge**`, ...outcomes.map(line)].join("\n"))
      .catch((err) => {
        console.warn("[jira-pr-merge] comment failed", issueKey, err);
      });
    return { issueKey, outcomes };
  } catch (err) {
    return {
      issueKey,
      outcomes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function jiraPrMergeWorkflowFn(input: JiraPrMergeInput): Promise<void> {
  // Sequential, and that is the point rather than a concession: merging one
  // moves the base under the next, so a batch of pull requests that touch a
  // file in common resolves in order instead of all conflicting at once.
  for (const issueKey of input.issueKeys) {
    await DBOS.runStep(() => mergeOneIssue(input, issueKey), {
      name: `merge:${issueKey}`,
    });
  }
}

// ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
// step, or change a step's recorded I/O) requires bumping DBOS_WORKFLOW_VERSION
// — see apps/api/src/dbos/workflow-version.ts.
const jiraPrMergeWorkflow = DBOS.registerWorkflow(jiraPrMergeWorkflowFn, {
  name: "jiraPrMergeWorkflow",
});

/**
 * Start one merge batch. Returns its workflow id, which is what the caller
 * shows so a person can find it in monitoring.
 *
 * The id carries the call's own nonce rather than being derived from the
 * issues, on purpose: merging the same issue again after an agent resolved its
 * conflict is the NORMAL second half of this feature, and an id that deduped
 * on the issue set would silently do nothing the second time.
 */
export async function enqueueJiraPrMerge(
  input: JiraPrMergeInput,
): Promise<string> {
  const workflowID = `jira-pr-merge:${input.organizationId}:${crypto.randomUUID()}`;
  await DBOS.startWorkflow(jiraPrMergeWorkflow, { workflowID })(input);
  return workflowID;
}
