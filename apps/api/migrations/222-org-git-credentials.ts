import { sql, type Kysely } from "kysely";

/**
 * Git credentials move from the agent to the organization.
 *
 * They were read off `metadata.runtime.submoduleCredentials` of whichever
 * virtual MCP a sandbox was started for. A task-board run starts its sandbox
 * for Decopilot, which has no row and no metadata (it is synthesized in
 * `VirtualMcpStorage.findById`), so every autonomous run booted with no
 * credentials however carefully the agent was configured — and the private
 * `git:` dependency they exist for 404s.
 *
 * A PAT for a host is org-wide in practice: the same `github.com` token
 * resolves that dependency for every repo in the org. So it lives on the org,
 * and every sandbox reads it regardless of which agent it belongs to.
 *
 * JSON in text, same as the neighbouring `coding_agent_mcp_excluded`. The
 * `submoduleCredentials` name stays — it is the daemon's wire name.
 *
 * The backfill parses in TS because `connections.metadata` is text: a
 * set-based query would cast every row to jsonb, and one bad row would fail
 * the migration.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("submodule_credentials", "text")
    .execute();

  const rows = await sql<{
    organization_id: string;
    metadata: string | null;
  }>`
    select organization_id, metadata
      from connections
     where connection_type = 'VIRTUAL'
       and metadata like '%submoduleCredentials%'
     order by updated_at asc
  `.execute(db);

  // Oldest-first above, so the newest agent's secret wins per host.
  const byOrg = new Map<string, Map<string, string>>();
  for (const row of rows.rows) {
    if (!row.metadata) continue;
    let creds: unknown;
    try {
      creds = JSON.parse(row.metadata)?.runtime?.submoduleCredentials;
    } catch {
      continue;
    }
    if (!Array.isArray(creds)) continue;
    for (const entry of creds) {
      const host = entry?.host;
      const secretId = entry?.secretId;
      if (typeof host !== "string" || !host) continue;
      if (typeof secretId !== "string" || !secretId) continue;
      const hosts = byOrg.get(row.organization_id) ?? new Map();
      hosts.set(host, secretId);
      byOrg.set(row.organization_id, hosts);
    }
  }

  const now = new Date().toISOString();
  for (const [organizationId, hosts] of byOrg) {
    const value = JSON.stringify(
      [...hosts].map(([host, secretId]) => ({ host, secretId })),
    );
    await sql`
      insert into organization_settings
             ("organizationId", submodule_credentials, "createdAt", "updatedAt")
      values (${organizationId}, ${value}, ${now}, ${now})
      on conflict ("organizationId") do update
         set submodule_credentials = excluded.submodule_credentials,
             "updatedAt" = excluded."updatedAt"
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("submodule_credentials")
    .execute();
}
