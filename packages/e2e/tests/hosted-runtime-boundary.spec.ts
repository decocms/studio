import { retry } from "@decocms/shared/std";
import type { APIRequestContext } from "@playwright/test";
import { createServer } from "node:http";
import { signUpViaApi } from "../fixtures/auth-api";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";
import { expect, getE2EAppOrigin, newApiContext, test } from "../fixtures/test";

const NO_SMART_MODEL_ERROR =
  'No model available for tier "smart". Connect a provider or configure the tier in organization settings.';

const LEGACY_REQUEST_FIELDS = [
  { label: "agent", fields: { agent: { id: "retired-agent" } } },
  { label: "harness", fields: { harnessId: "decopilot" } },
  {
    label: "managed-sandbox",
    fields: { sandboxProviderKind: "agent-sandbox" },
  },
  {
    label: "desktop-sandbox",
    fields: { sandboxProviderKind: "user-desktop" },
  },
  { label: "cluster-sandbox", fields: { sandboxProviderKind: "cluster" } },
  { label: "thread-id", fields: { thread_id: "retired-thread" } },
  {
    label: "memory-thread-id",
    fields: { memory: { windowSize: 50, thread_id: "retired-thread" } },
  },
  { label: "stream", fields: { stream: true } },
] as const;

const PERSISTED_NON_HOSTED_ROWS = [
  {
    harnessId: "claude-code",
    sandboxProviderKind: "user-desktop",
    error: "This coding-agent chat can only run in the Studio desktop app",
  },
  {
    harnessId: "codex",
    sandboxProviderKind: null,
    error: "This coding-agent chat can only run in the Studio desktop app",
  },
  {
    harnessId: "opencode",
    sandboxProviderKind: "user-desktop",
    error: "This coding-agent chat can only run in the Studio desktop app",
  },
  {
    harnessId: "future",
    sandboxProviderKind: null,
    error: "This coding-agent chat can only run in the Studio desktop app",
  },
  {
    harnessId: "decopilot",
    sandboxProviderKind: "user-desktop",
    error: "This chat is pinned to an unsupported desktop runtime",
  },
  {
    harnessId: "decopilot",
    sandboxProviderKind: null,
    error: "This chat has an incomplete hosted runtime pin",
  },
] as const;

type DevDb = Awaited<ReturnType<typeof connectDevDb>>;

async function createAgent(
  api: APIRequestContext,
  orgSlug: string,
  title: string,
): Promise<string> {
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title,
        connections: [],
        status: "active",
        pinned: false,
      },
    },
  );
  return agent.item.id;
}

async function createThread(
  api: APIRequestContext,
  orgSlug: string,
  virtualMcpId: string,
): Promise<string> {
  const thread = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    { data: { virtual_mcp_id: virtualMcpId } },
  );
  return thread.item.id;
}

async function organizationIdForSlug(
  db: DevDb,
  orgSlug: string,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM organization WHERE slug = $1`,
    [orgSlug],
  );
  const organizationId = result.rows[0]?.id;
  if (!organizationId) {
    throw new Error(`Organization not found for slug ${orgSlug}`);
  }
  return organizationId;
}

async function readThreadAuthorityState(
  db: DevDb,
  args: { threadId: string; organizationId: string; userId: string },
) {
  const result = await db.query<{
    title: string;
    virtual_mcp_id: string;
    harness_id: string | null;
    sandbox_provider_kind: string | null;
    status: string;
    part_count: number;
  }>(
    `SELECT t.title,
            t.virtual_mcp_id,
            t.harness_id,
            t.sandbox_provider_kind,
            t.status,
            (SELECT COUNT(*)::int
               FROM thread_message_parts p
              WHERE p.org_id = t.organization_id
                AND p.thread_id = t.id) AS part_count
       FROM threads t
      WHERE t.id = $1
        AND t.organization_id = $2
        AND t.created_by = $3`,
    [args.threadId, args.organizationId, args.userId],
  );
  const state = result.rows[0];
  if (!state) {
    throw new Error(`Thread not found in expected tenant: ${args.threadId}`);
  }
  return state;
}

async function inviteAndAcceptMember(
  ownerApi: APIRequestContext,
  memberApi: APIRequestContext,
  organizationId: string,
  memberEmail: string,
): Promise<void> {
  const invite = await ownerApi.post("/api/auth/organization/invite-member", {
    data: {
      organizationId,
      email: memberEmail,
      role: "user",
    },
    headers: { Origin: getE2EAppOrigin() },
  });
  expect(
    invite.ok(),
    `invite failed: ${await invite.text().catch(() => "")}`,
  ).toBe(true);
  const body = (await invite.json()) as {
    id?: string;
    invitation?: { id?: string };
  };
  const invitationId = body.id ?? body.invitation?.id;
  expect(invitationId).toBeTruthy();

  const accept = await memberApi.post(
    "/api/auth/organization/accept-invitation",
    { data: { invitationId } },
  );
  expect(
    accept.ok(),
    `accept failed: ${await accept.text().catch(() => "")}`,
  ).toBe(true);
}

async function postMessage(
  api: APIRequestContext,
  args: {
    orgSlug: string;
    threadId: string;
    messageId: string;
  },
) {
  return api.post(
    `/api/${args.orgSlug}/decopilot/threads/${args.threadId}/messages`,
    {
      data: {
        messages: [
          {
            id: args.messageId,
            role: "user",
            parts: [{ type: "text", text: "Do not dispatch this" }],
          },
        ],
      },
      headers: { "content-type": "application/json" },
    },
  );
}

async function expectNoQueuedRun(
  api: APIRequestContext,
  orgSlug: string,
  threadId: string,
): Promise<void> {
  const queue = await api.get(`/api/${orgSlug}/decopilot/queue/${threadId}`);
  expect(queue.status()).toBe(200);
  expect(await queue.json()).toEqual({ items: [] });
}

test.describe("hosted runtime boundary", () => {
  test.describe.configure({ mode: "serial" });

  test("rejects every retired request field before pinning or persisting a message", async ({
    authedPage,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      const agent = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_VIRTUAL_MCP_CREATE",
        {
          data: {
            title: "hosted runtime boundary",
            connections: [],
            status: "active",
            pinned: false,
          },
        },
      );
      const thread = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_THREADS_CREATE",
        { data: { virtual_mcp_id: agent.item.id } },
      );

      for (const { label, fields } of LEGACY_REQUEST_FIELDS) {
        const response = await api.post(
          `/api/${orgSlug}/decopilot/threads/${thread.item.id}/messages`,
          {
            data: {
              messages: [
                {
                  id: `msg-legacy-${label}`,
                  role: "user",
                  parts: [{ type: "text", text: "Do not dispatch this" }],
                },
              ],
              ...fields,
            },
            headers: { "content-type": "application/json" },
          },
        );
        expect(response.status()).toBe(400);
      }

      const row = await db.query(
        `SELECT harness_id
           FROM threads
          WHERE id = $1 AND created_by = $2`,
        [thread.item.id, user.userId],
      );
      expect(row.rows).toEqual([{ harness_id: null }]);

      const parts = await db.query(
        `SELECT COUNT(*)::int AS count
           FROM thread_message_parts
          WHERE thread_id = $1`,
        [thread.item.id],
      );
      expect(parts.rows[0]?.count).toBe(0);
      await expectNoQueuedRun(api, orgSlug, thread.item.id);
    } finally {
      await db.end();
    }
  });

  test("rejects sandbox provider selectors at both REST tool boundaries", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const agentId = await createAgent(
      api,
      orgSlug,
      "strict sandbox tool boundary",
    );

    for (const sandboxProviderKind of [
      "agent-sandbox",
      "user-desktop",
      "cluster",
    ]) {
      const start = await api.post(`/api/${orgSlug}/tools/SANDBOX_START`, {
        data: { virtualMcpId: agentId, sandboxProviderKind },
      });
      expect(start.status()).toBe(400);

      const remove = await api.post(`/api/${orgSlug}/tools/SANDBOX_DELETE`, {
        data: {
          virtualMcpId: agentId,
          branch: "strict-sandbox-boundary",
          sandboxProviderKind,
        },
      });
      expect(remove.status()).toBe(400);
    }
  });

  test("rejects a foreign-org canonical agent before any message or run is persisted", async ({
    authedPage,
    playwright,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const api = page.context().request;
    const foreignApi = await newApiContext(playwright);
    const db = await connectDevDb();
    try {
      const organizationId = await organizationIdForSlug(db, orgSlug);
      const threadAgentId = await createAgent(
        api,
        orgSlug,
        "foreign authority canonical agent",
      );
      const foreignUser = await signUpViaApi(foreignApi);
      const foreignAgentId = await createAgent(
        foreignApi,
        foreignUser.orgSlug,
        "foreign authority agent",
      );

      // Defense in depth: even if a malformed legacy row or privileged DB
      // writer points an owned thread at another tenant's agent, the hosted
      // endpoint must validate the canonical agent before its first write.
      const corruptThreadId = await createThread(api, orgSlug, threadAgentId);
      const corruptUpdate = await db.query(
        `UPDATE threads
            SET virtual_mcp_id = $1
          WHERE id = $2
            AND organization_id = $3
            AND created_by = $4`,
        [foreignAgentId, corruptThreadId, organizationId, user.userId],
      );
      expect(corruptUpdate.rowCount).toBe(1);

      const corruptScope = {
        threadId: corruptThreadId,
        organizationId,
        userId: user.userId,
      };
      const corruptBefore = await readThreadAuthorityState(db, corruptScope);
      const corruptResponse = await postMessage(api, {
        orgSlug,
        threadId: corruptThreadId,
        messageId: "msg-foreign-agent-canonical-corruption",
      });

      expect(corruptResponse.status()).toBe(409);
      expect(await readThreadAuthorityState(db, corruptScope)).toEqual(
        corruptBefore,
      );
      expect(corruptBefore).toMatchObject({
        virtual_mcp_id: foreignAgentId,
        harness_id: null,
        sandbox_provider_kind: null,
        part_count: 0,
      });
      await expectNoQueuedRun(api, orgSlug, corruptThreadId);
    } finally {
      await Promise.all([db.end(), foreignApi.dispose()]);
    }
  });

  test("keeps an organization teammate from mutating another owner's thread", async ({
    authedPage,
    browser,
    playwright,
  }) => {
    test.setTimeout(120_000);
    const { page, orgSlug, user } = authedPage;
    const ownerApi = page.context().request;
    const memberApi = await newApiContext(playwright);
    const db = await connectDevDb();
    const previewText = "Viewer-safe teammate sandbox preview";
    const previewLog = "Viewer-safe teammate dev log";
    const previewRequests: Array<{
      method: string;
      path: string;
      accept: string | undefined;
    }> = [];
    const previewServer = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      previewRequests.push({
        method: request.method ?? "UNKNOWN",
        path,
        accept: request.headers.accept,
      });

      if (path === "/_sandbox/events") {
        response.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream",
        });
        response.flushHeaders();
        response.write(
          [
            "event: lifecycle",
            `data: ${JSON.stringify({
              state: { phase: "running", port: 5173, htmlSupport: true },
            })}`,
            "",
            "event: status",
            `data: ${JSON.stringify({ state: "running" })}`,
            "",
            "event: scripts",
            `data: ${JSON.stringify({ scripts: ["dev"] })}`,
            "",
            "event: tasks",
            `data: ${JSON.stringify({
              active: [{ id: "dev", command: "dev", logName: "dev" }],
            })}`,
            "",
            "event: log",
            `data: ${JSON.stringify({ source: "dev", data: `${previewLog}\n` })}`,
            "",
            "",
          ].join("\n"),
        );
        return;
      }

      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html><body><main>${previewText}</main></body></html>`,
      );
    });
    try {
      await new Promise<void>((resolve) =>
        previewServer.listen(0, "127.0.0.1", resolve),
      );
      const previewAddress = previewServer.address();
      if (!previewAddress || typeof previewAddress === "string") {
        throw new Error("Teammate preview server did not bind to a TCP port");
      }
      const previewUrl = `http://127.0.0.1:${previewAddress.port}/`;

      const organizationId = await organizationIdForSlug(db, orgSlug);
      const agentId = await createAgent(
        ownerApi,
        orgSlug,
        "teammate boundary agent",
      );
      const githubConnection = await createHttpConnection(ownerApi, orgSlug, {
        title: "teammate boundary github",
        url: "http://127.0.0.1:1/unused",
      });
      await callSelfMcpTool(
        ownerApi,
        orgSlug,
        "COLLECTION_VIRTUAL_MCP_UPDATE",
        {
          id: agentId,
          data: {
            connections: [{ connection_id: githubConnection.id }],
            metadata: {
              githubRepo: {
                url: "https://github.com/example/teammate-boundary",
                owner: "example",
                name: "teammate-boundary",
                connectionId: githubConnection.id,
              },
            },
          },
        },
      );
      const threadId = await createThread(ownerApi, orgSlug, agentId);
      const sandboxBranch = `thread:${threadId}`;
      await callSelfMcpTool(ownerApi, orgSlug, "COLLECTION_THREADS_UPDATE", {
        id: threadId,
        data: {
          branch: sandboxBranch,
          metadata: {
            sandboxMap: {
              [user.userId]: {
                [sandboxBranch]: {
                  "agent-sandbox": {
                    sandboxHandle: `e2e-${threadId}`,
                    previewUrl,
                    sandboxProviderKind: "agent-sandbox",
                    createdAt: Date.now(),
                  },
                },
              },
            },
          },
        },
      });
      const scope = { threadId, organizationId, userId: user.userId };
      const before = await readThreadAuthorityState(db, scope);

      const member = await signUpViaApi(memberApi);
      await inviteAndAcceptMember(
        ownerApi,
        memberApi,
        organizationId,
        member.email,
      );

      const sandboxBase = `/api/${orgSlug}/sandbox/${agentId}/${encodeURIComponent(
        sandboxBranch,
      )}`;
      const ownerOnlySandboxRequests = [
        { method: "POST", path: "/write" },
        { method: "POST", path: "/unlink" },
        { method: "POST", path: "/mkdir" },
        { method: "POST", path: "/rename" },
        { method: "POST", path: "/read" },
        { method: "POST", path: "/glob" },
        { method: "POST", path: "/grep" },
        { method: "POST", path: "/exec/e2e-script" },
        { method: "POST", path: "/exec/e2e-script/kill" },
        { method: "GET", path: "/config" },
        { method: "PUT", path: "/config" },
        { method: "POST", path: "/setup/start" },
        { method: "POST", path: "/git/publish" },
        { method: "POST", path: "/git/discard" },
        { method: "POST", path: "/git/rebase" },
        { method: "POST", path: "/git/suggest-commit" },
        { method: "POST", path: "/git/judge-review" },
        { method: "POST", path: "/preview-invoke" },
      ] as const;

      for (const request of ownerOnlySandboxRequests) {
        const response = await memberApi.fetch(
          `${sandboxBase}${request.path}`,
          {
            method: request.method,
            ...(request.method === "GET" ? {} : { data: {} }),
          },
        );
        expect(
          response.status(),
          `${request.method} ${request.path} must stay owner-only`,
        ).toBe(403);
        expect(await response.json()).toEqual({
          error: "Only the thread owner can change its sandbox",
        });
      }

      // Teammates may still inspect viewer-safe lifecycle and git state. This
      // suite has no hosted runner, so a request that passed the owner-only gate
      // reaches the normal runner-unavailable response instead of the mutation
      // 403.
      for (const request of [
        { method: "GET", path: "/git/status" },
        { method: "POST", path: "/git/status" },
        { method: "POST", path: "/git/diff" },
      ] as const) {
        const response = await memberApi.fetch(
          `${sandboxBase}${request.path}`,
          {
            method: request.method,
            ...(request.method === "GET" ? {} : { data: {} }),
          },
        );
        expect(
          response.status(),
          `${request.method} ${request.path} must remain viewer-safe`,
        ).toBe(503);
        expect(await response.json()).toEqual({
          error: "No sandbox runner configured",
        });
      }

      const eventsResponse = await memberApi.get(`${sandboxBase}/events`, {
        headers: { Accept: "text/event-stream" },
      });
      expect(eventsResponse.status()).toBe(200);
      expect(eventsResponse.headers()["content-type"]).toContain(
        "text/event-stream",
      );
      expect(await eventsResponse.text()).toContain(
        "No sandbox runner configured on this studio instance.",
      );

      const messageResponse = await postMessage(memberApi, {
        orgSlug,
        threadId,
        messageId: "msg-teammate-owner-boundary",
      });
      expect(messageResponse.status()).toBe(403);

      await expect(
        callSelfMcpTool(memberApi, orgSlug, "COLLECTION_THREADS_UPDATE", {
          id: threadId,
          data: { title: "teammate changed this" },
        }),
      ).rejects.toThrow(/chat owner/i);
      await expect(
        callSelfMcpTool(memberApi, orgSlug, "COLLECTION_THREADS_DELETE", {
          id: threadId,
        }),
      ).rejects.toThrow(/chat owner/i);

      expect(await readThreadAuthorityState(db, scope)).toEqual(before);
      await expectNoQueuedRun(ownerApi, orgSlug, threadId);

      const memberContext = await browser.newContext({
        storageState: await memberApi.storageState(),
      });
      try {
        const memberPage = await memberContext.newPage();
        await memberPage.addInitScript(
          (key) => localStorage.setItem(key, JSON.stringify({ visible: true })),
          `preview-terminal-visible:${agentId}`,
        );

        const sandboxEventsUrl = `${getE2EAppOrigin()}${sandboxBase}/events`;
        let sandboxEventsResponses = 0;
        await memberPage.route(sandboxEventsUrl, async (route) => {
          sandboxEventsResponses++;
          if (sandboxEventsResponses > 1) {
            await route.fulfill({ status: 204, body: "" });
            return;
          }
          await route.fulfill({
            status: 200,
            headers: {
              "Cache-Control": "no-cache",
              "Content-Type": "text/event-stream",
            },
            body: 'event: phase\ndata: {"kind":"ready"}\n\n',
          });
        });

        const viewerSafeSandboxRequests: string[] = [];
        const forbiddenWorkspaceRequests: string[] = [];
        memberPage.on("request", (request) => {
          const method = request.method();
          const url = request.url();

          const viewerSafeSandboxRequest =
            (method === "GET" &&
              (url.includes(`${sandboxBase}/events`) ||
                url.includes(`${sandboxBase}/git/status`))) ||
            (method === "POST" &&
              (url.includes(`${sandboxBase}/git/status`) ||
                url.includes(`${sandboxBase}/git/diff`)));
          if (viewerSafeSandboxRequest) {
            viewerSafeSandboxRequests.push(`${method} ${url}`);
            return;
          }

          if (url.includes(`/api/${orgSlug}/sandbox/`)) {
            forbiddenWorkspaceRequests.push(`${method} ${url}`);
            return;
          }
          if (
            method === "GET" &&
            url.includes(`/api/${orgSlug}/decopilot/queue/${threadId}`)
          ) {
            forbiddenWorkspaceRequests.push(`${method} ${url}`);
          }
          if (method === "GET") return;

          if (
            url.includes("/tools/SANDBOX_") ||
            url.includes("/tools/GIT_") ||
            url.includes("/tools/FS_") ||
            url.includes("/tools/COLLECTION_THREADS_UPDATE") ||
            url.includes("/tools/COLLECTION_THREADS_DELETE") ||
            url.includes(`/decopilot/threads/${threadId}/messages`) ||
            url.includes(`/decopilot/cancel/${threadId}`) ||
            url.includes(`/decopilot/flip/${threadId}`)
          ) {
            forbiddenWorkspaceRequests.push(`${method} ${url}`);
          }
        });

        await memberPage.goto(
          `/${orgSlug}/${threadId}?virtualmcpid=${agentId}&sidepanel=chat&main=preview`,
        );

        await expect(
          memberPage.getByRole("button", { name: "Preview", exact: true }),
        ).toBeVisible({ timeout: 60_000 });
        await expect(
          memberPage.getByRole("button", { name: "Code", exact: true }),
        ).toHaveCount(0);
        await expect(
          memberPage.getByRole("button", { name: "Content", exact: true }),
        ).toHaveCount(0);
        await expect(
          memberPage.getByRole("button", { name: "Publish", exact: true }),
        ).toHaveCount(0);
        await expect(
          memberPage.getByRole("button", { name: /^sandbox$/i }),
        ).toBeVisible();
        await expect(
          memberPage
            .frameLocator('iframe[title="Dev Server Preview"]')
            .getByText(previewText, { exact: true }),
        ).toBeVisible({ timeout: 15_000 });
        const devLogTab = memberPage.getByRole("button", {
          name: "dev",
          exact: true,
        });
        await expect(devLogTab).toBeVisible();
        await devLogTab.click();
        await expect(memberPage.locator(".xterm-rows")).toContainText(
          previewLog,
          { timeout: 15_000 },
        );
        for (const action of ["Start", "Stop", "Restart", "Resume", "Retry"]) {
          await expect(
            memberPage.getByRole("button", { name: action, exact: true }),
          ).toHaveCount(0);
        }
        await memberPage.waitForTimeout(250);
        expect(
          viewerSafeSandboxRequests.some((request) =>
            request.includes(`${sandboxBase}/events`),
          ),
        ).toBe(true);
        expect(
          previewRequests.some(
            (request) =>
              request.method === "GET" && request.path === "/_sandbox/events",
          ),
        ).toBe(true);
        expect(
          previewRequests.some(
            (request) =>
              request.method === "GET" &&
              request.path === "/" &&
              request.accept?.includes("text/html"),
          ),
        ).toBe(true);
        expect(forbiddenWorkspaceRequests).toEqual([]);
        expect(await readThreadAuthorityState(db, scope)).toEqual(before);
        await expectNoQueuedRun(ownerApi, orgSlug, threadId);
      } finally {
        await memberContext.close();
      }
    } finally {
      previewServer.closeAllConnections();
      await Promise.all([
        db.end(),
        memberApi.dispose(),
        previewServer.listening
          ? new Promise<void>((resolve, reject) =>
              previewServer.close((error) =>
                error ? reject(error) : resolve(),
              ),
            )
          : Promise.resolve(),
      ]);
    }
  });

  test("rejects persisted non-hosted and incomplete runtime rows without side effects", async ({
    authedPage,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      const agent = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_VIRTUAL_MCP_CREATE",
        {
          data: {
            title: "persisted native runtime boundary",
            connections: [],
            status: "active",
            pinned: false,
          },
        },
      );

      for (const {
        harnessId,
        sandboxProviderKind,
        error,
      } of PERSISTED_NON_HOSTED_ROWS) {
        const thread = await callSelfMcpTool<{ item: { id: string } }>(
          api,
          orgSlug,
          "COLLECTION_THREADS_CREATE",
          { data: { virtual_mcp_id: agent.item.id } },
        );
        const update = await db.query(
          `UPDATE threads
              SET harness_id = $1, sandbox_provider_kind = $2
            WHERE id = $3 AND created_by = $4`,
          [harnessId, sandboxProviderKind, thread.item.id, user.userId],
        );
        expect(update.rowCount).toBe(1);

        const response = await api.post(
          `/api/${orgSlug}/decopilot/threads/${thread.item.id}/messages`,
          {
            data: {
              messages: [
                {
                  id: `msg-persisted-${harnessId}`,
                  role: "user",
                  parts: [{ type: "text", text: "Do not dispatch this" }],
                },
              ],
            },
            headers: { "content-type": "application/json" },
          },
        );
        expect(response.status()).toBe(409);
        expect(await response.json()).toEqual({ error });

        const row = await db.query(
          `SELECT harness_id, sandbox_provider_kind
             FROM threads
            WHERE id = $1 AND created_by = $2`,
          [thread.item.id, user.userId],
        );
        expect(row.rows).toEqual([
          {
            harness_id: harnessId,
            sandbox_provider_kind: sandboxProviderKind,
          },
        ]);

        const parts = await db.query(
          `SELECT COUNT(*)::int AS count
             FROM thread_message_parts
            WHERE thread_id = $1`,
          [thread.item.id],
        );
        expect(parts.rows[0]?.count).toBe(0);
      }
    } finally {
      await db.end();
    }
  });

  test("accepts a selectorless request without treating a coding-agent key as hosted", async ({
    authedPage,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      const organization = await db.query<{ id: string }>(
        "SELECT id FROM organization WHERE slug = $1",
        [orgSlug],
      );
      const organizationId = organization.rows[0]?.id;
      expect(organizationId).toBeTruthy();

      await db.query(
        `INSERT INTO ai_provider_keys (
           id, organization_id, provider_id, label,
           encrypted_api_key, created_by, created_at
         ) VALUES ($1, $2, 'codex', 'retired native sentinel',
                   'not-a-hosted-credential', $3, NOW())`,
        [`aik_legacy_${user.userId}`, organizationId, user.userId],
      );

      const agent = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_VIRTUAL_MCP_CREATE",
        {
          data: {
            title: "legacy provider boundary",
            connections: [],
            status: "active",
            pinned: false,
          },
        },
      );
      const thread = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_THREADS_CREATE",
        { data: { virtual_mcp_id: agent.item.id } },
      );

      const response = await api.post(
        `/api/${orgSlug}/decopilot/threads/${thread.item.id}/messages`,
        {
          data: {
            messages: [
              {
                id: "msg-legacy-provider",
                role: "user",
                parts: [{ type: "text", text: "Do not dispatch this" }],
              },
            ],
          },
          headers: { "content-type": "application/json" },
        },
      );

      expect(response.status()).toBe(400);
      expect(await response.json()).toEqual({ error: NO_SMART_MODEL_ERROR });

      const row = await db.query(
        `SELECT harness_id,
                (SELECT COUNT(*)::int
                   FROM thread_message_parts
                  WHERE thread_id = threads.id) AS part_count
           FROM threads
          WHERE id = $1 AND created_by = $2`,
        [thread.item.id, user.userId],
      );
      expect(row.rows).toEqual([{ harness_id: null, part_count: 0 }]);
    } finally {
      await db.end();
    }
  });

  test("accepts a selectorless request through the durable enqueue boundary", async ({
    authedPage,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      const organizationId = await organizationIdForSlug(db, orgSlug);
      const key = await callSelfMcpTool<{ id: string }>(
        api,
        orgSlug,
        "AI_PROVIDER_KEY_CREATE",
        {
          providerId: "anthropic",
          label: "selectorless-enqueue-e2e",
          apiKey: "sk-ant-e2e-fake-key-do-not-use",
        },
      );
      await callSelfMcpTool(api, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
        organizationId,
        simple_mode: {
          tiers: {
            fast: null,
            smart: { keyId: key.id, modelId: "claude-sonnet-4-6" },
            thinking: null,
            image: null,
            web_search: null,
            deep_research: null,
          },
        },
      });

      const agentId = await createAgent(
        api,
        orgSlug,
        "selectorless durable enqueue",
      );
      const threadId = await createThread(api, orgSlug, agentId);
      const response = await postMessage(api, {
        orgSlug,
        threadId,
        messageId: "msg-selectorless-durable-enqueue",
      });

      expect(response.status()).toBe(202);
      expect(await response.json()).toEqual({ taskId: threadId });
      await expect(async () => {
        const state = await readThreadAuthorityState(db, {
          threadId,
          organizationId,
          userId: user.userId,
        });
        expect(state).toMatchObject({
          virtual_mcp_id: agentId,
          harness_id: "decopilot",
          sandbox_provider_kind: "agent-sandbox",
        });
        expect(state.part_count).toBeGreaterThanOrEqual(1);
      }).toPass({ timeout: 10_000, intervals: [100, 250, 500] });

      // The fake credential is sufficient to prove request validation and
      // durable enqueue. Stop the detached run before it can wait on provider
      // retries; model execution itself is covered by the live-key suite.
      const cancel = await api.post(
        `/api/${orgSlug}/decopilot/cancel/${threadId}`,
      );
      expect(cancel.status()).toBe(202);
    } finally {
      await db.end();
    }
  });

  test("keeps a native runtime pin that races the first hosted message", async ({
    authedPage,
  }) => {
    test.setTimeout(60_000);
    const { page, orgSlug, user } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    const locker = await connectDevDb();
    let transactionOpen = false;
    try {
      const organization = await db.query<{ id: string }>(
        "SELECT id FROM organization WHERE slug = $1",
        [orgSlug],
      );
      const organizationId = organization.rows[0]?.id;
      expect(organizationId).toBeTruthy();

      const key = await callSelfMcpTool<{ id: string }>(
        api,
        orgSlug,
        "AI_PROVIDER_KEY_CREATE",
        {
          providerId: "anthropic",
          label: "hosted-runtime-race-e2e",
          apiKey: "sk-ant-e2e-fake-key-do-not-use",
        },
      );
      await callSelfMcpTool(api, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
        organizationId,
        simple_mode: {
          tiers: {
            fast: null,
            smart: { keyId: key.id, modelId: "claude-sonnet-4-6" },
            thinking: null,
            image: null,
            web_search: null,
            deep_research: null,
          },
        },
      });

      const agent = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_VIRTUAL_MCP_CREATE",
        {
          data: {
            title: "runtime pin race",
            connections: [],
            status: "active",
            pinned: false,
          },
        },
      );
      const thread = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_THREADS_CREATE",
        { data: { virtual_mcp_id: agent.item.id } },
      );

      await locker.query("BEGIN");
      transactionOpen = true;
      const nativePin = await locker.query(
        `UPDATE threads
            SET harness_id = 'codex', sandbox_provider_kind = 'user-desktop'
          WHERE id = $1 AND created_by = $2`,
        [thread.item.id, user.userId],
      );
      expect(nativePin.rowCount).toBe(1);

      const responsePromise = api.post(
        `/api/${orgSlug}/decopilot/threads/${thread.item.id}/messages`,
        {
          data: {
            messages: [
              {
                id: "msg-runtime-pin-race",
                role: "user",
                parts: [{ type: "text", text: "Do not win this race" }],
              },
            ],
          },
          headers: { "content-type": "application/json" },
          timeout: 30_000,
        },
      );

      await retry(
        async () => {
          const waiting = await db.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count
               FROM pg_stat_activity
              WHERE datname = current_database()
                AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock'
                AND query ILIKE '%update%threads%'`,
          );
          if ((waiting.rows[0]?.count ?? 0) === 0) {
            throw new Error(
              "hosted runtime claim has not reached the row lock",
            );
          }
        },
        {
          maxAttempts: 40,
          minTimeout: 50,
          maxTimeout: 100,
          jitter: 0,
        },
      );

      await locker.query("COMMIT");
      transactionOpen = false;

      const response = await responsePromise;
      expect(response.status()).toBe(409);
      expect(await response.json()).toEqual({
        error: "This coding-agent chat can only run in the Studio desktop app",
      });

      const row = await db.query(
        `SELECT harness_id, sandbox_provider_kind,
                (SELECT COUNT(*)::int
                   FROM thread_message_parts
                  WHERE thread_id = threads.id) AS part_count
           FROM threads
          WHERE id = $1 AND created_by = $2`,
        [thread.item.id, user.userId],
      );
      expect(row.rows).toEqual([
        {
          harness_id: "codex",
          sandbox_provider_kind: "user-desktop",
          part_count: 0,
        },
      ]);
    } finally {
      if (transactionOpen) await locker.query("ROLLBACK");
      await Promise.all([db.end(), locker.end()]);
    }
  });

  test("blocks every hosted control-plane mutation for a native chat", async ({
    authedPage,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      const agent = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_VIRTUAL_MCP_CREATE",
        {
          data: {
            title: "native control-plane boundary",
            connections: [],
            status: "active",
            pinned: false,
          },
        },
      );
      const thread = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_THREADS_CREATE",
        { data: { virtual_mcp_id: agent.item.id } },
      );

      for (const request of [
        {
          path: `/api/${orgSlug}/decopilot/cancel/${thread.item.id}`,
        },
        {
          path: `/api/${orgSlug}/decopilot/flip/${thread.item.id}`,
          data: { toolCallId: "tool-1" },
        },
        {
          path: `/api/${orgSlug}/decopilot/queue/${thread.item.id}/cancel/fake-workflow`,
        },
      ]) {
        const response = await api.post(request.path, {
          ...(request.data ? { data: request.data } : {}),
        });
        expect(response.status()).toBe(409);
        expect(await response.text()).toBe(
          "This chat has not started a hosted run",
        );
      }

      const pinned = await db.query<{ organization_id: string }>(
        `UPDATE threads
            SET harness_id = 'codex',
                sandbox_provider_kind = 'user-desktop',
                status = 'in_progress',
                cancel_requested_at = NULL
          WHERE id = $1 AND created_by = $2
      RETURNING organization_id`,
        [thread.item.id, user.userId],
      );
      const organizationId = pinned.rows[0]?.organization_id;
      expect(organizationId).toBeTruthy();

      await db.query(
        `INSERT INTO thread_message_parts
          (id, org_id, thread_id, run_id, message_id, role, kind, seq,
           payload, payload_ref, metadata, created_at)
         VALUES ($1, $2, $3, $3, 'native-message', 'user', 'text', 0,
                 $4, NULL, NULL, $5)`,
        [
          `${thread.item.id}:native-message:0`,
          organizationId,
          thread.item.id,
          JSON.stringify({ type: "text", text: "keep me" }),
          new Date().toISOString(),
        ],
      );

      const requests = [
        {
          method: "POST",
          path: `/api/${orgSlug}/decopilot/cancel/${thread.item.id}`,
        },
        {
          method: "POST",
          path: `/api/${orgSlug}/decopilot/flip/${thread.item.id}`,
          data: { toolCallId: "tool-1" },
        },
        {
          method: "GET",
          path: `/api/${orgSlug}/decopilot/queue/${thread.item.id}`,
        },
        {
          method: "POST",
          path: `/api/${orgSlug}/decopilot/queue/${thread.item.id}/cancel/fake-workflow`,
        },
        {
          method: "GET",
          path: `/api/${orgSlug}/decopilot/threads/${thread.item.id}/stream`,
        },
        {
          method: "GET",
          path: `/api/${orgSlug}/decopilot/threads/${thread.item.id}/jobs/bgtool:${thread.item.id}:job/stream`,
        },
      ] as const;
      for (const request of requests) {
        const response = await api.fetch(request.path, {
          method: request.method,
          ...("data" in request ? { data: request.data } : {}),
          timeout: 5_000,
        });
        expect(response.status()).toBe(409);
      }

      const unchanged = await db.query(
        `SELECT status, cancel_requested_at,
                (SELECT COUNT(*)::int
                   FROM thread_message_parts
                  WHERE thread_id = threads.id) AS part_count
           FROM threads
          WHERE id = $1 AND created_by = $2`,
        [thread.item.id, user.userId],
      );
      expect(unchanged.rows).toEqual([
        {
          status: "in_progress",
          cancel_requested_at: null,
          part_count: 1,
        },
      ]);
    } finally {
      await db.end();
    }
  });

  test("web replaces a native thread workspace before sandbox-backed panels mount", async ({
    authedPage,
  }) => {
    const { page, orgSlug, user } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();
    try {
      const connection = await createHttpConnection(api, orgSlug, {
        title: "native-boundary-github-placeholder",
        url: "http://127.0.0.1:1/unused",
      });
      const agent = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_VIRTUAL_MCP_CREATE",
        {
          data: {
            title: "native-only workspace boundary",
            connections: [{ connection_id: connection.id }],
            status: "active",
            pinned: false,
            metadata: {
              githubRepo: {
                url: "https://github.com/example/native-boundary",
                owner: "example",
                name: "native-boundary",
                connectionId: connection.id,
              },
            },
          },
        },
      );
      const thread = await callSelfMcpTool<{ item: { id: string } }>(
        api,
        orgSlug,
        "COLLECTION_THREADS_CREATE",
        { data: { virtual_mcp_id: agent.item.id } },
      );
      const update = await db.query(
        `UPDATE threads
            SET harness_id = 'codex', sandbox_provider_kind = 'user-desktop'
          WHERE id = $1 AND created_by = $2`,
        [thread.item.id, user.userId],
      );
      expect(update.rowCount).toBe(1);

      const beforeNavigation = await db.query(
        `SELECT status, branch, metadata
           FROM threads
          WHERE id = $1 AND created_by = $2`,
        [thread.item.id, user.userId],
      );

      await page.addInitScript(
        (key) => localStorage.setItem(key, JSON.stringify({ visible: true })),
        `preview-terminal-visible:${agent.item.id}`,
      );

      const workspaceMutationRequests: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "GET") return;
        const url = request.url();
        if (
          url.includes("/tools/SANDBOX_START") ||
          url.includes("/tools/SANDBOX_SETUP") ||
          url.includes("/tools/GIT_") ||
          url.includes("/tools/FS_") ||
          url.includes("/webdav/")
        ) {
          workspaceMutationRequests.push(`${request.method()} ${url}`);
        }
      });

      await page.goto(
        `/${orgSlug}/${thread.item.id}?virtualmcpid=${agent.item.id}&sidepanel=chat&main=preview`,
      );

      await expect(
        page.getByRole("heading", {
          name: "This chat isn't available on the web",
        }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("chat-panel")).toHaveCount(0);
      await expect(page.getByTestId("main-panel")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Publish", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /^sandbox$/i }),
      ).toHaveCount(0);
      expect(workspaceMutationRequests).toEqual([]);

      const afterNavigation = await db.query(
        `SELECT status, branch, metadata
           FROM threads
          WHERE id = $1 AND created_by = $2`,
        [thread.item.id, user.userId],
      );
      expect(afterNavigation.rows).toEqual(beforeNavigation.rows);
    } finally {
      await db.end();
    }
  });
});
