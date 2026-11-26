/**
 * Fill `connections.configuration_secret_fields` for HTTP connections saved
 * before their MCP declared `Secret()` fields. Until a row has the list, tool
 * responses return its configuration unredacted. Run it after the MCPs that
 * mark their credentials `Secret()` are deployed.
 *
 *   DATABASE_URL=... bun run --cwd apps/api scripts/backfill-connection-secret-fields.ts --dry-run
 *   DATABASE_URL=... bun run --cwd apps/api scripts/backfill-connection-secret-fields.ts --apply
 *
 * --dry-run (default) reports what each MCP declares; --apply writes the list.
 * Reads MCP_CONFIGURATION once per distinct URL, without credentials, and
 * never reads or rewrites configuration values. Only rows with no list yet are
 * touched, so re-running is safe.
 */
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { secretFieldsFromStateSchema } from "@decocms/shared/sdk";

const dbUrl = process.env.DATABASE_URL;
const apply = process.argv.includes("--apply");

async function secretFieldsFor(url: string): Promise<string[] | null> {
  const client = new Client({ name: "backfill-secret-fields", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const result = await client.callTool({
      name: "MCP_CONFIGURATION",
      arguments: {},
    });
    const text = (result.content as { type: string; text?: string }[]).find(
      (c) => c.type === "text",
    )?.text;
    return text
      ? secretFieldsFromStateSchema(JSON.parse(text)?.stateSchema)
      : null;
  } catch {
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  if (!dbUrl) throw new Error("DATABASE_URL is required");
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  try {
    const { rows } = await db.query<{ id: string; connection_url: string }>(
      `select id, connection_url from connections
       where connection_type = 'HTTP' and connection_url is not null
         and configuration_state is not null
         and configuration_secret_fields is null`,
    );
    const byUrl = Map.groupBy(rows, (row) => row.connection_url);
    console.log(`${rows.length} connections, ${byUrl.size} MCP URLs`);

    let updated = 0;
    for (const [url, connections] of byUrl) {
      const fields = await secretFieldsFor(url);
      if (!fields?.length) {
        console.log(
          `skip ${url}: ${fields ? "no secret fields" : "unreachable"}`,
        );
        continue;
      }
      console.log(
        `${url}: [${fields.join(", ")}] on ${connections.length} connections`,
      );
      if (!apply) continue;
      const result = await db.query(
        `update connections set configuration_secret_fields = $1
         where id = any($2) and configuration_secret_fields is null`,
        [JSON.stringify(fields), connections.map((c) => c.id)],
      );
      updated += result.rowCount ?? 0;
    }
    console.log(
      apply ? `updated ${updated} connections` : "dry run: nothing written",
    );
  } finally {
    await db.end();
  }
}

await main();
