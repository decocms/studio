import { demoBundle } from "../fixtures/demo-bundle";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { APIRequestContext } from "@playwright/test";
import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { expect, test, newApiContext } from "../fixtures/test";
import { signUpViaApi } from "../fixtures/auth-api";

type Task = {
  id: string;
  title: string;
  status: string;
  threads: { threadId: string; status: string }[];
};
async function call<T>(
  request: APIRequestContext,
  org: string,
  tool: string,
  body: unknown = {},
): Promise<T> {
  const response = await request.post(`/api/${org}/tools/${tool}`, {
    data: body,
  });
  expect(response.ok(), `${tool}: ${await response.text()}`).toBeTruthy();
  return response.json();
}
const DEMO_ORG_ID = "e2e-demo-organization";

async function provision(db: Client, homeSlug: string) {
  const slug = `${homeSlug}-demo`;
  const { rows } = await db.query(
    'SELECT m."userId" FROM organization o JOIN member m ON m."organizationId"=o.id WHERE o.slug = $1 LIMIT 1',
    [homeSlug],
  );
  const owner = rows[0].userId as string;
  const org = DEMO_ORG_ID;
  await db.query("DELETE FROM organization WHERE id=$1", [org]);
  await db.query(
    'INSERT INTO organization (id,slug,name,"createdAt") VALUES ($1,$2,$3,now())',
    [org, slug, "Configured demo"],
  );
  await db.query(
    `INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'owner',now())`,
    [crypto.randomUUID(), org, owner],
  );
  // Registration is deployment-admin CLI state, intentionally unavailable through the product API.
  await db.query(
    "INSERT INTO demo_organizations (organization_id,scenario) VALUES ($1,'storefront-v1')",
    [org],
  );
  await db.query(
    `INSERT INTO organization_settings ("organizationId", flags, "createdAt", "updatedAt") VALUES ($1, $2::jsonb, now()::text, now()::text) ON CONFLICT ("organizationId") DO UPDATE SET flags = coalesce(organization_settings.flags, '{}'::jsonb) || excluded.flags`,
    [
      org,
      JSON.stringify({
        demo_mode_enabled: true,
        delivery_lanes_enabled: true,
        reviewer_enabled: false,
        qa_agent_enabled: false,
        code_reviewer_enabled: false,
        auto_merge: false,
      }),
    ],
  );
  await db.query(
    "INSERT INTO demo_bundles (organization_id,payload) VALUES ($1,$2::jsonb)",
    [org, JSON.stringify(demoBundle)],
  );
  await db.query(
    "INSERT INTO connections (id,organization_id,created_by,updated_by,title,connection_type,connection_url,status,metadata) VALUES ($1,$2,$3,$3,'Store Report','HTTP','https://reports.example.test/mcp','active',$4::jsonb)",
    [
      org + "_commerce-discovery",
      org,
      owner,
      JSON.stringify({ siteUrl: demoBundle.source.siteUrl }),
    ],
  );
  await resetDemo(org, {
    idempotencyKey: "initial",
    expectedGeneration: 0,
  });
  return { org, slug };
}
let admin: APIRequestContext;
async function resetDemo(org: string, body: unknown) {
  const response = await admin.post(`/api/_admin/orgs/${org}/demo/reset`, {
    data: body,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<{ generation: number }>;
}
async function tasks(request: APIRequestContext, org: string) {
  return (await call<{ items: Task[] }>(request, org, "TASK_BOARD_ITEM_LIST"))
    .items;
}

test.describe("persisted demonstration organization", () => {
  // Only this suite owns the one configured deployment demo ID.
  test.describe.configure({ mode: "serial" });
  test.setTimeout(90_000);
  let db: Client;
  test.beforeAll(async ({ playwright }) => {
    db = await connectDevDb();
    admin = await newApiContext(playwright);
    // This suite owns this fixed allowlisted identity, independent of deployment-admin.spec.ts.
    const email = "demo-admin@e2e.local";
    const signin = await admin.post("/api/auth/sign-in/email", {
      data: { email, password: "Playwright123!" },
    });
    if (!signin.ok()) await signUpViaApi(admin, { email });
    await db.query('UPDATE "user" SET "emailVerified"=true WHERE email=$1', [
      email,
    ]);
    const probe = await admin.get("/api/_admin/me");
    expect(
      probe.ok(),
      "Start the server with DEPLOYMENT_ADMIN_EMAILS including demo-admin@e2e.local",
    ).toBeTruthy();
  });
  test.afterAll(async () => {
    await db.query("DELETE FROM organization WHERE id=$1", [DEMO_ORG_ID]);
    await admin?.dispose();
    await db.end();
  });

  test("runs without provider credentials, keeps state across reload, and serves a functional preview", async ({
    authedPage,
  }, testInfo) => {
    const { page, orgSlug: homeSlug } = authedPage;
    const request = page.context().request;
    const { org, slug: orgSlug } = await provision(db, homeSlug);
    await db.query("DELETE FROM ai_provider_keys WHERE organization_id = $1", [
      org,
    ]);
    const client = new McpClient({ name: "demo-contract-test", version: "1" });
    const origin = new URL((await request.get("/api/config")).url()).origin;
    const cookies = (await page.context().cookies())
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`/api/${orgSlug}/mcp/${org}_commerce-discovery`, origin),
        { requestInit: { headers: { Cookie: cookies, Origin: origin } } },
      ),
    );
    try {
      const result = await client.callTool({
        name: "get_my_diagnostic",
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        diagnostic: {
          org_id: org,
          url: demoBundle.source.siteUrl,
          run_in_progress: false,
        },
      });
      const resource = await client.readResource({ uri: "ui://reports/app" });
      expect(resource.contents[0]).toMatchObject({
        mimeType: "text/html;profile=mcp-app",
        text: demoBundle.reportsHtml,
      });
      expect(
        (await client.callTool({ name: "rerun_my_diagnostic", arguments: {} }))
          .structuredContent,
      ).toMatchObject({ rerunning: true });
    } finally {
      await client.close();
    }
    const initial = await tasks(request, orgSlug);
    expect(initial).toHaveLength(10);
    const search = initial.find(
      (t) => t.title === "Make product search visible in the header",
    )!;
    await page.goto(`/${orgSlug}/tasks`);
    await expect(
      page.getByRole("button", { name: "Prepare demonstration", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("demo-board.png"),
      fullPage: true,
    });
    const card = page
      .getByRole("button", { name: new RegExp(`^${search.title}`) })
      .first();
    await card.hover();
    await card.getByRole("button", { name: "Run", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await tasks(request, orgSlug)).find((t) => t.id === search.id)
            ?.status,
        { timeout: 20_000 },
      )
      .toBe("in_review");
    await card.click();
    await expect(
      page.getByRole("button", { name: "In Review", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: /Make product search visible in the header.*started by/,
      })
      .click();
    const transcript = page.getByTestId("task-thread-sheet");
    await expect(transcript).toContainText("The header now has a search field");
    await transcript
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Ship to production", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Done", exact: true }),
    ).toBeVisible();
    const { prs } = await call<{ prs: { previewUrl: string; url: string }[] }>(
      request,
      orgSlug,
      "TASK_BOARD_ITEM_PRS_GET",
      { taskBoardItemId: search.id },
    );
    expect(prs).toHaveLength(1);
    await page.goto(prs[0]!.previewUrl);
    await page.screenshot({
      path: testInfo.outputPath("demo-preview.png"),
      fullPage: true,
    });
    await expect(
      page.getByRole("searchbox", { name: "Search products" }),
    ).toBeVisible();
    await page.goto(`${prs[0]!.previewUrl}?before=1`);
    await expect(page.getByRole("searchbox")).toHaveCount(0);
    await page.goto(prs[0]!.url);
    await expect(
      page.getByRole("heading", { name: search.title, exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await call(request, orgSlug, "TASK_BOARD_PROMOTE_TO_PRODUCTION", {
      taskBoardItemId: search.id,
    });
    await page.goto(`/${orgSlug}/tasks`);
    await page.reload();
    expect(
      (await tasks(request, orgSlug)).find((t) => t.id === search.id)?.status,
    ).toBe("done");
    const runs = await db.query(
      "SELECT state, step FROM demo_runs WHERE organization_id = $1",
      [org],
    );
    expect(runs.rows).toEqual([{ state: "completed", step: 3 }]);
    const parts = await db.query(
      "SELECT count(*)::int AS n FROM thread_message_parts WHERE org_id = $1 AND kind = 'text' AND role = 'assistant' AND thread_id = (SELECT thread_id FROM demo_runs WHERE organization_id = $1 LIMIT 1)",
      [org],
    );
    expect(parts.rows[0].n).toBe(3);
    await page.goto(`/api/${orgSlug}/demo/storefront`);
    await expect(page.getByRole("searchbox")).toBeVisible();
    for (const recipe of ["promotion", "diagnostic"]) {
      const {
        item: { id },
      } = await call<{ item: Task }>(
        request,
        orgSlug,
        "TASK_BOARD_ITEM_CREATE",
        {
          title: demoBundle.recipes[recipe as "promotion" | "diagnostic"].title,
        },
      );
      await call(request, orgSlug, "TASK_BOARD_ITEM_UPDATE", {
        id,
        assigneeId: "super-agent",
      });
      await expect
        .poll(
          async () =>
            (await tasks(request, orgSlug)).find((t) => t.id === id)?.status,
          { timeout: 20_000 },
        )
        .toBe("in_review");
      await call(request, orgSlug, "TASK_BOARD_PROMOTE_TO_PRODUCTION", {
        taskBoardItemId: id,
      });
    }
    await page.goto(`/api/${orgSlug}/demo/storefront`);
    await expect(page.getByRole("searchbox")).toBeVisible();
    await expect(page.locator("#countdown")).toBeVisible();
    const { item: cancelTask } = await call<{ item: Task }>(
      request,
      orgSlug,
      "TASK_BOARD_ITEM_CREATE",
      { title: demoBundle.recipes.search.title },
    );
    const running = await call<{ item: Task }>(
      request,
      orgSlug,
      "TASK_BOARD_ITEM_UPDATE",
      { id: cancelTask.id, assigneeId: "super-agent" },
    );
    const threadId = running.item.threads[0]!.threadId;
    const stopped = await request.post(
      `/api/${orgSlug}/decopilot/cancel/${threadId}`,
    );
    expect(stopped.status()).toBe(202);
    await expect
      .poll(
        async () =>
          (await tasks(request, orgSlug)).find((t) => t.id === cancelTask.id)
            ?.status,
      )
      .toBe("todo");
    await call(request, orgSlug, "TASK_BOARD_ITEM_RERUN", {
      id: cancelTask.id,
    });
    // Removing the switch must never send this org through live providers.
    await db.query(
      `UPDATE organization_settings SET flags = flags || '{"demo_mode_enabled":false}'::jsonb WHERE "organizationId" = $1`,
      [org],
    );
    const result = await request.post(
      `/api/${orgSlug}/tools/TASK_BOARD_ITEM_UPDATE`,
      { data: { id: initial[0]!.id, assigneeId: "super-agent" } },
    );
    expect(result.status()).toBe(403);
    const connection = await request.post(
      `/api/${orgSlug}/tools/COLLECTION_CONNECTIONS_CREATE`,
      {
        data: {
          data: {
            title: "No real integration",
            connection_type: "HTTP",
            connection_url: "https://example.com/mcp",
          },
        },
      },
    );
    expect(connection.status()).toBe(403);
    const sandbox = await request.get(
      `/api/${orgSlug}/sandbox/any/main/status`,
    );
    expect(sandbox.status()).toBe(403);
    const staleReset = await request.post(`/api/${orgSlug}/tools/DEMO_RESET`, {
      data: { idempotencyKey: "disabled", expectedGeneration: 1 },
    });
    expect(staleReset.ok()).toBe(false);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM demo_runs WHERE organization_id = $1",
          [org],
        )
      ).rows[0].n,
    ).toBe(5);
    await expect
      .poll(
        async () =>
          (
            await db.query(
              "SELECT count(*)::int AS n FROM demo_runs WHERE organization_id = $1 AND state = 'pending'",
              [org],
            )
          ).rows[0].n,
        { timeout: 15_000 },
      )
      .toBe(0);
  });

  test("reset fences in-flight work, removes extras, is idempotent and leaves another org untouched", async ({
    authedPage,
    playwright,
  }) => {
    const { page, orgSlug: homeSlug } = authedPage;
    const request = page.context().request;
    const { org, slug: orgSlug } = await provision(db, homeSlug);
    const other = await newApiContext(playwright);
    try {
      const outsider = await signUpViaApi(other);
      const otherTask = await call<{ item: Task }>(
        other,
        outsider.orgSlug,
        "TASK_BOARD_ITEM_CREATE",
        { title: "Other tenant stays intact" },
      );
      const foreignOrg = (
        await db.query("SELECT id FROM organization WHERE slug=$1", [
          outsider.orgSlug,
        ])
      ).rows[0].id;
      // Even a forged registration/flag cannot authorize demo writes outside the env-selected ID.
      await db.query(
        "INSERT INTO demo_organizations (organization_id,scenario) VALUES ($1,'storefront-v1')",
        [foreignOrg],
      );
      await db.query(
        `INSERT INTO organization_settings ("organizationId",flags,"createdAt","updatedAt") VALUES ($1,'{"demo_mode_enabled":true}',now()::text,now()::text) ON CONFLICT ("organizationId") DO UPDATE SET flags=coalesce(organization_settings.flags,'{}'::jsonb)||excluded.flags`,
        [foreignOrg],
      );
      const before = (
        await db.query(
          "SELECT id,title,status FROM task_board_items WHERE organization_id=$1 ORDER BY id",
          [foreignOrg],
        )
      ).rows;
      expect(
        (
          await admin.post(`/api/_admin/orgs/${foreignOrg}/demo/reset`, {
            data: { idempotencyKey: "wrong-org", expectedGeneration: 0 },
          })
        ).status(),
      ).toBe(404);
      expect(
        (await admin.get(`/api/_admin/orgs/${foreignOrg}/demo`)).status(),
      ).toBe(404);
      expect(
        (
          await other.post(
            `/api/${outsider.orgSlug}/tools/TASK_BOARD_ITEM_UPDATE`,
            { data: { id: otherTask.item.id, assigneeId: "super-agent" } },
          )
        ).status(),
      ).toBe(403);
      expect(
        (await other.get(`/api/${outsider.orgSlug}/demo/storefront`)).status(),
      ).toBe(404);
      expect(
        (await call<{ demo: unknown }>(other, outsider.orgSlug, "DEMO_STATUS"))
          .demo,
      ).toBeNull();
      expect(
        (
          await db.query(
            "SELECT id,title,status FROM task_board_items WHERE organization_id=$1 ORDER BY id",
            [foreignOrg],
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM demo_resets WHERE organization_id=$1",
            [foreignOrg],
          )
        ).rows[0].n,
      ).toBe(0);
      const orgList = await (await admin.get("/api/_admin/orgs")).json();
      expect(
        orgList.organizations
          .filter((o: { demoConfigured: boolean }) => o.demoConfigured)
          .map((o: { id: string }) => o.id),
      ).toEqual([org]);
      // Removing the forged registration restores this ordinary test tenant's original behavior.
      await db.query(
        "DELETE FROM demo_organizations WHERE organization_id=$1",
        [foreignOrg],
      );
      const old = await tasks(request, orgSlug);
      const task = old.find((t) => t.status === "todo")!;
      await call(request, orgSlug, "TASK_BOARD_ITEM_UPDATE", {
        id: task.id,
        assigneeId: "super-agent",
      });
      await call(request, orgSlug, "TASK_BOARD_ITEM_CREATE", {
        title: "Remove this extra on reset",
      });
      const reset = { idempotencyKey: "same-reset", expectedGeneration: 1 };
      const results = await Promise.all([
        resetDemo(org, reset),
        resetDemo(org, reset),
      ]);
      expect(results.map((r) => r.generation)).toEqual([2, 2]);
      const fresh = await tasks(request, orgSlug);
      expect(fresh).toHaveLength(10);
      expect(fresh.every((t) => !old.some((o) => o.id === t.id))).toBe(true);
      expect(fresh.some((t) => t.status === "in_progress")).toBe(false);
      const stale = await request.post(
        `/api/${orgSlug}/tools/TASK_BOARD_ITEM_UPDATE`,
        { data: { id: task.id, title: "Stale page write" } },
      );
      expect(stale.status()).toBe(403);
      await expect
        .poll(
          async () =>
            (
              await db.query(
                "SELECT count(*)::int AS n FROM demo_runs WHERE organization_id = $1",
                [org],
              )
            ).rows[0].n,
        )
        .toBe(0);
      expect((await tasks(other, outsider.orgSlug)).map((t) => t.id)).toContain(
        otherTask.item.id,
      );
      const denied = await other.post(`/api/_admin/orgs/${org}/demo/reset`, {
        data: { idempotencyKey: "intruder", expectedGeneration: 2 },
      });
      expect(denied.status()).toBe(403);
      // Even an organization owner cannot reset through the deployment-admin surface.
      const ownerReset = await request.post(
        `/api/_admin/orgs/${org}/demo/reset`,
        { data: reset },
      );
      expect(ownerReset.status()).toBe(403);
      const staleGeneration = await admin.post(
        `/api/_admin/orgs/${org}/demo/reset`,
        { data: { idempotencyKey: "stale", expectedGeneration: 1 } },
      );
      expect(staleGeneration.status()).toBe(409);
      const legacy = await request.post(
        `/api/${orgSlug}/tools/DEMO_CREATE_TASK`,
        { data: { recipe: "search", expectedGeneration: 2 } },
      );
      expect(legacy.ok()).toBe(false);
      const adminContext = await page
        .context()
        .browser()!
        .newContext({ storageState: await admin.storageState() });
      const adminPage = await adminContext.newPage();
      await adminPage.goto(
        new URL("/_admin/orgs", (await request.get("/api/config")).url()).href,
      );
      await adminPage
        .getByPlaceholder("Search organizations by name or slug...")
        .fill(orgSlug);
      await expect(
        adminPage.getByRole("button", { name: "Demonstration", exact: true }),
      ).toHaveCount(1);
      await adminPage
        .getByRole("button", { name: "Demonstration", exact: true })
        .click();
      await adminPage
        .getByRole("button", { name: "Restore scenario", exact: true })
        .click();
      await expect(
        adminPage.getByText("Demonstration restored and ready", {
          exact: true,
        }),
      ).toBeVisible();
      await adminContext.close();
    } finally {
      await other.dispose();
    }
  });
});
