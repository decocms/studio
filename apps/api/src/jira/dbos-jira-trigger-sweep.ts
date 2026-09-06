/**
 * Safety net under the Jira webhook: every ten minutes, ask each enabled
 * integration which issues changed status recently and run the same trigger
 * the webhook runs. A webhook the tenant never configured, or one Jira dropped,
 * costs latency instead of a missed run; the per-transition claim makes the
 * overlap free.
 *
 * Same shape as `dbos-archive-sweep.ts`: one pod per tick, the work list read
 * inside a step, one step per integration that never throws.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import { CredentialVault } from "@/encryption/credential-vault";
import { JiraIntegrationStorage } from "@/storage/jira-integrations";
import type { Database } from "@/storage/types";
import { buildOrgContext } from "@/tools/task-board/org-context";
import { JiraClient } from "./client";
import { transitionsFromChangelog, triggerRunForTransition } from "./trigger";

/** Every ten minutes at :07 — off the other sweeps' ticks. */
const SWEEP_CRONTAB = "7-59/10 * * * *";

/** Wider than the tick so two consecutive sweeps overlap; the claim dedupes. */
const LOOKBACK_MINUTES = 15;

/** Pages of 100 issues per integration per tick. Past this the tenant has a
 *  problem this sweep should not paper over. */
const MAX_PAGES = 5;

export interface JiraTriggerSweepRuntime {
  db: Kysely<Database>;
  encryptionKey: string;
}

let runtime: JiraTriggerSweepRuntime | null = null;

export function setJiraTriggerSweepRuntime(rt: JiraTriggerSweepRuntime): void {
  runtime = rt;
}

function requireRuntime(): JiraTriggerSweepRuntime {
  if (!runtime) {
    throw new Error(
      "[jira-trigger] runtime not initialized — setJiraTriggerSweepRuntime() must run before the workflow fires",
    );
  }
  return runtime;
}

function storage(): JiraIntegrationStorage {
  const rt = requireRuntime();
  return new JiraIntegrationStorage(
    rt.db,
    new CredentialVault(rt.encryptionKey),
  );
}

/** One integration, folded to a result — the step body must never throw. */
async function sweepOneIntegration(
  integrationId: string,
  since: Date,
): Promise<{ integrationId: string; started: number; error?: string }> {
  try {
    const integration = await storage().getById(integrationId);
    if (!integration?.enabled || !integration.boardId) {
      return { integrationId, started: 0 };
    }
    const ctx = await buildOrgContext(
      requireRuntime().db,
      integration.organizationId,
    );
    if (!ctx) return { integrationId, started: 0 };
    const rules = await ctx.storage.jiraIntegrations.listAutomations(
      integration.organizationId,
    );
    if (rules.length === 0) return { integrationId, started: 0 };

    const client = new JiraClient(
      integration.siteUrl,
      integration.email,
      integration.apiToken,
    );
    const scope = await client.getBoardScopeJql(integration.boardId);
    const jql = `(${scope}) AND status CHANGED AFTER "-${LOOKBACK_MINUTES}m"`;
    let started = 0;
    let nextPageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await client.searchIssues({
        jql,
        nextPageToken,
        expandChangelog: true,
      });
      for (const issue of result.issues) {
        const transitions = transitionsFromChangelog(
          issue,
          issue.changelog?.histories ?? [],
          since,
        );
        for (const transition of transitions) {
          const outcome = await triggerRunForTransition(
            ctx,
            integration,
            transition,
          );
          if (outcome === "started") started++;
        }
      }
      nextPageToken = result.nextPageToken ?? undefined;
      if (!nextPageToken) break;
    }
    return { integrationId, started };
  } catch (err) {
    return {
      integrationId,
      started: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function jiraTriggerSweepWorkflowFn(
  scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  // Window off the SCHEDULED time, so a replayed tick asks for the same one.
  const since = new Date(scheduledTime.getTime() - LOOKBACK_MINUTES * 60_000);
  const ids = await DBOS.runStep(() => storage().listEnabledIds(), {
    name: "loadJiraIntegrations",
  });
  if (ids.length === 0) return;
  const results = await Promise.all(
    ids.map((id) =>
      DBOS.runStep(() => sweepOneIntegration(id, since), {
        name: `sweepJira:${id}`,
      }),
    ),
  );
  for (const result of results) {
    if (result.error) {
      console.warn(
        `[jira-trigger] integration ${result.integrationId} failed: ${result.error}`,
      );
    } else if (result.started > 0) {
      console.log(
        `[jira-trigger] integration ${result.integrationId} started ${result.started} run(s) the webhook missed`,
      );
    }
  }
}

let registeredWorkflow: typeof jiraTriggerSweepWorkflowFn | null = null;

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
 * step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerJiraTriggerSweepWorkflow(): void {
  if (registeredWorkflow) return;
  registeredWorkflow = DBOS.registerWorkflow(jiraTriggerSweepWorkflowFn, {
    name: "jiraTriggerSweepWorkflow",
  });
  DBOS.registerScheduled(registeredWorkflow, {
    name: "jiraTriggerSweepWorkflow",
    crontab: SWEEP_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
