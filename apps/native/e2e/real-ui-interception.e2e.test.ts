/**
 * Black-box coverage for the native web shell routes that remain after the
 * terminal-agent cutover. Interactive execution is covered by
 * `native-agent-terminal.e2e.test.ts`; the removed Decopilot transport is
 * intentionally absent from this suite.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";

import {
  signInAndCompleteSession,
  startAuthenticatedUpstream,
} from "./authenticated-upstream";
import {
  authHeaders,
  describeLocalApi,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  type LocalApi,
  startLocalApi,
  stopLocalApi,
  url,
} from "./helpers";

let orgCounter = 0;

function freshOrg(): string {
  orgCounter += 1;
  return `thread-tools-${orgCounter}`;
}

async function callTool(
  api: LocalApi,
  org: string,
  tool: string,
  body: unknown,
): Promise<Response> {
  return fetch(url(api, `/api/${org}/tools/${tool}`), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify(body),
  });
}

describeLocalApi("local-api e2e: native thread-tool interception", () => {
  let api: LocalApi;
  let upstream: ReturnType<typeof startAuthenticatedUpstream>;

  beforeAll(async () => {
    upstream = startAuthenticatedUpstream();
    api = await startLocalApi({
      DECOCMS_UPSTREAM_URL: upstream.url,
      LOCAL_API_TOKEN_STORE: "memory",
    });
    await signInAndCompleteSession(api);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await stopLocalApi(api);
    upstream.server.stop(true);
  }, HOOK_TIMEOUT_MS);

  it("round-trips create, list, get, update, and delete with the production tool wire shape", async () => {
    const org = freshOrg();
    const id = `thread-${org}`;
    const createdResponse = await callTool(
      api,
      org,
      "COLLECTION_THREADS_CREATE",
      {
        data: {
          id,
          title: "New chat",
          virtual_mcp_id: "vmcp-one",
        },
      },
    );
    expect(createdResponse.status).toBe(200);
    const created = (await createdResponse.json()) as {
      item: Record<string, unknown>;
    };
    expect(created).not.toHaveProperty("content");
    expect(created.item).toMatchObject({
      id,
      title: "New chat",
      organization_id: org,
      virtual_mcp_id: "vmcp-one",
      hidden: false,
      created_by: "sandbox-e2e-user",
    });

    const listedResponse = await callTool(api, org, "COLLECTION_THREADS_LIST", {
      limit: 50,
      offset: 0,
    });
    expect(listedResponse.status).toBe(200);
    const listed = (await listedResponse.json()) as {
      items: Array<{ id: string }>;
      totalCount: number;
      hasMore: boolean;
    };
    expect(listed.items.map((item) => item.id)).toEqual([id]);
    expect(listed.totalCount).toBe(1);
    expect(listed.hasMore).toBe(false);

    const fetchedResponse = await callTool(api, org, "COLLECTION_THREADS_GET", {
      id,
    });
    expect(fetchedResponse.status).toBe(200);
    expect(
      ((await fetchedResponse.json()) as { item: { id: string } }).item.id,
    ).toBe(id);

    const updatedResponse = await callTool(
      api,
      org,
      "COLLECTION_THREADS_UPDATE",
      { id, data: { title: "Renamed chat" } },
    );
    expect(updatedResponse.status).toBe(200);
    expect(
      ((await updatedResponse.json()) as { item: { title: string } }).item
        .title,
    ).toBe("Renamed chat");

    const deletedResponse = await callTool(
      api,
      org,
      "COLLECTION_THREADS_DELETE",
      { id },
    );
    expect(deletedResponse.status).toBe(200);
    expect(
      ((await deletedResponse.json()) as { item: { id: string } }).item.id,
    ).toBe(id);

    const missingResponse = await callTool(api, org, "COLLECTION_THREADS_GET", {
      id,
    });
    expect(await missingResponse.json()).toEqual({ item: null });
    const terminalResponse = await fetch(
      url(api, `/api/${org}/threads/${id}/terminal`),
      { headers: authHeaders() },
    );
    expect(terminalResponse.status).toBe(404);
  });

  it("validates required create fields and returns empty pages for unknown history", async () => {
    const org = freshOrg();
    const invalid = await callTool(api, org, "COLLECTION_THREADS_CREATE", {
      data: { title: "missing virtual MCP" },
    });
    expect(invalid.status).toBe(400);

    const unknown = await callTool(api, org, "COLLECTION_THREADS_GET", {
      id: "does-not-exist",
    });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ item: null });

    const messages = await callTool(
      api,
      org,
      "COLLECTION_THREAD_MESSAGES_LIST",
      { thread_id: "does-not-exist" },
    );
    expect(messages.status).toBe(200);
    expect(await messages.json()).toEqual({
      items: [],
      totalCount: 0,
      hasMore: false,
    });
  });

  it("does not disclose or mutate a known thread through another organization", async () => {
    const ownerOrg = freshOrg();
    const otherOrg = freshOrg();
    const id = `scoped-${ownerOrg}`;
    const create = await callTool(api, ownerOrg, "COLLECTION_THREADS_CREATE", {
      data: { id, title: "Owner chat", virtual_mcp_id: "vmcp-scoped" },
    });
    expect(create.status).toBe(200);

    const collision = await callTool(
      api,
      otherOrg,
      "COLLECTION_THREADS_CREATE",
      {
        data: { id, title: "Foreign chat", virtual_mcp_id: "vmcp-scoped" },
      },
    );
    expect(collision.status).toBe(409);
    expect(await collision.json()).toEqual({
      error: "thread id is unavailable",
    });

    const foreignGet = await callTool(api, otherOrg, "COLLECTION_THREADS_GET", {
      id,
    });
    expect(await foreignGet.json()).toEqual({ item: null });
    const foreignUpdate = await callTool(
      api,
      otherOrg,
      "COLLECTION_THREADS_UPDATE",
      { id, data: { title: "Hijacked" } },
    );
    expect(foreignUpdate.status).toBe(404);
    const foreignDelete = await callTool(
      api,
      otherOrg,
      "COLLECTION_THREADS_DELETE",
      { id },
    );
    expect(foreignDelete.status).toBe(404);

    const ownerGet = await callTool(api, ownerOrg, "COLLECTION_THREADS_GET", {
      id,
    });
    expect(
      ((await ownerGet.json()) as { item: { title: string } }).item.title,
    ).toBe("Owner chat");
  });

  it("answers capability discovery locally and proxies unknown tools upstream", async () => {
    const org = freshOrg();
    const capabilities = await fetch(url(api, "/_local/agent-capabilities"), {
      headers: authHeaders(),
    });
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toEqual({
      capabilities: expect.any(Array),
    });

    const unknown = await callTool(api, org, "SOME_OTHER_TOOL", {});
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("not found");
  });

  it("rejects account-scoped thread creation while signed out", async () => {
    const signedOut = await startLocalApi({
      DECOCMS_UPSTREAM_URL: upstream.url,
      LOCAL_API_TOKEN_STORE: "memory",
    });
    try {
      const capabilities = await fetch(
        url(signedOut, "/_local/agent-capabilities"),
        { headers: authHeaders() },
      );
      expect(capabilities.status).toBe(200);

      const create = await callTool(
        signedOut,
        "signed-out-org",
        "COLLECTION_THREADS_CREATE",
        {
          data: {
            id: "must-not-exist",
            title: "No account",
            virtual_mcp_id: "vmcp",
          },
        },
      );
      expect(create.status).toBe(401);
      expect(await create.json()).toEqual({ error: "unauthorized" });
    } finally {
      await stopLocalApi(signedOut);
    }
  });
});
