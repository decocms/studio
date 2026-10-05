/**
 * The two durable halves of the Jira trigger.
 *
 * The settle wait: a status change the webhook reports is acted on only after
 * a minute, once the card has stayed put (`settle.ts`). A durable sleep, so a
 * pod restarting mid-wait resumes it instead of dropping the move; keyed by the
 * changelog entry, so a redelivered webhook joins the wait already running.
 *
 * The safety net: every ten minutes, ask each enabled integration which issues
 * changed status recently and settle each one's latest move. A webhook the
 * tenant never configured, or one Jira dropped, costs latency instead of a
 * missed run; the per-transition claim makes the overlap free. Same shape as
 * `dbos-archive-sweep.ts`: one pod per tick, the work list read inside a step,
 * one step per integration that never throws.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import { CredentialVault } from "@/encryption/credential-vault";
import { JiraIntegrationStorage } from "@/storage/jira-integrations";
import type { Database } from "@/storage/types";
import { buildOrgContext } from "@/tools/task-board/org-context";
import { JiraClient } from "./client";
import { settleWindowMs } from "./settle";
import {
  type IssueTransition,
  type TriggerOutcome,
  triggerRunForSettledMove,
} from "./trigger";

/** Every ten minutes at :07 — off the other sweeps' ticks. */
const SWEEP_CRONTAB = "7-59/10 * * * *";

/** Three ticks and a margin, so one skipped tick (a deploy, a pod restart)
 *  is covered by the next instead of losing its transitions. Without a
 *  webhook this sweep is the only trigger. The per-transition claim dedupes
 *  the overlap. */
const LOOKBACK_MINUTES = 35;

/** Pages of 100 issues per integration per tick. Past this the tenant has a
 *  problem this sweep should not paper over. */
const MAX_PAGES = 5;

/** Past the settle window, so a card that just stopped moving reads as
 *  settled when Jira's clock runs a little behind ours. */
const CLOCK_SKEW_MS = 5_000;

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
    // The board's columns do not change mid-sweep; fetch them at most once.
    let boardColumns: Promise<string[][]> | undefined;
    const getBoardColumns = (c: JiraClient, boardId: string) =>
      (boardColumns ??= c.getBoardColumnStatusIds(boardId));
    let started = 0;
    let nextPageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await client.searchIssues({ jql, nextPageToken });
      for (const issue of result.issues) {
        // Only the latest move can still start anything; one younger than
        // the window is the webhook's wait's to decide, or the next tick's.
        const outcome = await triggerRunForSettledMove(
          ctx,
          integration,
          { issueId: issue.id, now: Date.now() },
          getBoardColumns,
        );
        if (outcome === "started") started++;
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
  _scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  const ids = await DBOS.runStep(() => storage().listEnabledIds(), {
    name: "loadJiraIntegrations",
  });
  if (ids.length === 0) return;
  const results = await Promise.all(
    ids.map((id) =>
      DBOS.runStep(() => sweepOneIntegration(id), {
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

/** Settle one move the webhook reported — the step body must never throw. */
async function settleReportedMove(
  integrationId: string,
  transition: IssueTransition,
): Promise<TriggerOutcome | "error"> {
  try {
    const integration = await storage().getById(integrationId);
    if (!integration?.enabled) return "disabled";
    const ctx = await buildOrgContext(
      requireRuntime().db,
      integration.organizationId,
    );
    if (!ctx) return "disabled";
    const outcome = await triggerRunForSettledMove(ctx, integration, {
      issueId: transition.issueId,
      changelogId: transition.changelogId,
    });
    if (outcome === "started") {
      console.log(
        `[jira-trigger] started a run for ${transition.issueKey} after it settled`,
      );
    } else if (outcome === "returned") {
      console.log(
        `[jira-trigger] ${transition.issueKey} went back where it was before settling in "${transition.toStatus}"; no run`,
      );
    }
    return outcome;
  } catch (err) {
    console.error(
      `[jira-trigger] settling ${transition.issueKey} failed`,
      err instanceof Error ? err.message : err,
    );
    return "error";
  }
}

async function jiraSettleWorkflowFn(
  integrationId: string,
  transition: IssueTransition,
): Promise<void> {
  await DBOS.sleep(settleWindowMs() + CLOCK_SKEW_MS);
  await DBOS.runStep(() => settleReportedMove(integrationId, transition), {
    name: "settleJiraMove",
  });
}

let registeredSettle: typeof jiraSettleWorkflowFn | null = null;

/**
 * Wait for the move the webhook reported to settle, then trigger on it. Called
 * from a request handler, never from a step, where DBOS rejects starting a
 * workflow; the sweep settles its moves in place instead.
 */
export async function enqueueJiraSettle(
  integrationId: string,
  transition: IssueTransition,
): Promise<void> {
  if (!registeredSettle) {
    throw new Error("[jira-trigger] settle workflow is not registered");
  }
  await DBOS.startWorkflow(registeredSettle, {
    workflowID: `jira-settle:${integrationId}:${transition.changelogId}`,
  })(integrationId, transition);
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
  registeredSettle = DBOS.registerWorkflow(jiraSettleWorkflowFn, {
    name: "jiraSettleWorkflow",
  });
  registeredWorkflow = DBOS.registerWorkflow(jiraTriggerSweepWorkflowFn, {
    name: "jiraTriggerSweepWorkflow",
  });
  DBOS.registerScheduled(registeredWorkflow, {
    name: "jiraTriggerSweepWorkflow",
    crontab: SWEEP_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
}
