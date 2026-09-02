/**
 * E2E: the Commerce Discovery report banner on the PROJECT home (Overview).
 *
 * Not the org home: that landing is the agent roster now, and the banner sits
 * with the project's own summary. Every test therefore scopes to a project
 * (`?virtualmcpid=`) before asserting — an unscoped home renders the roster and
 * would fail these for the wrong reason.
 *
 * The banner reads run state live from the CD connection's own MCP
 * (`get_my_diagnostic`), so these specs stand up a controlled test MCP
 * server (fixtures/test-mcp-server.ts) and register it under the org's
 * well-known Commerce Discovery connection id. Wire-contract strings
 * (tool name, connection id shape, banner copy) are inlined on purpose —
 * this suite owns its contract (see ban-e2e-app-imports).
 *
 * Covered:
 *   1. Org without the CD connection → no banner, home intact.
 *   2. Completed diagnostic → "ready" banner; click navigates to the
 *      report app (the CD project's chat path, a fresh `?thread=` and a pinned main tab).
 *   3. Live run → "generating" banner.
 *   4. CD connection whose MCP is unreachable → no banner, home intact.
 */

import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";
import {
  startTestMcpServer,
  type TestMcpServer,
} from "../fixtures/test-mcp-server";
import { expect, test } from "../fixtures/test";

/** Wire contract: the org's well-known CD connection id
 *  (WellKnownOrgMCPId.COMMERCE_DISCOVERY) and the report tool name. */
const cdConnectionId = (orgId: string) => `${orgId}_commerce-discovery`;
const REPORT_TOOL = "get_my_diagnostic";

const READY_TITLE = "Your report is ready";
const GENERATING_TITLE = "Generating your diagnostic";

const SITE_URL = "https://minha-loja.example";

/** Cold-Vite first paint can take tens of seconds on a fresh sandbox. */
const HOME_TIMEOUT_MS = 60_000;

/** Resolve the org id for a slug via Better Auth's organization list —
 *  the same endpoint signUpViaApi uses to resolve the slug. */
async function findOrgId(
  request: APIRequestContext,
  orgSlug: string,
): Promise<string> {
  const res = await request.get("/api/auth/organization/list");
  if (!res.ok()) {
    throw new Error(`organization/list → HTTP ${res.status()}`);
  }
  const body = (await res.json()) as
    | Array<{ id: string; slug: string }>
    | { data?: Array<{ id: string; slug: string }> };
  const orgs = Array.isArray(body) ? body : (body.data ?? []);
  const org = orgs.find((o) => o.slug === orgSlug);
  if (!org) throw new Error(`org ${orgSlug} not found in organization/list`);
  return org.id;
}

/** Diagnostic rows as `get_my_diagnostic` returns them (owner view). */
interface DiagnosticFixture {
  url: string;
  scope: string;
  scanned_at: string | null;
  run_in_progress?: boolean;
}

function startDiagnosticMcp(
  diagnostic: DiagnosticFixture,
): Promise<TestMcpServer> {
  return startTestMcpServer({
    tools: [
      {
        name: REPORT_TOOL,
        description: "Return the diagnostic for the store.",
        outputSchema: {
          diagnostic: z
            .object({
              url: z.string(),
              scope: z.string(),
              scanned_at: z.string().nullable(),
              run_in_progress: z.boolean().optional(),
            })
            .nullable(),
        },
        handler: () => ({ diagnostic }),
      },
    ],
  });
}

/** Register `url` as the org's well-known CD connection. */
async function createCdConnection(
  request: APIRequestContext,
  orgSlug: string,
  orgId: string,
  url: string,
): Promise<void> {
  await callSelfMcpTool(request, orgSlug, "COLLECTION_CONNECTIONS_CREATE", {
    data: {
      id: cdConnectionId(orgId),
      title: "Commerce Discovery (e2e)",
      connection_type: "HTTP",
      connection_url: url,
      metadata: { siteUrl: SITE_URL },
    },
  });
}

/** A project to scope the home to. The banner reads the ORG's CD connection,
 *  so which project this is does not matter — only that one is in scope, which
 *  is what makes the home render the Overview rather than the roster. */
async function createProject(
  request: APIRequestContext,
  orgSlug: string,
): Promise<string> {
  const connection = await createHttpConnection(request, orgSlug, {
    title: "banner-scope placeholder",
    url: "http://127.0.0.1:1/unused",
  });
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    request,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: "Banner scope",
        status: "active",
        connections: [{ connection_id: connection.id }],
      },
    },
  );
  return agent.item.id;
}

async function waitForHome(
  page: Page,
  orgSlug: string,
  projectId: string,
): Promise<void> {
  await page.goto(`/${orgSlug}/home?virtualmcpid=${projectId}`);
  /** "Customize" belongs to the tile board, which is the PROJECT home — an
   *  unscoped landing renders the agent roster and never shows it. */
  await page
    .getByRole("button", { name: "Customize" })
    .waitFor({ state: "visible", timeout: HOME_TIMEOUT_MS });
}

test.describe("commerce report banner", () => {
  test("org without the CD connection shows no banner and home stays intact", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const projectId = await createProject(request, orgSlug);
    // Register before navigating so we don't miss the response if the gate
    // resolves before we can await below (the app has persistent SSE
    // connections so waitForLoadState("networkidle") never settles). The self
    // client calls builtin tools over REST (POST /api/:org/tools/:name), so
    // the tool name is in the URL path, not the /mcp/self body.
    const connectionGateDone = page.waitForResponse(
      (resp) => resp.url().includes("/tools/COLLECTION_CONNECTIONS_GET"),
      { timeout: HOME_TIMEOUT_MS },
    );
    await waitForHome(page, orgSlug, projectId);
    // Gate 1 resolved with { item: null } — banner correctly stays hidden.
    await connectionGateDone;
    await expect(
      page.getByRole("button", { name: new RegExp(READY_TITLE) }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: new RegExp(GENERATING_TITLE) }),
    ).toHaveCount(0);
    // Home is still functional.
    await expect(page.getByRole("button", { name: "Customize" })).toBeVisible();
  });

  test("completed diagnostic shows the ready banner and opens the report app", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const orgId = await findOrgId(request, orgSlug);
    const projectId = await createProject(request, orgSlug);

    const mcp = await startDiagnosticMcp({
      url: SITE_URL,
      scope: "private",
      scanned_at: "2026-07-10T12:00:00.000Z",
    });
    try {
      await createCdConnection(request, orgSlug, orgId, mcp.url);
      await waitForHome(page, orgSlug, projectId);

      const banner = page.getByRole("button", {
        name: new RegExp(READY_TITLE),
      });
      await expect(banner).toBeVisible({ timeout: HOME_TIMEOUT_MS });
      // The subtitle names the store from the connection metadata.
      await expect(banner).toContainText("minha-loja.example");

      await banner.click();
      // Agent and view are both path here; only the view's param stays search.
      await expect(page).toHaveURL(
        new RegExp(
          `/${orgSlug}/agents/app\\?.*virtualmcpid=commerce-discovery_`,
        ),
        { timeout: 15_000 },
      );
      expect(new URL(page.url()).searchParams.get("tool")).toBe(REPORT_TOOL);
    } finally {
      await mcp.stop();
    }
  });

  test("live run shows the generating banner", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const orgId = await findOrgId(request, orgSlug);
    const projectId = await createProject(request, orgSlug);

    const mcp = await startDiagnosticMcp({
      url: SITE_URL,
      scope: "private",
      scanned_at: null,
      run_in_progress: true,
    });
    try {
      await createCdConnection(request, orgSlug, orgId, mcp.url);
      await waitForHome(page, orgSlug, projectId);

      await expect(
        page.getByRole("button", { name: new RegExp(GENERATING_TITLE) }),
      ).toBeVisible({ timeout: HOME_TIMEOUT_MS });
    } finally {
      await mcp.stop();
    }
  });

  test("unreachable CD MCP hides the banner without breaking home", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const orgId = await findOrgId(request, orgSlug);
    const projectId = await createProject(request, orgSlug);

    // Nothing listens here — the connection exists but its MCP is dead.
    await createCdConnection(
      request,
      orgSlug,
      orgId,
      "http://127.0.0.1:9/dead",
    );
    // Register before navigating — the failing CD probe fires after the
    // connection gate resolves and might complete before we await below.
    const diagnosticFailed = page.waitForResponse(
      (resp) => resp.url().includes(cdConnectionId(orgId)) && !resp.ok(),
      { timeout: HOME_TIMEOUT_MS },
    );
    await waitForHome(page, orgSlug, projectId);
    // diagnosticQuery entered error state — banner stays hidden.
    await diagnosticFailed;
    await expect(
      page.getByRole("button", { name: new RegExp(READY_TITLE) }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: new RegExp(GENERATING_TITLE) }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Customize" })).toBeVisible();
  });
});
