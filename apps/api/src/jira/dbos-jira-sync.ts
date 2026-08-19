/**
 * DBOS scheduled workflow for the per-org Jira pull syncs (sync.ts).
 *
 * Same coordination story as dbos-org-repo-sync.ts: the scheduler picks one
 * pod per tick, the DB-derived work list is read inside a STEP so a replay
 * iterates the recorded list, and each integration is its own step so a pod
 * death mid-sweep resumes at the failed one. Runtime deps are wired by app
 * boot via `setJiraSyncRuntime` BEFORE `DBOS.launch()`.
 */

import { DBOS, SchedulerMode } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import { buildOrgContext } from "@/tools/task-board/org-context";
import type { Database, TaskBoardItem } from "@/storage/types";
import { JiraIntegrationStorage } from "@/storage/jira-integrations";
import { TaskBoardStorage } from "@/storage/task-board";
import { CredentialVault } from "@/encryption/credential-vault";
import type { StudioContext } from "@/core/studio-context";
import { JIRA_PUSH_QUEUE } from "@/dispatch-queue/queue-names";
import { JiraClient } from "./client";
import { JIRA_SYNC_ACTOR, syncJiraIntegrationSafe } from "./sync";

/** Every 10 minutes, offset from the public-sets (:04) and org-repo (:07)
 *  ticks so one pod never runs multiple sweeps at once. */
const JIRA_SYNC_CRONTAB = "2-59/10 * * * *";

export interface JiraSyncRuntime {
  db: Kysely<Database>;
  encryptionKey: string;
}

let runtime: JiraSyncRuntime | null = null;

/** Wire deps for the workflow body. Safe to call before `DBOS.launch()`:
 *  it only writes a module-level pointer, no DBOS API calls. */
export function setJiraSyncRuntime(rt: JiraSyncRuntime): void {
  runtime = rt;
}

function requireRuntime(): JiraSyncRuntime {
  if (!runtime) {
    throw new Error(
      "[jira] sync runtime not initialized — setJiraSyncRuntime() must run before the workflow fires",
    );
  }
  return runtime;
}

function storageFromRuntime(): JiraIntegrationStorage {
  const { db, encryptionKey } = requireRuntime();
  return new JiraIntegrationStorage(db, new CredentialVault(encryptionKey));
}

function taskBoardFromRuntime(): TaskBoardStorage {
  return new TaskBoardStorage(requireRuntime().db);
}

/** One integration, folded to a result — the step body must never throw.
 *  Takes an id and re-reads the row so the credential never crosses a step
 *  boundary (DBOS persists step arguments and outputs). */
async function runOneIntegration(
  integrationId: string,
): Promise<{ id: string; error?: string }> {
  try {
    const { db } = requireRuntime();
    const integration = await storageFromRuntime().getById(integrationId);
    if (!integration) {
      return { id: integrationId, error: "integration no longer exists" };
    }
    if (!integration.enabled) return { id: integrationId };
    const ctx = await buildOrgContext(db, integration.organizationId);
    if (!ctx) {
      return { id: integrationId, error: "organization no longer exists" };
    }
    const result = await syncJiraIntegrationSafe(ctx, integration);
    return "error" in result
      ? { id: integrationId, error: result.error }
      : { id: integrationId };
  } catch (err) {
    return {
      id: integrationId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function jiraSyncWorkflowFn(
  _scheduledTime: Date,
  _currentTime: Date,
): Promise<void> {
  const integrationIds = await DBOS.runStep(
    () => storageFromRuntime().listEnabledIds(),
    { name: "loadJiraIntegrations" },
  );
  for (const integrationId of integrationIds) {
    const result = await DBOS.runStep(() => runOneIntegration(integrationId), {
      name: `syncJira:${integrationId}`,
    });
    if (result.error) {
      console.warn(`[jira] sync ${result.id} failed: ${result.error}`);
    }
  }
}

export interface JiraCommentPushParams {
  commentId: string;
  taskBoardItemId: string;
  organizationId: string;
  authorLabel: string;
  body: string;
}

const MAX_PUSH_CHARS = 30_000;

/** Step 1: post the comment on the linked issue. Null = nothing to do —
 *  integration gone/disabled, card unlinked, or already pushed (the link
 *  check is what makes workflow re-entry idempotent). */
async function postCommentToJira(
  params: JiraCommentPushParams,
): Promise<string | null> {
  const storage = storageFromRuntime();
  const integration = await storage.getByOrg(params.organizationId);
  if (!integration?.enabled) return null;
  const link = await storage.getLinkByItemId(
    params.taskBoardItemId,
    params.organizationId,
  );
  if (!link) return null;
  if (await storage.hasCommentLink(params.commentId)) return null;
  const client = new JiraClient(
    integration.siteUrl,
    integration.email,
    integration.apiToken,
  );
  const text = `${params.authorLabel} · via Studio:\n${params.body}`.slice(
    0,
    MAX_PUSH_CHARS,
  );
  const created = await client.addComment(link.jiraIssueId, text);
  return created.id;
}

/** Step 2: record the link — the pull's echo cut for this comment. */
async function recordCommentLink(
  params: JiraCommentPushParams,
  jiraCommentId: string,
): Promise<void> {
  try {
    await storageFromRuntime().createCommentLink({
      commentId: params.commentId,
      organizationId: params.organizationId,
      jiraCommentId,
    });
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
  }
}

async function jiraCommentPushWorkflowFn(
  params: JiraCommentPushParams,
): Promise<void> {
  // NOT retriable: Jira has no idempotency key for comments, so a retry after
  // a lost response (timeout, 502 past the commit) posts the comment again on
  // the customer's issue. One missed mirror beats four copies; the comment
  // itself is already safe in Studio and the failure is logged.
  const jiraCommentId = await DBOS.runStep(() => postCommentToJira(params), {
    name: "postCommentToJira",
    retriesAllowed: false,
  });
  if (!jiraCommentId) return;
  await DBOS.runStep(() => recordCommentLink(params, jiraCommentId), {
    name: "recordCommentLink",
    retriesAllowed: true,
    maxAttempts: 4,
  });
}

/** No status snapshot on purpose — the workflow reads the card's current lane.
 *  See `resolveStatusTransition`. */
interface JiraStatusPushParams {
  organizationId: string;
  itemId: string;
}

interface StatusTransitionPlan {
  jiraIssueId: string;
  transitionId: string;
  targetName: string;
}

/** Step 1: plan the transition. Null = nothing to do — integration off, card
 *  unlinked, no Jira status mapped to this lane, already there, or the
 *  issue's workflow offers no transition to it (logged, not an error: the
 *  tenant's Jira workflow is theirs to shape). */
async function resolveStatusTransition(
  params: JiraStatusPushParams,
): Promise<StatusTransitionPlan | null> {
  const storage = storageFromRuntime();
  const integration = await storage.getByOrg(params.organizationId);
  if (!integration?.enabled) return null;
  const link = await storage.getLinkByItemId(
    params.itemId,
    params.organizationId,
  );
  if (!link) return null;
  // The card's CURRENT lane, never the one captured at enqueue time: the
  // enqueue runs after an await, so two quick moves can reach the queue out of
  // order, and the stale leg would transition the issue backwards and stick —
  // the pull won't undo it, because Jira then agrees with `jira_status`.
  const item = await taskBoardFromRuntime().getById(
    params.itemId,
    params.organizationId,
  );
  if (!item) return null;
  const targets = Object.entries(integration.statusMapping)
    .filter(([, lane]) => lane === item.status)
    .map(([name]) => name);
  if (targets.length === 0) return null;
  if (link.jiraStatus && targets.includes(link.jiraStatus)) return null;
  const client = new JiraClient(
    integration.siteUrl,
    integration.email,
    integration.apiToken,
  );
  const transitions = await client.listTransitions(link.jiraIssueId);
  for (const target of targets) {
    const transition = transitions.find((t) => t.to.name === target);
    if (transition) {
      return {
        jiraIssueId: link.jiraIssueId,
        transitionId: transition.id,
        targetName: target,
      };
    }
  }
  console.warn(
    `[jira] no transition to ${targets.join("/")} available for ${link.jiraIssueKey}`,
  );
  return null;
}

/** Step 2: execute it. Re-checks the link first so a retry after a
 *  crash-past-the-POST is a no-op instead of a double transition. */
async function executeStatusTransition(
  params: JiraStatusPushParams,
  plan: StatusTransitionPlan,
): Promise<void> {
  const storage = storageFromRuntime();
  const integration = await storage.getByOrg(params.organizationId);
  if (!integration?.enabled) return;
  const link = await storage.getLinkByItemId(
    params.itemId,
    params.organizationId,
  );
  if (!link || link.jiraStatus === plan.targetName) return;
  const client = new JiraClient(
    integration.siteUrl,
    integration.email,
    integration.apiToken,
  );
  // A crash between the POST below and the `touchLink` that records it leaves
  // the issue transitioned but the link stale, and the transition is no longer
  // offered — so ask Jira where the issue actually is before pushing again.
  const current = await client.getStatusName(plan.jiraIssueId);
  if (current === plan.targetName) {
    await storage.touchLink(params.itemId, { jiraStatus: plan.targetName });
    return;
  }
  await client.transitionIssue(plan.jiraIssueId, plan.transitionId);
  await storage.touchLink(params.itemId, { jiraStatus: plan.targetName });
}

async function jiraStatusPushWorkflowFn(
  params: JiraStatusPushParams,
): Promise<void> {
  const plan = await DBOS.runStep(() => resolveStatusTransition(params), {
    name: "resolveStatusTransition",
    retriesAllowed: true,
    maxAttempts: 3,
  });
  if (!plan) return;
  await DBOS.runStep(() => executeStatusTransition(params, plan), {
    name: "executeStatusTransition",
    retriesAllowed: true,
    maxAttempts: 3,
  });
}

let registeredWorkflow: typeof jiraSyncWorkflowFn | null = null;
let registeredCommentPushWorkflow: typeof jiraCommentPushWorkflowFn | null =
  null;
let registeredStatusPushWorkflow: typeof jiraStatusPushWorkflowFn | null = null;

/**
 * Mirror a board card's status onto its linked Jira issue — called from
 * `emitTaskBoardUpdated` (the one funnel every board write passes through),
 * so the agent's own moves land on the issue. Fire-and-forget and cheap to
 * decline: pull-sync writes are cut by actor, orgs without Jira by a PK miss.
 * The workflow re-derives everything; the enqueue only decides "worth a try".
 */
export function maybeEnqueueJiraStatusPush(
  organizationId: string,
  item: TaskBoardItem,
): void {
  if (item.updatedBy === JIRA_SYNC_ACTOR) return;
  if (!registeredStatusPushWorkflow || !runtime) return;
  const workflow = registeredStatusPushWorkflow;
  void (async () => {
    const link = await storageFromRuntime().getLinkByItemId(
      item.id,
      organizationId,
    );
    if (!link) return;
    await DBOS.startWorkflow(workflow, {
      queueName: JIRA_PUSH_QUEUE,
      workflowID: `jira-status:${item.id}:${item.status}:${Date.parse(item.updatedAt)}`,
      enqueueOptions: { queuePartitionKey: organizationId },
    })({ organizationId, itemId: item.id });
  })().catch((err) => {
    console.warn(
      `[jira] status push enqueue failed for ${item.id}:`,
      err instanceof Error ? err.message : err,
    );
  });
}

/**
 * Durably push a board comment to its card's linked Jira issue.
 *
 * Cheap gate first (PK lookup: unlinked cards — i.e. most orgs — enqueue
 * nothing), then a DBOS workflow on the org-partitioned queue: survives pod
 * death, retries transport failures, and concurrency 1 per org keeps comments
 * arriving in posting order. `workflowID` dedupes re-enqueues of the same
 * comment. Never throws — comment creation must not fail on Jira's account.
 */
export async function enqueueJiraCommentPush(
  ctx: StudioContext,
  params: JiraCommentPushParams,
): Promise<void> {
  try {
    if (!registeredCommentPushWorkflow) return;
    const link = await ctx.storage.jiraIntegrations.getLinkByItemId(
      params.taskBoardItemId,
      params.organizationId,
    );
    if (!link) return;
    await DBOS.startWorkflow(registeredCommentPushWorkflow, {
      queueName: JIRA_PUSH_QUEUE,
      workflowID: `jira-cmt-push:${params.commentId}`,
      enqueueOptions: { queuePartitionKey: params.organizationId },
    })(params);
  } catch (err) {
    console.warn(
      `[jira] comment push enqueue failed for ${params.commentId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Must run before `DBOS.launch()`; guarded so HMR repeats don't re-register.
 *  ⚠️ Durable workflows — changing a STEP SEQUENCE requires bumping
 *  DBOS_WORKFLOW_VERSION (apps/api/src/dbos/workflow-version.ts). */
export function registerJiraSyncWorkflow(): void {
  if (registeredWorkflow) return;
  registeredWorkflow = DBOS.registerWorkflow(jiraSyncWorkflowFn, {
    name: "jiraSyncWorkflow",
  });
  DBOS.registerScheduled(registeredWorkflow, {
    name: "jiraSyncWorkflow",
    crontab: JIRA_SYNC_CRONTAB,
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  });
  registeredCommentPushWorkflow = DBOS.registerWorkflow(
    jiraCommentPushWorkflowFn,
    { name: "jiraCommentPushWorkflow" },
  );
  registeredStatusPushWorkflow = DBOS.registerWorkflow(
    jiraStatusPushWorkflowFn,
    { name: "jiraStatusPushWorkflow" },
  );
}
