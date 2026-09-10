/**
 * Wire the local MCP-app server (`scripts/dev-mcp-app.ts`) into an org as a
 * real HTTP connection, attached to a project — so the project's settings show
 * the app-views group, and each view opens.
 *
 * Nothing is faked in the DB: the connection's `tools` column stays null, so
 * Studio fetches `tools/list` live and derives the views from the `_meta.ui`
 * each tool carries. Start the server first, or the group renders empty.
 *
 * Run (from the repo root, server already up):
 *   bun run scripts/dev-mcp-app.ts &
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:<port>/postgres \
 *   bun run scripts/dev-seed-mcp-app-connection.ts \
 *     [--org=<slug|id>] [--project="Demo Store"] [--port=8789] [--pin]
 *
 * Idempotent: re-running updates the connection in place and keeps it attached
 * exactly once. `--pin` also pins every view to the project's sidebar.
 */

import { closeDatabase, createDatabase } from "../apps/api/src/database";
import { CredentialVault } from "../apps/api/src/encryption/credential-vault";
import { getSettings } from "../apps/api/src/settings";
import { ConnectionStorage } from "../apps/api/src/storage/connection";
import { VirtualMCPStorage } from "../apps/api/src/storage/virtual";

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v = "true"] = a.slice(2).split("=");
      return [k, v] as const;
    }),
);

const ORG_REF = args.get("org");
const PROJECT_TITLE = args.get("project") ?? "Demo Store";
const PORT = Number(args.get("port") ?? 8789);
const MCP_URL = args.get("url") ?? `http://localhost:${PORT}/mcp`;
const TITLE = args.get("title") ?? "Store Insights";
const PIN_VIEWS = args.get("pin") === "true";

async function main() {
  const database = createDatabase(process.env.DATABASE_URL);
  const db = database.db;

  const orgs = await db
    .selectFrom("organization")
    .select(["id", "name", "slug"])
    .where("id", "!=", "org_orgfs_public_skills")
    .execute();
  const org = ORG_REF
    ? orgs.find((o) => o.slug === ORG_REF || o.id === ORG_REF)
    : orgs[0];
  if (!org) {
    throw new Error(
      `organization not found (${ORG_REF ?? "first"}); have: ${orgs
        .map((o) => o.slug)
        .join(", ")}`,
    );
  }

  const owner = await db
    .selectFrom("member")
    .innerJoin("user", "user.id", "member.userId")
    .select(["user.id as id", "user.email as email"])
    .where("member.organizationId", "=", org.id)
    .orderBy("member.createdAt", "asc")
    .executeTakeFirst();
  if (!owner) throw new Error(`no member found for org ${org.slug}`);

  const project = await db
    .selectFrom("connections")
    .select(["id", "title"])
    .where("organization_id", "=", org.id)
    .where("connection_type", "=", "VIRTUAL")
    .where("title", "=", PROJECT_TITLE)
    .executeTakeFirst();
  if (!project) {
    throw new Error(
      `project "${PROJECT_TITLE}" not found in ${org.slug} — run scripts/dev-seed-demo-project.ts first`,
    );
  }

  const connections = new ConnectionStorage(
    db,
    new CredentialVault(getSettings().encryptionKey),
  );

  const existing = await db
    .selectFrom("connections")
    .select(["id"])
    .where("organization_id", "=", org.id)
    .where("connection_type", "=", "HTTP")
    .where("title", "=", TITLE)
    .executeTakeFirst();

  const data = {
    organization_id: org.id,
    title: TITLE,
    description: "Local MCP app server with UI tools (dev fixture).",
    icon: "icon://ChartBreakoutSquare?color=violet",
    connection_type: "HTTP" as const,
    connection_url: MCP_URL,
    /** Null keeps the list live: Studio calls `tools/list` and caches it. */
    tools: null,
    created_by: owner.id,
    updated_by: owner.id,
  };

  const connection = existing
    ? await connections.update(existing.id, data)
    : await connections.create(data);
  console.log(
    `${existing ? "updated" : "created"} connection: ${connection.title} (${connection.id}) → ${MCP_URL}`,
  );

  const attached = await db
    .selectFrom("connection_aggregations")
    .select("child_connection_id")
    .where("parent_connection_id", "=", project.id)
    .where("dependency_mode", "=", "direct")
    .execute();
  const childIds = new Set(attached.map((a) => a.child_connection_id));
  const virtualMcps = new VirtualMCPStorage(db);

  if (!childIds.has(connection.id)) {
    childIds.add(connection.id);
    await virtualMcps.update(project.id, owner.id, {
      connections: [...childIds].map((id) => ({ connection_id: id })),
    });
    console.log(`attached to project ${project.title} (${project.id})`);
  } else {
    console.log(`already attached to project ${project.title}`);
  }

  if (PIN_VIEWS) {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    const payload = (await res.json()) as {
      result?: {
        tools?: {
          name: string;
          title?: string;
          _meta?: { ui?: { resourceUri?: string } };
        }[];
      };
    };
    const viewTools = (payload.result?.tools ?? []).filter(
      (t) => t._meta?.ui?.resourceUri,
    );
    const current = await virtualMcps.findById(project.id);
    const metadata = {
      ...(current?.metadata ?? {}),
      ui: {
        ...(current?.metadata?.ui ?? {}),
        pinnedViews: viewTools.map((t) => ({
          connectionId: connection.id,
          toolName: t.name,
          label: t.title ?? t.name,
          icon: null,
        })),
      },
    };
    await virtualMcps.update(project.id, owner.id, { metadata });
    console.log(
      `pinned ${viewTools.length} views: ${viewTools.map((t) => t.title ?? t.name).join(", ")}`,
    );
  }

  console.log(
    `\nopen: /${org.slug}/agents/settings?virtualmcpid=${project.id}` +
      `\n  the app views sit under "Visualizações de apps"; clicking one opens it.`,
  );

  await closeDatabase(database);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
