/**
 * E2E: the Commerce Discovery report banner on the PROJECT home (Overview).
 *
 * Not the org home: that landing is the agent roster, and the banner sits with
 * the project's own summary. Every test therefore visits the project's
 * canonical `/projects/<agentId>` workspace before asserting.
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
 *      report app nested under the Commerce Discovery agent.
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
const cdAgentId = (orgId: string) => `commerce-discovery_${orgId}`;
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
  projectId?: string,
): Promise<void> {
  await callSelfMcpTool(request, orgSlug, "COLLECTION_CONNECTIONS_CREATE", {
    data: {
      id: cdConnectionId(orgId),
      title: "Commerce Discovery (e2e)",
      connection_type: "HTTP",
      connection_url: url,
      metadata: { siteUrl: SITE_URL, ...(projectId ? { projectId } : {}) },
    },
  });
}

/** A source-backed project to scope the home to. Project Home is presence-gated
 *  on clonable source; the banner itself still reads the ORG's CD connection,
 *  so which source-backed project this is does not matter. */
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
        metadata: {
          githubRepo: {
            url: "https://github.com/example/commerce-report-banner",
            owner: "example",
            name: "commerce-report-banner",
          },
        },
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
  await page.goto(`/${orgSlug}/projects/${projectId}`);
  /** The task composer belongs to the PROJECT home — an unscoped landing
   *  renders the org roster and its search instead, never this. */
  await page
    .getByPlaceholder("What needs doing in this project?")
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
    await expect(
      page.getByPlaceholder("What needs doing in this project?"),
    ).toBeVisible();
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
      await page.waitForURL(
        (url) =>
          url.pathname ===
            `/${orgSlug}/projects/${cdAgentId(orgId)}/apps/${cdConnectionId(orgId)}/${REPORT_TOOL}` &&
          url.searchParams.get("virtualmcpid") === null &&
          url.searchParams.get("connection") === null &&
          url.searchParams.get("tool") === null,
        { timeout: 15_000 },
      );
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

  test("project Reports isolates a warmed org diagnostic and follows ownership transfers", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const orgId = await findOrgId(request, orgSlug);
    const projectOne = await createProject(request, orgSlug);
    const projectTwo = await createProject(request, orgSlug);

    const mcp = await startDiagnosticMcp({
      url: SITE_URL,
      scope: "private",
      scanned_at: "2026-07-10T12:00:00.000Z",
    });
    try {
      await createCdConnection(request, orgSlug, orgId, mcp.url, projectOne);

      // Warm both the org-level diagnostic and CD client caches first. A
      // disabled project query must not reuse either value for another owner.
      await waitForHome(page, orgSlug, projectTwo);
      await expect(
        page.getByRole("button", { name: new RegExp(READY_TITLE) }),
      ).toBeVisible({ timeout: HOME_TIMEOUT_MS });

      await page.goto(`/${orgSlug}/projects/${projectTwo}/reports`);
      await expect(
        page.getByRole("heading", { name: "No reports yet" }),
      ).toBeVisible({ timeout: HOME_TIMEOUT_MS });

      await page.goto(`/${orgSlug}/projects/${projectOne}/reports`);
      await expect(
        page.getByText(`Tool "${REPORT_TOOL}" was not found or has no UI.`),
      ).toBeVisible({ timeout: HOME_TIMEOUT_MS });

      await callSelfMcpTool(request, orgSlug, "COLLECTION_CONNECTIONS_UPDATE", {
        id: cdConnectionId(orgId),
        data: { metadata: { siteUrl: SITE_URL, projectId: projectTwo } },
      });

      // A hard navigation models another browser observing the durable owner,
      // independent of the mutation caller's in-memory query cache.
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "No reports yet" }),
      ).toBeVisible({ timeout: HOME_TIMEOUT_MS });

      await page.goto(`/${orgSlug}/projects/${projectTwo}/reports`);
      await expect(
        page.getByText(`Tool "${REPORT_TOOL}" was not found or has no UI.`),
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
    await expect(
      page.getByPlaceholder("What needs doing in this project?"),
    ).toBeVisible();
  });
});
