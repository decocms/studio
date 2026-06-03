/**
 * E2E: POST /:org/decopilot/threads/:threadId/messages dispatch gating.
 *
 * These assertions used to live in a unit test that mocked resolveTier,
 * model-permissions, dispatch-queue, the sandbox-kind resolver, AND fabricated
 * a MeshContext — then drove the Hono route and checked the HTTP status. That
 * is the bad zone (a route handler with every dependency faked); per TESTING.md
 * a route belongs in e2e, exercised through the real front door.
 *
 * The whole flow is reachable without standing up a model/credential config:
 * sending `harnessId: "claude-code"` makes per-request model resolution a pure
 * static lookup (no resolveTier, no credential row), so the handler runs for
 * real all the way to `resolveDispatchTarget` — the link-gating logic under
 * test — and the pin persistence is asserted against the real thread row.
 *
 * Link state is real: a daemon is brought online via `connectToCluster` (the
 * same path link-dispatch-happy.spec.ts uses), advertising the capabilities
 * each case needs.
 */

import { expect, test } from "../fixtures/test";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { connectToCluster } from "../../src/link-daemon/cluster-connection";
import type {
  ControlHandler,
  ControlHandlerResponse,
} from "../../src/link-daemon/control-handler";
import type { Capability } from "../../src/links/protocol";
import type { RequestFrame } from "../../src/links/dispatch-frames";
import type { APIRequestContext } from "@playwright/test";

// The gating tests never receive a dispatch — the link only needs to be
// *present* in the claim registry. A no-op control handler satisfies the
// connectToCluster contract.
const noopControlHandler: ControlHandler = {
  async handle(_req: RequestFrame): Promise<ControlHandlerResponse> {
    return { status: 404, body: "not implemented in e2e gating test" };
  },
  async *handleStream(
    _req: RequestFrame,
  ): AsyncIterable<{ type: "raw-chunk"; data: string }> {
    // nothing to yield
  },
};

type Cluster = Awaited<ReturnType<typeof connectToCluster>>;

const FAKE_PREVIEW_PORT = 19998;

async function mintApiKey(
  api: APIRequestContext,
  orgSlug: string,
): Promise<string> {
  const result = await callSelfMcpTool<{ key?: string }>(
    api,
    orgSlug,
    "API_KEY_CREATE",
    { name: `decopilot-e2e-${Date.now()}`, permissions: { "*": ["*"] } },
  );
  if (!result.key) {
    throw new Error(
      `API_KEY_CREATE returned no key: ${JSON.stringify(result)}`,
    );
  }
  return result.key;
}

/** Bring a link daemon online for the authed user with the given capabilities. */
async function connectLink(
  api: APIRequestContext,
  apiKey: string,
  capabilities: Capability[],
): Promise<Cluster> {
  const base = `http://localhost:${process.env.PORT ?? "3000"}`;
  const wsUrl = `${base.replace(/^http/, "ws")}/api/links/connect`;
  const cluster = await connectToCluster({
    url: wsUrl,
    accessToken: apiKey,
    hello: {
      previewPort: FAKE_PREVIEW_PORT,
      machineId: "decopilot-e2e-machine",
      hostname: "decopilot-e2e-host",
      cliVersion: "0.0.0-e2e",
      capabilities,
    },
    controlHandler: noopControlHandler,
    maxAttempts: 1,
  });
  // The claim is written to the NATS KV bucket during hello handling — wait
  // until it's visible so POST /messages sees an online link.
  await expect
    .poll(
      async () => {
        const res = await api.get("/api/links/me");
        if (res.status() !== 200) return null;
        return (await res.json()) as unknown;
      },
      { timeout: 10_000, intervals: [200, 500, 1000] },
    )
    .toMatchObject({ previewPort: FAKE_PREVIEW_PORT });
  return cluster;
}

interface MessageBodyOverrides {
  agentId?: string;
  sandboxProviderKind?: "cluster" | "user-desktop";
  harnessId?: "claude-code" | "codex" | "decopilot";
}

function messageBody(overrides: MessageBodyOverrides = {}) {
  return {
    messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    agent: { id: overrides.agentId ?? "agent_e2e" },
    branch: "ephemeral",
    temperature: 0.5,
    ...(overrides.sandboxProviderKind
      ? { sandboxProviderKind: overrides.sandboxProviderKind }
      : {}),
    ...(overrides.harnessId ? { harnessId: overrides.harnessId } : {}),
  };
}

function postMessage(
  api: APIRequestContext,
  orgSlug: string,
  threadId: string,
  body: ReturnType<typeof messageBody>,
) {
  return api.post(`/api/${orgSlug}/decopilot/threads/${threadId}/messages`, {
    data: body,
    headers: { "content-type": "application/json" },
  });
}

/** Create a real agent (virtual MCP) + thread row; returns both ids. */
async function createAgentAndThread(
  api: APIRequestContext,
  orgSlug: string,
): Promise<{ agentId: string; threadId: string }> {
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: "E2E Decopilot Agent",
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
    { data: { virtual_mcp_id: agent.item.id, title: "E2E Decopilot Thread" } },
  );
  return { agentId: agent.item.id, threadId: thread.item.id };
}

test.describe("POST /messages — dispatch target gating", () => {
  test("user-desktop kind + no online link → 409 user_desktop_link_offline", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    const res = await postMessage(
      api,
      orgSlug,
      "thread_e2e_offline",
      messageBody({
        sandboxProviderKind: "user-desktop",
        harnessId: "claude-code",
      }),
    );

    expect(res.status()).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe("link_unavailable");
    expect(body.code).toBe("user_desktop_link_offline");
  });

  test("user-desktop kind + link missing capability → 409 user_desktop_link_capability_missing", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    const apiKey = await mintApiKey(api, orgSlug);
    // Link advertises only decopilot-sandbox; a claude-code harness needs the
    // "claude-code" capability.
    const cluster = await connectLink(api, apiKey, ["decopilot-sandbox"]);
    try {
      const res = await postMessage(
        api,
        orgSlug,
        "thread_e2e_capmiss",
        messageBody({
          sandboxProviderKind: "user-desktop",
          harnessId: "claude-code",
        }),
      );

      expect(res.status()).toBe(409);
      const body = (await res.json()) as {
        code: string;
        activeCapabilities: string[];
      };
      expect(body.code).toBe("user_desktop_link_capability_missing");
      expect(body.activeCapabilities).toEqual(["decopilot-sandbox"]);
    } finally {
      await cluster.close();
    }
  });

  test("cloud kind (cluster) → 202 (no link required)", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    const { agentId, threadId } = await createAgentAndThread(api, orgSlug);
    const res = await postMessage(
      api,
      orgSlug,
      threadId,
      messageBody({
        agentId,
        sandboxProviderKind: "cluster",
        harnessId: "claude-code",
      }),
    );

    expect(res.status()).toBe(202);
  });
});

test.describe("POST /messages — first-message pinning", () => {
  test("first message persists sandbox/harness pins on the thread row", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    const apiKey = await mintApiKey(api, orgSlug);
    // user-desktop + claude-code resolves OK only when the link advertises it.
    const cluster = await connectLink(api, apiKey, ["claude-code"]);
    const db = await connectDevDb();
    try {
      const { agentId, threadId } = await createAgentAndThread(api, orgSlug);

      const res = await postMessage(
        api,
        orgSlug,
        threadId,
        messageBody({
          agentId,
          sandboxProviderKind: "user-desktop",
          harnessId: "claude-code",
        }),
      );
      expect(res.status()).toBe(202);

      const { rows } = await db.query(
        "SELECT sandbox_provider_kind, harness_id FROM threads WHERE id = $1",
        [threadId],
      );
      expect(rows[0]?.sandbox_provider_kind).toBe("user-desktop");
      expect(rows[0]?.harness_id).toBe("claude-code");
    } finally {
      await db.end();
      await cluster.close();
    }
  });

  test("subsequent message keeps the pinned sandbox kind and ignores a conflicting body", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    const apiKey = await mintApiKey(api, orgSlug);
    const cluster = await connectLink(api, apiKey, ["claude-code"]);
    const db = await connectDevDb();
    try {
      const { agentId, threadId } = await createAgentAndThread(api, orgSlug);

      // First message pins (user-desktop, claude-code).
      const first = await postMessage(
        api,
        orgSlug,
        threadId,
        messageBody({
          agentId,
          sandboxProviderKind: "user-desktop",
          harnessId: "claude-code",
        }),
      );
      expect(first.status()).toBe(202);

      // Second message sends a conflicting sandbox kind (cluster). The
      // thread row already pins user-desktop, which is the single source of
      // truth — the body's kind must be ignored. We keep harnessId
      // "claude-code" here on purpose: a non-CLI harness in the body (e.g.
      // "decopilot") would force real per-request model resolution via
      // resolveTier, which 400s on an org with no model configured. (The old
      // unit test only "passed" that path because it mocked resolveTier — the
      // real front door exposes the dependency.)
      const second = await postMessage(
        api,
        orgSlug,
        threadId,
        messageBody({
          agentId,
          sandboxProviderKind: "cluster",
          harnessId: "claude-code",
        }),
      );
      expect(second.status()).toBe(202);

      // The conflicting body did not overwrite the pinned values: the row is
      // still user-desktop, not cluster.
      const { rows } = await db.query(
        "SELECT sandbox_provider_kind, harness_id FROM threads WHERE id = $1",
        [threadId],
      );
      expect(rows[0]?.sandbox_provider_kind).toBe("user-desktop");
      expect(rows[0]?.harness_id).toBe("claude-code");
    } finally {
      await db.end();
      await cluster.close();
    }
  });
});
