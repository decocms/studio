import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";
import { retry } from "@decocms/shared/std";

const NON_HOSTED_HARNESSES = ["claude-code", "codex", "opencode", "future"];

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
] as const;

test.describe("hosted runtime boundary", () => {
  test.describe.configure({ mode: "serial" });

  test("rejects native harness requests before pinning or persisting a message", async ({
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

      for (const harnessId of NON_HOSTED_HARNESSES) {
        const response = await api.post(
          `/api/${orgSlug}/decopilot/threads/${thread.item.id}/messages`,
          {
            data: {
              messages: [
                {
                  id: `msg-${harnessId}`,
                  role: "user",
                  parts: [{ type: "text", text: "Do not dispatch this" }],
                },
              ],
              agent: { id: agent.item.id },
              harnessId,
            },
            headers: { "content-type": "application/json" },
          },
        );
        expect(response.status()).toBe(400);
      }

      const retiredSandboxResponse = await api.post(
        `/api/${orgSlug}/decopilot/threads/${thread.item.id}/messages`,
        {
          data: {
            messages: [
              {
                id: "msg-retired-sandbox",
                role: "user",
                parts: [{ type: "text", text: "Do not dispatch this" }],
              },
            ],
            agent: { id: agent.item.id },
            harnessId: "decopilot",
            sandboxProviderKind: "user-desktop",
          },
          headers: { "content-type": "application/json" },
        },
      );
      expect(retiredSandboxResponse.status()).toBe(400);

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
    } finally {
      await db.end();
    }
  });

  test("rejects persisted native and unknown harness rows without side effects", async ({
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
              agent: { id: agent.item.id },
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

  test("keeps a retired local Decopilot pin readable as hosted", async ({
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
            title: "legacy hosted runtime",
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
      const update = await db.query(
        `UPDATE threads
            SET harness_id = 'decopilot',
                sandbox_provider_kind = 'user-desktop'
          WHERE id = $1 AND created_by = $2`,
        [thread.item.id, user.userId],
      );
      expect(update.rowCount).toBe(1);

      const queue = await api.get(
        `/api/${orgSlug}/decopilot/queue/${thread.item.id}`,
      );
      expect(queue.status()).toBe(200);
      expect(await queue.json()).toEqual({ items: [] });

      const row = await db.query(
        `SELECT harness_id, sandbox_provider_kind
           FROM threads
          WHERE id = $1 AND created_by = $2`,
        [thread.item.id, user.userId],
      );
      expect(row.rows).toEqual([
        {
          harness_id: "decopilot",
          sandbox_provider_kind: "user-desktop",
        },
      ]);
    } finally {
      await db.end();
    }
  });

  test("does not treat a historical coding-agent key as a hosted provider", async ({
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
            agent: { id: agent.item.id },
            harnessId: "decopilot",
            sandboxProviderKind: "agent-sandbox",
          },
          headers: { "content-type": "application/json" },
        },
      );

      expect(response.status()).toBe(400);
      expect(await response.json()).toEqual({
        error:
          'No model available for tier "smart". Connect a provider or configure the tier in organization settings.',
      });

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
            agent: { id: agent.item.id },
            harnessId: "decopilot",
            sandboxProviderKind: "agent-sandbox",
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
