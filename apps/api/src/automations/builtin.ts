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
 * - The implementer: skips a card already delegated to the Super Agent,
 *   whose run started when it was delegated (`card-run.ts`).
 *
 * A new built-in adds its special case to this list. Its board run takes its
 * instructions from the board's column prompts, which is where an org
 * customizes it.
 *
 * Seeding is idempotent: an org gets each built-in once, and one it switched
 * off stays off.
 */

import { getDecopilotId } from "@decocms/shared/sdk";
import { LANES } from "@decocms/shared/task-board";
import { sql, type Kysely } from "kysely";
import type { Database } from "@/storage/types";

/** The board's implementer: picks up an unassigned card that lands in In
 *  Progress. */
export const IMPLEMENTER_SYSTEM_KEY = "implementer";

const BUILTINS = [
  {
    key: IMPLEMENTER_SYSTEM_KEY,
    name: "Implementer",
    columnKey: LANES.progress,
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
      select 'trg_' || id, id, 'board_column_transition', ${builtin.columnKey}, 'any'
        from seeded
    `.execute(db);
  }
}
