/**
 * E2E: desktop-link tunnel session + optimistic presence.
 *
 * Two areas:
 *
 *   1. `POST /api/links/session` mount + auth (the CLI handshake that mints the
 *      tunnel credentials).
 *
 *   2. Optimistic presence. There is no `studio_links` claim and no heartbeat
 *      bucket: presence is whatever the live `/api/links/status` probe returns.
 *      The cluster's `/api/links/me` read calls `linkStatusProbe`, which fetches
 *      `GET /api/links/status` over the tunnel. So the indicator flips:
 *        - online  ⇢ a daemon is serving that route under the user's hostname
 *        - offline ⇢ no daemon answers within the probe timeout
 *      And a `user-desktop` message sent while offline is no longer gated with a
 *      synchronous 409 — it is accepted (202) and the failure surfaces later as
 *      a run error.
 */

import { expect, getE2EAppOrigin, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { createTunnelLinkDaemon } from "../fixtures/links-presence";
import type { APIRequestContext } from "@playwright/test";

const LINK_SESSION_BODY = {
  machineId: "e2e-machine",
  cliVersion: "e2e",
  capabilities: ["claude-code"],
  previewPort: 4000,
};

test.describe("link tunnel session", () => {
  test("POST /api/links/session is mounted and accepts authenticated users", async ({
    authedPage,
  }) => {
    const { page } = authedPage;
    const res = await page.context().request.post("/api/links/session", {
      data: LINK_SESSION_BODY,
    });

    expect(res.status()).not.toBe(404);
    expect([200, 503]).toContain(res.status());

    const body = (await res.json()) as {
      connection?: {
        urls?: unknown;
        credentials?: unknown;
        token?: unknown;
      };
      error?: unknown;
      expiresAt?: unknown;
      tunnelHostname?: unknown;
    };

    if (res.status() === 200) {
      const urls = body.connection?.urls;
      expect(Array.isArray(urls)).toBe(true);
      if (!Array.isArray(urls)) {
        throw new Error(
          "link session response did not include connection.urls",
        );
      }
      expect(urls.length).toBeGreaterThan(0);
      expect(body.tunnelHostname).toEqual(
        expect.stringMatching(/^user-[A-Za-z0-9_-]+\.link$/),
      );
      expect(typeof body.expiresAt).toBe("string");

      const hasCredentials = typeof body.connection?.credentials === "string";
      const hasToken = typeof body.connection?.token === "string";
      expect(hasCredentials || hasToken).toBe(true);
      return;
    }

    expect(body).toEqual(
      expect.objectContaining({ error: expect.any(String) }),
    );
    const serializedBody = JSON.stringify(body);
    expect(serializedBody).not.toContain("NATS");
    expect(serializedBody).not.toContain("/nats-session");
    expect(serializedBody).not.toContain("links.");
    expect(serializedBody).not.toContain("_tunnel.");
  });

  test("POST /api/links/session rejects unauthenticated callers", async ({
    browser,
  }) => {
    const unauthContext = await browser.newContext({
      baseURL: getE2EAppOrigin(),
    });

    try {
      const res = await unauthContext.request.post("/api/links/session", {
        data: LINK_SESSION_BODY,
      });
      expect([401, 403]).toContain(res.status());
    } finally {
      await unauthContext.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Optimistic presence helpers
// ---------------------------------------------------------------------------

/** The presence signal the UI dot polls, read straight from the cluster. */
async function readPresence(api: APIRequestContext): Promise<unknown> {
  const res = await api.get("/api/links/me");
  expect(res.status()).toBe(200);
  return (await res.json()) as unknown;
}

/** Resolve the org id (not slug) for the given org slug. */
async function orgIdForSlug(
  db: Awaited<ReturnType<typeof connectDevDb>>,
  slug: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM "organization" WHERE slug = $1`,
    [slug],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`no organization row for slug ${slug}`);
  return id;
}

async function fetchThreadStatus(
  db: Awaited<ReturnType<typeof connectDevDb>>,
  threadId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM threads WHERE id = $1`,
    [threadId],
  );
  return rows[0]?.status ?? null;
}

/**
 * Create a real agent (virtual MCP) + a thread pinned to a user-desktop runtime
 * (harness_id='claude-code', sandbox_provider_kind='user-desktop',
 * message_storage_version=2) so the very first POST /messages routes to the
 * desktop dispatch path. Mirrors link-dispatch-pull.spec.ts.
 */
async function createUserDesktopThread(
  api: APIRequestContext,
  db: Awaited<ReturnType<typeof connectDevDb>>,
  orgSlug: string,
  orgId: string,
): Promise<{ agentId: string; threadId: string }> {
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: "Optimistic-presence E2E Agent",
        connections: [],
        status: "active",
        pinned: false,
      },
    },
  );
  const agentId = agent.item.id;

  const thread = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_THREADS_CREATE",
    {
      data: {
        virtual_mcp_id: agentId,
        title: "Optimistic-presence E2E Thread",
      },
    },
  );
  const threadId = thread.item.id;

  await db.query(
    `UPDATE threads
     SET message_storage_version = 2,
         harness_id              = 'claude-code',
         sandbox_provider_kind   = 'user-desktop'
     WHERE id = $1
       AND organization_id = $2`,
    [threadId, orgId],
  );

  return { agentId, threadId };
}

test.describe("optimistic link presence", () => {
  test("indicator flips online via the live status probe, then offline when the daemon stops", async ({
    authedPage,
  }) => {
    test.setTimeout(60_000);

    const { page, user } = authedPage;
    const api = page.context().request;

    // Offline to start: no daemon answers the tunnel status probe.
    expect(await readPresence(api)).toBeNull();

    // Bring a daemon online. createTunnelLinkDaemon serves GET /api/links/status
    // over the tunnel and waits until /api/links/me reports online — driven
    // entirely by the live probe, with no studio_links claim and no heartbeat.
    const daemon = await createTunnelLinkDaemon(api, user.userId, [
      "claude-code",
    ]);

    try {
      const online = (await readPresence(api)) as {
        hostname?: string;
        cliVersion?: string;
      } | null;
      expect(online).not.toBeNull();
      expect(typeof online?.hostname).toBe("string");
    } finally {
      await daemon.close();
    }

    // After the daemon stops, the probe fails fast and presence flips back to
    // offline within a couple of poll intervals — no TTL/heartbeat to wait out.
    await expect
      .poll(() => readPresence(api), {
        timeout: 10_000,
        intervals: [200, 500, 1_000],
      })
      .toBeNull();
  });

  test("a user-desktop message sent while offline is accepted (no 409) and surfaces a run error", async ({
    authedPage,
  }) => {
    test.setTimeout(120_000);

    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const db = await connectDevDb();

    try {
      // No daemon is running: the desktop link is offline.
      expect(await readPresence(api)).toBeNull();

      const orgId = await orgIdForSlug(db, orgSlug);
      const { agentId, threadId } = await createUserDesktopThread(
        api,
        db,
        orgSlug,
        orgId,
      );

      const res = await api.post(
        `/api/${orgSlug}/decopilot/threads/${threadId}/messages`,
        {
          data: {
            messages: [
              {
                role: "user",
                parts: [{ type: "text", text: "hello offline desktop" }],
              },
            ],
            agent: { id: agentId },
            branch: "ephemeral",
            temperature: 0.5,
            harnessId: "claude-code",
            sandboxProviderKind: "user-desktop",
          },
          headers: { "content-type": "application/json" },
        },
      );

      // The optimistic model removed the synchronous liveness gate: the message
      // is accepted, not rejected with 409 user_desktop_link_offline.
      expect(res.status()).not.toBe(409);
      expect(res.status()).toBe(202);
      const body = (await res.json()) as { taskId: string };
      expect(body.taskId).toBeTruthy();

      // The failure surfaces as a run error: with no daemon answering the
      // tunnel, the dispatch can never complete, so the thread settles into a
      // failed terminal state (never 'completed').
      await expect
        .poll(() => fetchThreadStatus(db, threadId), {
          timeout: 90_000,
          intervals: [500, 1_000, 2_000, 5_000],
        })
        .toBe("failed");
    } finally {
      await db.end();
    }
  });
});
