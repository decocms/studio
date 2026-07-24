/**
 * E2E coverage for the deployment-admin agent copy (/api/_admin/agents/:id/copy).
 *
 * The claim under test is specifically that CREDENTIALS travel: a connection
 * token that only exists encrypted in the source org must come back decrypted
 * and byte-identical when the TARGET org reads its own copy. Asserting the
 * ciphertext in Postgres could not prove that (the vault uses a random IV, so
 * two encryptions of the same value differ), and the suite can't import the
 * vault — so the assertion goes through the target org's own MCP surface,
 * which is also exactly how the copied agent will use it.
 *
 * Shares the reserved-admin identity mechanics with deployment-admin.spec.ts —
 * see that file's header for why an admin-side principal can't be per-test and
 * why the describe runs serial.
 *
 * The source/target orgs are minted ONCE for the whole describe rather than
 * per-test, which is a deliberate exception to the per-test-tenant doctrine in
 * TESTING.md: `/sign-up/email` is rate-limited, and a serial describe that
 * signs up two fresh users per test trips the limiter and turns the suite
 * flaky. Serial mode makes the sharing safe (no parallel writers), and every
 * assertion below is still scoped to the specific agent/connection id the test
 * created, never to an org-wide count.
 */
import type { APIRequestContext, PlaywrightWorkerArgs } from "@playwright/test";
import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi, TEST_PASSWORD } from "../fixtures/auth-api";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";
import {
  startTestMcpServer,
  type TestMcpServer,
} from "../fixtures/test-mcp-server";
import { expect, getE2EAppOrigin, newApiContext, test } from "../fixtures/test";

const DEPLOYMENT_ADMIN_EMAIL = "deployment-admin@e2e.local";

async function ensureDeploymentAdmin(
  request: APIRequestContext,
): Promise<{ userId: string }> {
  const signUpRes = await request.post("/api/auth/sign-up/email", {
    data: {
      email: DEPLOYMENT_ADMIN_EMAIL,
      password: TEST_PASSWORD,
      name: "Deployment Admin",
    },
  });
  const res = signUpRes.ok()
    ? signUpRes
    : await request.post("/api/auth/sign-in/email", {
        data: { email: DEPLOYMENT_ADMIN_EMAIL, password: TEST_PASSWORD },
      });
  if (!res.ok()) {
    throw new Error(
      `ensureDeploymentAdmin: HTTP ${res.status()} — ${await res
        .text()
        .catch(() => "<unreadable>")}`,
    );
  }
  const body = (await res.json()) as { user?: { id?: string } };
  if (!body.user?.id) {
    throw new Error("ensureDeploymentAdmin: response missing user.id");
  }
  return { userId: body.user.id };
}

async function orgIdForSlug(db: Client, slug: string): Promise<string> {
  const row = await db.query<{ id: string }>(
    `SELECT id FROM "organization" WHERE slug = $1`,
    [slug],
  );
  const id = row.rows[0]?.id;
  if (!id) throw new Error(`Org not found for slug ${slug}`);
  return id;
}

interface CopyResponse {
  agentId: string;
  title: string;
  sourceOrgId: string;
  targetOrgId: string;
  copiedConnections: { sourceId: string; targetId: string; title: string }[];
  remappedConnections: { sourceId: string; targetId: string }[];
  copiedSecrets: number;
  copiedPrompts: number;
  skipped: string[];
}

interface AgentEntity {
  id: string;
  title: string;
  metadata: { instructions?: string | null } & Record<string, unknown>;
  connections: { connection_id: string }[];
}

/** One tenant: an authenticated API context plus its org's slug and id. */
interface Tenant {
  ctx: APIRequestContext;
  orgSlug: string;
  orgId: string;
  userId: string;
}

test.describe("/api/_admin/agents/:id/copy", () => {
  test.describe.configure({ mode: "serial" });

  let db: Client;
  let mcpServer: TestMcpServer;
  let admin: APIRequestContext;
  let source: Tenant;
  let target: Tenant;

  /** Re-assert the shared admin's emailVerified flag — it's mutable state that
   *  deployment-admin.spec.ts also flips (see that file's header). */
  async function verifyAdmin(userId: string) {
    await db.query(`UPDATE "user" SET "emailVerified" = true WHERE id = $1`, [
      userId,
    ]);
  }

  async function signUpTenant(
    playwright: PlaywrightWorkerArgs["playwright"],
  ): Promise<Tenant> {
    const ctx = await newApiContext(playwright);
    const user = await signUpViaApi(ctx);
    return {
      ctx,
      orgSlug: user.orgSlug,
      orgId: await orgIdForSlug(db, user.orgSlug),
      userId: user.userId,
    };
  }

  test.beforeAll(async ({ playwright }) => {
    db = await connectDevDb();
    mcpServer = await startTestMcpServer();

    admin = await newApiContext(playwright);
    const adminUser = await ensureDeploymentAdmin(admin);
    await verifyAdmin(adminUser.userId);
    const me = await admin.get("/api/_admin/me");
    if (me.status() === 403) {
      throw new Error(
        "GET /api/_admin/me → 403 for the reserved admin: the app server is " +
          "missing DEPLOYMENT_ADMIN_EMAILS (see playwright.config.ts).",
      );
    }

    source = await signUpTenant(playwright);
    target = await signUpTenant(playwright);
  });

  test.afterAll(async () => {
    await Promise.all([
      admin?.dispose(),
      source?.ctx.dispose(),
      target?.ctx.dispose(),
    ]);
    await mcpServer?.stop();
    await db?.end();
  });

  test("copies the prompt, the connections, and their credentials", async () => {
    // A credential that must survive the trip verbatim. Unique per run so a
    // stale row from a previous run can never make this pass by accident.
    const secretToken = `tok_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connection = await createHttpConnection(source.ctx, source.orgSlug, {
      title: "Copyable Upstream",
      url: mcpServer.url,
      token: secretToken,
    });

    const instructions =
      "<role>Copy me verbatim, including this exact sentence.</role>";
    const created = await callSelfMcpTool<{ item: AgentEntity }>(
      source.ctx,
      source.orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: "Agent Worth Copying",
          description: "Aggregates one upstream and the org's own tools",
          metadata: { instructions },
          connections: [
            { connection_id: connection.id, selected_tools: ["echo"] },
            // A built-in, org-scoped connection: must be REMAPPED to the
            // target org's own `_self`, never copied as a second row pointing
            // at the source org's management surface.
            { connection_id: `${source.orgId}_self`, selected_tools: null },
          ],
          prompts: [
            { title: "Say hi", text: "Greet the user and list your tools." },
            { title: "Echo test", text: "Call echo with 'ping'." },
          ],
        },
      },
    );
    const sourceAgentId = created.item.id;

    const res = await admin.post(`/api/_admin/agents/${sourceAgentId}/copy`, {
      data: { targetOrgId: target.orgId },
    });
    expect(res.status(), await res.text().catch(() => "")).toBe(200);
    const result = (await res.json()) as CopyResponse;

    expect(result.sourceOrgId).toBe(source.orgId);
    expect(result.targetOrgId).toBe(target.orgId);
    expect(result.agentId).not.toBe(sourceAgentId);
    expect(result.copiedPrompts).toBe(2);

    // The upstream was copied; `_self` was remapped, not copied.
    expect(result.copiedConnections).toHaveLength(1);
    const copiedConn = result.copiedConnections[0]!;
    expect(copiedConn.sourceId).toBe(connection.id);
    expect(copiedConn.targetId).not.toBe(connection.id);
    expect(result.remappedConnections).toEqual([
      { sourceId: `${source.orgId}_self`, targetId: `${target.orgId}_self` },
    ]);

    // The copy is a real, readable agent in the target org, with the prompt
    // intact and its connection list pointing at TARGET-org ids only.
    const copied = await callSelfMcpTool<{ item: AgentEntity }>(
      target.ctx,
      target.orgSlug,
      "COLLECTION_VIRTUAL_MCP_GET",
      { id: result.agentId },
    );
    expect(copied.item.metadata.instructions).toBe(instructions);
    expect(copied.item.title).toBe("Agent Worth Copying");
    expect(copied.item.connections.map((c) => c.connection_id).sort()).toEqual(
      [copiedConn.targetId, `${target.orgId}_self`].sort(),
    );

    // The point of the whole feature: the target org can read the credential.
    const targetConn = await callSelfMcpTool<{
      item: { connection_token: string | null; organization_id: string };
    }>(target.ctx, target.orgSlug, "COLLECTION_CONNECTIONS_GET", {
      id: copiedConn.targetId,
    });
    expect(targetConn.item.connection_token).toBe(secretToken);
    expect(targetConn.item.organization_id).toBe(target.orgId);

    // Tenancy: the copy is a distinct row, and the source row is untouched.
    const rows = await db.query<{ id: string; organization_id: string }>(
      `SELECT id, organization_id FROM connections WHERE id = ANY($1::text[])`,
      [[connection.id, copiedConn.targetId]],
    );
    expect(rows.rows.map((r) => [r.id, r.organization_id]).sort()).toEqual(
      [
        [connection.id, source.orgId],
        [copiedConn.targetId, target.orgId],
      ].sort(),
    );

    // The source org cannot see the copy (cross-org reads return null).
    const leak = await callSelfMcpTool<{ item: unknown }>(
      source.ctx,
      source.orgSlug,
      "COLLECTION_VIRTUAL_MCP_GET",
      { id: result.agentId },
    );
    expect(leak.item).toBeNull();
  });

  test("reports what could not travel instead of copying it silently", async () => {
    const nested = await callSelfMcpTool<{ item: AgentEntity }>(
      source.ctx,
      source.orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      { data: { title: "Nested Helper", connections: [] } },
    );
    const parent = await callSelfMcpTool<{ item: AgentEntity }>(
      source.ctx,
      source.orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: "Parent With Baggage",
          metadata: {
            instructions: "<role>parent</role>",
            // Org-bound: must be dropped, and the drop must be reported.
            siteSlug: "some-source-site",
            productionUrl: "https://source.example",
          },
          // A nested agent (VIRTUAL connection) is not copied.
          connections: [{ connection_id: nested.item.id }],
        },
      },
    );

    const res = await admin.post(`/api/_admin/agents/${parent.item.id}/copy`, {
      data: { targetOrgId: target.orgId },
    });
    expect(res.status()).toBe(200);
    const result = (await res.json()) as CopyResponse;

    expect(result.copiedConnections).toEqual([]);
    expect(result.skipped.join("\n")).toContain("nested agents are not copied");
    expect(result.skipped.some((s) => s.includes("siteSlug"))).toBe(true);
    expect(result.skipped.some((s) => s.includes("productionUrl"))).toBe(true);

    // Dropped, not carried over as a dangling pointer.
    const copied = await callSelfMcpTool<{ item: AgentEntity }>(
      target.ctx,
      target.orgSlug,
      "COLLECTION_VIRTUAL_MCP_GET",
      { id: result.agentId },
    );
    expect(copied.item.metadata.siteSlug).toBeUndefined();
    expect(copied.item.metadata.productionUrl).toBeUndefined();
    expect(copied.item.metadata.instructions).toBe("<role>parent</role>");
    expect(copied.item.connections).toEqual([]);
  });

  test("validates input: missing target 400, unknown agent/org 404, same org 400", async () => {
    const agent = await callSelfMcpTool<{ item: AgentEntity }>(
      source.ctx,
      source.orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      { data: { title: "Validation Subject", connections: [] } },
    );

    const missing = await admin.post(
      `/api/_admin/agents/${agent.item.id}/copy`,
      { data: {} },
    );
    expect(missing.status()).toBe(400);

    const unknownAgent = await admin.post(
      `/api/_admin/agents/vir_nonexistent_${Date.now()}/copy`,
      { data: { targetOrgId: target.orgId } },
    );
    expect(unknownAgent.status()).toBe(404);

    const unknownOrg = await admin.post(
      `/api/_admin/agents/${agent.item.id}/copy`,
      { data: { targetOrgId: `org_nonexistent_${Date.now()}` } },
    );
    expect(unknownOrg.status()).toBe(404);

    const sameOrg = await admin.post(
      `/api/_admin/agents/${agent.item.id}/copy`,
      { data: { targetOrgId: source.orgId } },
    );
    expect(sameOrg.status()).toBe(400);
  });

  test("refuses to copy a system-managed Studio Pack agent", async () => {
    const packAgentId = `studio-agent-manager_${source.orgId}`;
    const res = await admin.post(`/api/_admin/agents/${packAgentId}/copy`, {
      data: { targetOrgId: target.orgId },
    });
    // 404 when the org hasn't been provisioned with the pack yet, 400 once it
    // has — either way it must never be copied.
    expect([400, 404]).toContain(res.status());

    // And the picker never offers them.
    const list = await admin.get(`/api/_admin/orgs/${source.orgId}/agents`);
    expect(list.status()).toBe(200);
    const body = (await list.json()) as { agents: { id: string }[] };
    expect(body.agents.some((a) => a.id.startsWith("studio-"))).toBe(false);
    // Sanity: the list is actually populated, so the assertion above isn't
    // passing on an empty array.
    expect(body.agents.length).toBeGreaterThan(0);
  });

  test("non-admins cannot reach the copy or agent-list routes", async () => {
    const list = await source.ctx.get(
      `/api/_admin/orgs/${source.orgId}/agents`,
    );
    expect([401, 403]).toContain(list.status());

    const copy = await source.ctx.post("/api/_admin/agents/vir_whatever/copy", {
      data: { targetOrgId: target.orgId },
    });
    expect([401, 403]).toContain(copy.status());
  });

  test("an admin can drive the whole copy from the browser", async ({
    browser,
  }) => {
    const agentTitle = `Browser Copy ${Date.now()}`;
    await callSelfMcpTool<{ item: AgentEntity }>(
      source.ctx,
      source.orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: agentTitle,
          metadata: { instructions: "<role>driven from the UI</role>" },
          connections: [],
        },
      },
    );

    const baseURL = getE2EAppOrigin();
    // Origin header so the sign-in POST clears Better Auth's CSRF guard — same
    // reason newApiContext sets it for standalone API contexts.
    const ctx = await browser.newContext({
      baseURL,
      extraHTTPHeaders: { Origin: baseURL },
    });
    const page = await ctx.newPage();
    const adminUser = await ensureDeploymentAdmin(page.context().request);
    await verifyAdmin(adminUser.userId);

    await page.goto("/_admin/copy-agent");

    // The three panes are labelled regions — both org pickers render the same
    // rows, so every locator below is scoped to its own pane.
    const sourcePane = page.getByRole("region", {
      name: "1. Source organization",
    });
    const agentPane = page.getByRole("region", { name: "2. Agent to copy" });
    const targetPane = page.getByRole("region", {
      name: "3. Target organization",
    });

    // Step 1: the source org. Searching by slug is precise on a long-lived dev
    // DB where the first unsearched page can't be asserted on.
    await expect(sourcePane).toBeVisible({ timeout: 15_000 });
    await sourcePane
      .getByPlaceholder("Search by name or slug...")
      .fill(source.orgSlug);
    await sourcePane
      .getByRole("radio", { name: new RegExp(source.orgSlug) })
      .click();

    // Step 2: the agent list loads for the picked org.
    const agentOption = agentPane.getByRole("radio", {
      name: new RegExp(agentTitle),
    });
    await expect(agentOption).toBeVisible({ timeout: 15_000 });
    await agentOption.click();

    // Step 3: the target org.
    await targetPane
      .getByPlaceholder("Search by name or slug...")
      .fill(target.orgSlug);
    await targetPane
      .getByRole("radio", { name: new RegExp(target.orgSlug) })
      .click();

    await page
      .getByRole("button", { name: new RegExp(`Copy "${agentTitle}"`) })
      .click();

    // The report renders, naming the agent and the org it landed in.
    await expect(
      page.getByText(`Copied "${agentTitle}" into`, { exact: false }),
    ).toBeVisible({ timeout: 15_000 });

    // And the copy really is in the target org, not just on screen.
    const list = await page
      .context()
      .request.get(`/api/_admin/orgs/${target.orgId}/agents`);
    expect(list.status()).toBe(200);
    const body = (await list.json()) as { agents: { title: string }[] };
    expect(body.agents.some((a) => a.title === agentTitle)).toBe(true);

    await ctx.close();
  });
});
