/**
 * Built-in automations: the ones Studio seeds in every org, told apart from
 * the ones people create by `automations.system_key`.
 *
 * A built-in fires like any automation: its starter is an ordinary trigger
 * row, its fires go through `fireAutomationWorkflow`, and nothing calls a
 * built-in directly. What still treats a built-in differently, all of it:
 *
 * - Every built-in:
 *   - runs with the org's context, not its creator's, and is never
 *     deactivated for a creator who left (`fireContext`, `dbos-workflow.ts`);
 *   - claims the card for whoever moved it, not for the member standing in
 *     as its creator (`card-run.ts`);
 *   - can only be turned on or off; the automation tools refuse edits,
 *     deletes, starter changes and manual runs (`tools/automations/*`).
 * - The implementer:
 *   - its starter skips a card already delegated to the Super Agent, whose
 *     run started when it was delegated (`card-run.ts`);
 *   - it is also fired by hand: Run, Re-run, a delegation, a card created or
 *     imported for the agent, a retry, a conflict fix (`fire-implementer.ts`).
 *     A manual fire runs when it is off and skips the column gates
 *     (`card-run.ts`, `dbos-workflow.ts`).
 * - The reviewer:
 *   - its on/off is still the org's `reviewer_enabled` flag, which the review
 *     gate's other readers (auto-merge, conflicts, admin flags) read; the tools
 *     read and write it through `withBuiltinActive` / `setFlagBackedActive`
 *     (this file), and its row stays active;
 *   - its starter, "pull request ready for review", is fired by the review
 *     sweep (`tools/task-board/enqueue-reviewer.ts`), which keeps the cycle,
 *     attempt, preview and verdict-nudge decisions; people can't use it yet
 *     (`tools/automations/trigger-add.ts`);
 *   - its card step starts the review run, not the board's run
 *     (`card-run.ts` → `tools/task-board/reviewer-run.ts`).
 * - Move cards from linked chats runs no agent: its starter is the board's run reactions, gated in `TaskBoardStorage.runMovesLinkedCards`.
 * - Ship merged pull requests and Track chat pull requests run no agent: their starter is code gated on `builtinActive`.
 * - Super Agent mentions: its starter is a comment (`tools/task-board/mention-runs.ts`), and its card step starts the run without claiming the card and ties it to the comment (`card-run.ts`).
 *
 * A new built-in adds its special case to this list. Its board run takes its
 * instructions from the board's column prompts, which is where an org
 * customizes it.
 *
 * Seeding is idempotent: an org gets each built-in once, and one it switched
 * off stays off.
 */

import { getDecopilotId } from "@decocms/shared/sdk";
import { LANES, reviewerEnabled } from "@decocms/shared/task-board";
import { sql, type Kysely } from "kysely";
import type { StudioContext } from "@/core/studio-context";
import type { Database } from "@/storage/types";

/** The board's implementer: picks up an unassigned card that lands in In
 *  Progress. */
export const IMPLEMENTER_SYSTEM_KEY = "implementer";

/** The board's reviewer: reviews a card's pull request once it is ready. */
export const REVIEWER_SYSTEM_KEY = "reviewer";

/** Lets a run on a thread linked to a card move it like the Implementer's
 *  does (back from In Review, on to review or QA, retry or Backlog on a
 *  failure). Off, only the Implementer's run moves a card. */
export const LINKED_CHATS_SYSTEM_KEY = "linked_chats";

/** Moves a card under review to Post-deploy Validation once its pull
 *  request merged, wherever it was merged. */
export const PR_MERGED_SYSTEM_KEY = "pr_merged";

/** Puts a pull request a chat with no card opened on the board. */
export const CHAT_PR_SYSTEM_KEY = "chat_pr";

/** Runs the Super Agent on a card when a comment mentions it, and carries
 *  replies in a run's comment thread to that run. */
export const MENTIONS_SYSTEM_KEY = "agent_mentions";

const BUILTINS = [
  {
    key: IMPLEMENTER_SYSTEM_KEY,
    name: "Implementer",
    triggerType: "board_column_transition",
    columnKey: LANES.progress,
    fromKind: "any",
  },
  {
    key: REVIEWER_SYSTEM_KEY,
    name: "Reviewer",
    triggerType: "board_pr_ready",
    columnKey: LANES.review,
    fromKind: null,
  },
  {
    key: LINKED_CHATS_SYSTEM_KEY,
    name: "Move cards from linked chats",
    triggerType: "linked_chat_run",
    columnKey: null,
    fromKind: null,
  },
  {
    key: PR_MERGED_SYSTEM_KEY,
    name: "Ship merged pull requests",
    triggerType: "board_pr_merged",
    columnKey: LANES.review,
    fromKind: null,
  },
  {
    key: CHAT_PR_SYSTEM_KEY,
    name: "Track chat pull requests",
    triggerType: "chat_pr_opened",
    columnKey: null,
    fromKind: null,
  },
  {
    key: MENTIONS_SYSTEM_KEY,
    name: "Super Agent mentions",
    triggerType: "card_mention",
    columnKey: null,
    fromKind: null,
  },
] as const;

/** The agent every built-in runs as: the org's Super Agent. */
const SUPER_AGENT_PREFIX = getDecopilotId("");

/**
 * Seed the built-ins an org lacks: `org`'s, with its creator, or every org's
 * when omitted. A row needs a creator; across orgs the earliest member
 * stands in, and an org with no member yet is seeded on the next boot.
 */
export async function ensureBuiltinAutomations(
  db: Kysely<Database>,
  org?: { id: string; createdBy: string },
): Promise<void> {
  const owners = org
    ? sql`select ${org.id}::text as org_id, ${org.createdBy}::text as user_id`
    : sql`
        select distinct on (m."organizationId")
               m."organizationId" as org_id, m."userId" as user_id
          from member m
         order by m."organizationId", m."createdAt" asc`;
  for (const builtin of BUILTINS) {
    await sql`
      with owners as (${owners}), seeded as (
        insert into automations
          (id, organization_id, name, active, created_by, messages, models,
           virtual_mcp_id, system_key)
        select 'auto_' || ${builtin.key} || '_' || org_id, org_id,
               ${builtin.name}, true, user_id, '[]', '{"tier":"smart"}',
               ${SUPER_AGENT_PREFIX} || org_id, ${builtin.key}
          from owners
        on conflict (organization_id, system_key)
          where system_key is not null do nothing
        returning id
      )
      insert into automation_triggers (id, automation_id, type, column_key, from_kind)
      select 'trg_' || id, id, ${builtin.triggerType}, ${builtin.columnKey},
             ${builtin.fromKind}
        from seeded
    `.execute(db);
  }
}

/** The built-in a starter type belongs to, by name; people's automations
 *  can't use it. */
export function builtinOwningStarter(type: string): string | undefined {
  return BUILTINS.find(
    (b) => b.triggerType === type && b.key !== IMPLEMENTER_SYSTEM_KEY,
  )?.name;
}

/** Whether a built-in that runs in code is on. An org not seeded with it
 *  yet keeps the behavior it had before the built-in existed. */
export async function builtinActive(
  ctx: StudioContext,
  organizationId: string,
  systemKey:
    | typeof PR_MERGED_SYSTEM_KEY
    | typeof CHAT_PR_SYSTEM_KEY
    | typeof MENTIONS_SYSTEM_KEY,
): Promise<boolean> {
  return (
    (await ctx.storage.automations.builtinActive(organizationId, systemKey)) ??
    true
  );
}

/** True for a built-in whose on/off is still the org's `reviewer_enabled`
 *  flag, not its own row: every reader of the review gate (auto-merge,
 *  conflicts, the admin flags) reads the flag. Its row stays active. */
function flagBacked(systemKey: string | null): boolean {
  return systemKey === REVIEWER_SYSTEM_KEY;
}

/** `automations` with a flag-backed built-in's `active` read from the flag. */
export async function withBuiltinActive<
  T extends { system_key: string | null; active: boolean },
>(ctx: StudioContext, organizationId: string, automations: T[]): Promise<T[]> {
  if (!automations.some((a) => flagBacked(a.system_key))) return automations;
  const settings = await ctx.storage.organizationSettings.get(organizationId);
  const on = reviewerEnabled(settings?.flags);
  return automations.map((a) =>
    flagBacked(a.system_key) ? { ...a, active: on } : a,
  );
}

/** Turn a flag-backed built-in on or off; false for any other automation. */
export async function setFlagBackedActive(
  ctx: StudioContext,
  automation: { system_key: string | null; organization_id: string },
  active: boolean,
): Promise<boolean> {
  if (!flagBacked(automation.system_key)) return false;
  await ctx.storage.organizationSettings.upsert(automation.organization_id, {
    flags: { reviewer_enabled: active },
  });
  return true;
}
