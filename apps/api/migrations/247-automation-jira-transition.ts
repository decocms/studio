import { type Kysely, sql } from "kysely";

/**
 * A trigger that fires when a Jira issue enters a status, and the Jira status
 * rules copied into automations that use it.
 *
 * `jira_transition` reuses the board trigger's columns: `column_key` holds the
 * Jira status NAME the issue entered (what the webhook reports), and
 * `from_kind` / `from_statuses` say which moves count, with status names in
 * the list.
 *
 * Each `org_jira_column_automations` rule becomes an automation on the org's
 * Super Agent, created by whoever connected Jira, with the rule's prompt as
 * its message. The ids are derived from the rule's key, so running this again
 * copies nothing twice. The rules table stays: the previous release still
 * reads it, and a later migration drops it.
 *
 * The allowed trigger types are read back from the constraint rather than
 * listed here, so this composes with any other migration that adds a type.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{ def: string }>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname = 'chk_trigger_type'
       AND conrelid = 'automation_triggers'::regclass
  `.execute(db);
  const types = new Set(
    [...(rows[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!),
  );
  if (!types.has("jira_transition")) {
    types.add("jira_transition");
    const list = sql.join([...types].map((type) => sql.lit(type)));
    await sql`
      ALTER TABLE automation_triggers DROP CONSTRAINT chk_trigger_type,
        ADD CONSTRAINT chk_trigger_type CHECK (type IN (${list}))
    `.execute(db);
  }
  await sql`
    ALTER TABLE automation_triggers
      DROP CONSTRAINT IF EXISTS chk_jira_transition_trigger,
      ADD CONSTRAINT chk_jira_transition_trigger CHECK (
        type != 'jira_transition'
        OR (column_key IS NOT NULL
            AND from_kind IN ('any', 'earlier', 'later', 'statuses'))
      )
  `.execute(db);

  const { rows: rules } = await sql<{
    organization_id: string;
    jira_status: string;
    from_kind: "any" | "earlier" | "later" | "statuses";
    from_statuses: string[];
    from_key: string;
    prompt: string | null;
    created_by: string;
  }>`
    SELECT r.organization_id, r.jira_status, r.from_kind, r.from_statuses,
           r.from_key, r.prompt, i.created_by
      FROM org_jira_column_automations r
      JOIN org_jira_integrations i ON i.organization_id = r.organization_id
  `.execute(db);
  for (const rule of rules) {
    const { rows: ids } = await sql<{ id: string }>`
      SELECT 'auto_jira_' || md5(${rule.organization_id} || chr(10) ||
             ${rule.jira_status} || chr(10) || ${rule.from_key}) AS id
    `.execute(db);
    const id = ids[0]!.id;
    await sql`
      INSERT INTO automations
        (id, organization_id, name, active, created_by, messages, models,
         virtual_mcp_id)
      VALUES (${id}, ${rule.organization_id}, ${ruleName(rule)}, true,
              ${rule.created_by}, ${JSON.stringify(promptMessages(rule.prompt))},
              '{"tier":"smart"}', ${`decopilot_${rule.organization_id}`})
      ON CONFLICT (id) DO NOTHING
    `.execute(db);
    await sql`
      INSERT INTO automation_triggers
        (id, automation_id, type, column_key, from_kind, from_statuses)
      VALUES (${`trg_${id}`}, ${id}, 'jira_transition', ${rule.jira_status},
              ${rule.from_kind}, ${rule.from_statuses})
      ON CONFLICT (id) DO NOTHING
    `.execute(db);
  }
}

function ruleName(rule: {
  jira_status: string;
  from_kind: string;
  from_statuses: string[];
}): string {
  const from =
    rule.from_kind === "earlier"
      ? " (from an earlier column)"
      : rule.from_kind === "later"
        ? " (from a later column)"
        : rule.from_kind === "statuses"
          ? ` (from ${rule.from_statuses.join(", ")})`
          : "";
  return `Jira: ${rule.jira_status}${from}`;
}

/** The message the automation editor reads back: the prompt as the text the
 *  agent gets, and as one editor paragraph per line. */
function promptMessages(prompt: string | null): unknown[] {
  if (!prompt?.trim()) return [];
  return [
    {
      role: "user",
      parts: [{ type: "text", text: prompt }],
      metadata: {
        tiptapDoc: {
          type: "doc",
          content: prompt
            .split("\n")
            .map((line) =>
              line
                ? { type: "paragraph", content: [{ type: "text", text: line }] }
                : { type: "paragraph" },
            ),
        },
      },
    },
  ];
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM automations WHERE id LIKE 'auto_jira_%'`.execute(db);
  await sql`DELETE FROM automation_triggers WHERE type = 'jira_transition'`.execute(
    db,
  );
  await sql`
    ALTER TABLE automation_triggers
      DROP CONSTRAINT IF EXISTS chk_jira_transition_trigger
  `.execute(db);
}
