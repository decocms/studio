/**
 * E2E: per-org "main agent" setting round-trips through real Postgres.
 *
 * Black-box over the self MCP: set `main_agent_id`, read it back, prove a
 * partial update of a *different* settings field doesn't wipe it, then clear it
 * with an explicit `null`. This is the storage behavior an in-memory fake can't
 * catch — the `upsert` whitelist + doUpdateSet `undefined`-skips-`null`-persists
 * rules only hold against a real DB column.
 */

import { signUp } from "../fixtures/auth";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import {
  expect,
  extractOrgSlugFromUrl,
  test,
  waitForPostSignupRedirect,
} from "../fixtures/test";

interface OrgSettings {
  organizationId: string;
  main_agent_id?: string | null;
  reports_only?: boolean | null;
}

async function lookupOrgId(orgSlug: string): Promise<string> {
  const db = await connectDevDb();
  try {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM "organization" WHERE slug = $1`,
      [orgSlug],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error(`organization not found for slug: ${orgSlug}`);
    return id;
  } finally {
    await db.end();
  }
}

test.describe("Organization main agent setting", () => {
  test("sets, preserves across partial updates, and clears main_agent_id", async ({
    page,
  }) => {
    await signUp(page);
    await waitForPostSignupRedirect(page);
    const orgSlug = extractOrgSlugFromUrl(page);
    const orgId = await lookupOrgId(orgSlug);
    const request = page.context().request;

    // 1. Set the main agent.
    const set = await callSelfMcpTool<OrgSettings>(
      request,
      orgSlug,
      "ORGANIZATION_SETTINGS_UPDATE",
      { organizationId: orgId, main_agent_id: "vmcp-main-e2e" },
    );
    expect(set.main_agent_id).toBe("vmcp-main-e2e");

    // 2. A partial update of a different field must NOT wipe main_agent_id
    //    (undefined fields are skipped in doUpdateSet, not written as null).
    await callSelfMcpTool<OrgSettings>(
      request,
      orgSlug,
      "ORGANIZATION_SETTINGS_UPDATE",
      { organizationId: orgId, reports_only: true },
    );
    const afterPartial = await callSelfMcpTool<OrgSettings>(
      request,
      orgSlug,
      "ORGANIZATION_SETTINGS_GET",
      {},
    );
    expect(afterPartial.main_agent_id).toBe("vmcp-main-e2e");
    expect(afterPartial.reports_only).toBe(true);

    // 3. Explicit null clears it (org landing falls back to the Super Agent).
    await callSelfMcpTool<OrgSettings>(
      request,
      orgSlug,
      "ORGANIZATION_SETTINGS_UPDATE",
      { organizationId: orgId, main_agent_id: null },
    );
    const afterClear = await callSelfMcpTool<OrgSettings>(
      request,
      orgSlug,
      "ORGANIZATION_SETTINGS_GET",
      {},
    );
    expect(afterClear.main_agent_id ?? null).toBeNull();
    // The unrelated field survived the clear.
    expect(afterClear.reports_only).toBe(true);
  });

  test("deleting the main agent clears the dangling pointer", async ({
    page,
  }) => {
    await signUp(page);
    await waitForPostSignupRedirect(page);
    const orgSlug = extractOrgSlugFromUrl(page);
    const orgId = await lookupOrgId(orgSlug);
    const request = page.context().request;

    const created = await callSelfMcpTool<{ item: { id: string } }>(
      request,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      { data: { title: "Main Agent E2E" } },
    );
    const agentId = created.item.id;

    await callSelfMcpTool(request, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: orgId,
      main_agent_id: agentId,
    });
    const before = await callSelfMcpTool<OrgSettings>(
      request,
      orgSlug,
      "ORGANIZATION_SETTINGS_GET",
      {},
    );
    expect(before.main_agent_id).toBe(agentId);

    await callSelfMcpTool(request, orgSlug, "COLLECTION_VIRTUAL_MCP_DELETE", {
      id: agentId,
    });

    const after = await callSelfMcpTool<OrgSettings>(
      request,
      orgSlug,
      "ORGANIZATION_SETTINGS_GET",
      {},
    );
    expect(after.main_agent_id ?? null).toBeNull();
  });

  test("org landing opens the main agent when set", async ({ page }) => {
    await signUp(page);
    await waitForPostSignupRedirect(page);
    const orgSlug = extractOrgSlugFromUrl(page);
    const orgId = await lookupOrgId(orgSlug);
    const request = page.context().request;

    const created = await callSelfMcpTool<{ item: { id: string } }>(
      request,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      { data: { title: "Landing Agent E2E" } },
    );
    const agentId = created.item.id;
    await callSelfMcpTool(request, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: orgId,
      main_agent_id: agentId,
    });

    // A fresh entry into `/$org` must redirect to the main agent's thread,
    // carrying its id in the `virtualmcpid` search param.
    await page.goto(`/${orgSlug}`);
    await page.waitForURL(
      (url) => url.searchParams.get("virtualmcpid") === agentId,
    );
    expect(new URL(page.url()).searchParams.get("virtualmcpid")).toBe(agentId);
  });

  test("org landing falls back to the Super Agent when the main agent is missing", async ({
    page,
  }) => {
    await signUp(page);
    await waitForPostSignupRedirect(page);
    const orgSlug = extractOrgSlugFromUrl(page);
    const orgId = await lookupOrgId(orgSlug);
    const request = page.context().request;

    // Point at an id that isn't a real agent in this org — the resolver must
    // ignore it and land on the well-known Super Agent (`decopilot_<orgId>`).
    await callSelfMcpTool(request, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: orgId,
      main_agent_id: "vmcp-does-not-exist",
    });

    const superAgentId = `decopilot_${orgId}`;
    await page.goto(`/${orgSlug}`);
    await page.waitForURL(
      (url) => url.searchParams.get("virtualmcpid") === superAgentId,
    );
    expect(new URL(page.url()).searchParams.get("virtualmcpid")).toBe(
      superAgentId,
    );
  });
});
