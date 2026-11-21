/**
 * "An issue entered a Jira status that a `jira_transition` trigger watches —
 * fire its automation on the issue."
 *
 * The one act behind both the webhook and the safety-net poll. This half only
 * decides that a move counts and which trigger it answers; the automation
 * fire workflow runs it on the issue (`automations/jira-run.ts`).
 *
 * A trigger reacts to where an issue RESTS, not to each drop (`settle.ts`): a
 * card dragged through a column, or into the wrong one and straight back,
 * fires nothing there and does not supersede the run it was waiting on.
 *
 * Idempotency is per TRANSITION, not per issue: `jira_trigger_claims` holds
 * one row per changelog entry, so a redelivered webhook or the poll finding
 * the same entry fires nothing, while the issue entering the column again
 * later is a new fire.
 */

import {
  durableAwaitLiveRunThenFire,
  itemHasLiveRun,
} from "@/automations/await-live-run";
import { enqueueAutomationFire } from "@/automations/dbos-sync";
import type { FireAutomationContext } from "@/automations/dbos-workflow";
import type { StudioContext } from "@/core/studio-context";
import type { OrgJiraIntegration } from "@/storage/types";
import { JiraClient, type JiraUser } from "./client";
import {
  directionOf,
  needsDirection,
  pickRule,
  ruleFromColumns,
} from "./rule-from";
import { type Settled, settle, settleWindowMs } from "./settle";

/** A status change the webhook reported. Only its identity: what the change
 *  amounts to is read back from the issue's history once it has settled. */
export interface IssueTransition {
  issueId: string;
  issueKey: string;
  /** The status NAME the issue landed in, for logs; a rule reacts to where
   *  the issue rests, which a later drop may change. */
  toStatus: string;
  /** Jira's id for this changelog entry: the transition's identity. */
  changelogId: string;
}

/**
 * The status change a Jira webhook payload reports, or null when the event is
 * not one (a comment, a field edit, an unrelated event type).
 */
export function parseWebhookTransition(
  payload: unknown,
): IssueTransition | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as {
    webhookEvent?: unknown;
    issue?: { id?: unknown; key?: unknown };
    changelog?: {
      id?: unknown;
      items?: Array<{ field?: unknown; toString?: unknown }>;
    };
  };
  if (p.webhookEvent !== "jira:issue_updated") return null;
  const issueId = p.issue?.id;
  const issueKey = p.issue?.key;
  const changelogId = p.changelog?.id;
  if (
    (typeof issueId !== "string" && typeof issueId !== "number") ||
    typeof issueKey !== "string" ||
    (typeof changelogId !== "string" && typeof changelogId !== "number")
  ) {
    return null;
  }
  const status = p.changelog?.items?.find((item) => item.field === "status");
  if (!status || typeof status.toString !== "string") return null;
  return {
    issueId: String(issueId),
    issueKey,
    toStatus: status.toString,
    changelogId: String(changelogId),
  };
}

/** The integration's own account made the move: a run moved the issue on.
 *  An account that cannot be read counts as a person. */
export async function movedByIntegration(
  client: Pick<JiraClient, "myself">,
  by: JiraUser | null,
): Promise<boolean> {
  if (!by) return false;
  try {
    return by.accountId === (await client.myself()).accountId;
  } catch {
    return false;
  }
}

export type TriggerOutcome =
  | "fired"
  | "no_rule"
  | "duplicate"
  | "disabled"
  /** Not settled yet, or a later move decides instead — see `settle.ts`. */
  | Exclude<Settled["kind"], "moved">;

/**
 * Fire the automation for where an issue came to rest, if a trigger on that
 * status answers where it came from and nothing fired for this move already.
 *
 * `changelogId` is the move the webhook reported, and the caller has waited
 * the settle window since; the poll omits it and passes `now`, asking about the
 * issue's latest move. Either way the claim is on the move that settled, so
 * the two never both fire it.
 */
export async function triggerRunForSettledMove(
  ctx: StudioContext,
  integration: OrgJiraIntegration,
  target: { issueId: string; changelogId?: string; now?: number },
): Promise<TriggerOutcome> {
  if (!integration.enabled) return "disabled";
  const orgId = integration.organizationId;
  const client = new JiraClient(
    integration.siteUrl,
    integration.email,
    integration.apiToken,
  );
  const settled = settle(await client.listStatusChanges(target.issueId), {
    changeId: target.changelogId,
    now: target.now,
    windowMs: settleWindowMs(),
  });
  if (!settled) return "no_rule";
  if (settled.kind !== "moved") return settled.kind;
  const { change, from } = settled;
  const triggers = (
    await ctx.storage.automations.listJiraTransitionTriggers(orgId, {
      jiraStatus: change.to,
      activeOnly: true,
    })
  ).map((trigger) => ({ ...trigger, from: ruleFromColumns(trigger) }));
  const direction =
    needsDirection(triggers) && integration.boardId
      ? directionOf(
          await client.getBoardColumnStatusIds(integration.boardId),
          from.id,
          change.toId,
        )
      : null;
  const trigger = pickRule(triggers, from.name, direction);
  if (!trigger) return "no_rule";

  // Shared with the release before triggers, which claimed here too.
  const claimed = await ctx.storage.jiraIntegrations.claimTrigger(
    orgId,
    target.issueId,
    change.id,
  );
  if (!claimed) return "duplicate";
  const fire: FireAutomationContext = {
    automationId: trigger.automation_id,
    organizationId: orgId,
    triggerId: trigger.id,
    target: {
      kind: "jira",
      issues: [target.issueId],
      move: {
        toStatus: change.to,
        fromStatus: from.name,
        movedBy: change.by,
        movedAt: new Date(change.at).toISOString(),
      },
      eventKey: change.id,
    },
  };
  const idempotencyKey = `jira:${trigger.id}:${change.id}`;
  // A run moved the issue as its last step: let it finish rather than have
  // the fire stop it. A person's move takes over at once.
  const anchor = await ctx.storage.jiraIntegrations.getLinkByIssueId(
    orgId,
    target.issueId,
  );
  if (
    anchor &&
    (await movedByIntegration(client, change.by)) &&
    (await itemHasLiveRun(ctx.storage.taskBoard, anchor.itemId, orgId))
  ) {
    await durableAwaitLiveRunThenFire(fire, {
      itemId: anchor.itemId,
      idempotencyKey,
    });
  } else {
    await enqueueAutomationFire(fire, { idempotencyKey });
  }
  return "fired";
}
