/**
 * E2E: Studio tells the reports engine when an org lets go of its Deco Score
 * site. The fake engine (fixtures/reports-upgrade-mock.ts) records every
 * POST /unlink, and these specs read the record back for their own org.
 *
 * Covered:
 *   1. Setting up a second site releases the first, and deleting the
 *      connection releases the second.
 *   2. Deleting the org releases its site.
 */

import type { APIRequestContext } from "@playwright/test";
import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

/** Wire contract: the org's well-known Deco Score connection id. */
const reportsConnectionId = (orgId: string) => `${orgId}_commerce-discovery`;

const ENGINE_ORIGIN = `http://localhost:${process.env.COMMERCE_MOCK_PORT ?? "4100"}`;

async function releasedSites(
  engine: APIRequestContext,
  orgId: string,
): Promise<Array<{ domain: string; org_id: string }>> {
  const res = await engine.get(
    `/__e2e/unlinks?org_id=${encodeURIComponent(orgId)}`,
  );
  return res.json();
}

test("switching sites and deleting the connection each release a site", async ({
  authedPage,
  playwright,
}) => {
  const { page, orgSlug } = authedPage;
  const orgId = await findOrgId(page.request, orgSlug);
  const engine = await playwright.request.newContext({
    baseURL: ENGINE_ORIGIN,
  });

  await callSelfMcpTool(page.request, orgSlug, "REPORTS_SETUP", {
    siteUrl: "https://first-shop.example",
  });
  await callSelfMcpTool(page.request, orgSlug, "REPORTS_SETUP", {
    siteUrl: "https://second-shop.example",
  });
  await expect
    .poll(() => releasedSites(engine, orgId))
    .toEqual([{ domain: "first-shop.example", org_id: orgId }]);

  await callSelfMcpTool(
    page.request,
    orgSlug,
    "COLLECTION_CONNECTIONS_DELETE",
    { id: reportsConnectionId(orgId), force: true },
  );
  await expect
    .poll(() => releasedSites(engine, orgId))
    .toEqual([
      { domain: "first-shop.example", org_id: orgId },
      { domain: "second-shop.example", org_id: orgId },
    ]);

  await engine.dispose();
});

test("deleting the org releases its site", async ({
  authedPage,
  playwright,
}) => {
  const { page, orgSlug } = authedPage;
  const orgId = await findOrgId(page.request, orgSlug);
  const engine = await playwright.request.newContext({
    baseURL: ENGINE_ORIGIN,
  });

  await callSelfMcpTool(page.request, orgSlug, "REPORTS_SETUP", {
    siteUrl: "https://closing-shop.example",
  });
  await callSelfMcpTool(page.request, orgSlug, "ORGANIZATION_DELETE", {
    id: orgId,
  });
  await expect
    .poll(() => releasedSites(engine, orgId))
    .toEqual([{ domain: "closing-shop.example", org_id: orgId }]);

  await engine.dispose();
});
