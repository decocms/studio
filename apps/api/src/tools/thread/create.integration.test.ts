import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { COLLECTION_THREADS_CREATE } from "./create";
import { buildThreadTestContext, type ThreadTestEnv } from "./test-helpers";
import { posthog } from "../../posthog";

describe("COLLECTION_THREADS_CREATE", () => {
  let env: ThreadTestEnv;

  beforeAll(async () => {
    env = await buildThreadTestContext();
  });
  afterAll(async () => {
    await env.close();
  });

  it("assigns a generated branch when the vMCP has a github repo", async () => {
    const vmcp = await env.ctx.storage.virtualMcps.create(
      env.orgId,
      env.userId,
      {
        title: "gh-vmcp",
        connections: [],
        status: "active",
        pinned: false,
        metadata: {
          githubRepo: {
            owner: "acme",
            name: "repo",
            url: "https://github.com/acme/repo",
            installationId: 1,
            connectionId: "conn_x",
          },
        },
      },
    );

    const result = await COLLECTION_THREADS_CREATE.handler(
      { data: { virtual_mcp_id: vmcp.id, title: "t" } },
      env.ctx,
    );

    // <creator-slug>-<base36-timestamp>; the test user's name is "T".
    expect(result.item.branch).toMatch(/^t-[0-9a-z]+$/);
    expect(result.item.virtual_mcp_id).toBe(vmcp.id);
  });

  it("leaves branch null when the vMCP has no github repo", async () => {
    const vmcp = await env.ctx.storage.virtualMcps.create(
      env.orgId,
      env.userId,
      { title: "no-gh", connections: [], status: "active", pinned: false },
    );

    const result = await COLLECTION_THREADS_CREATE.handler(
      { data: { virtual_mcp_id: vmcp.id, title: "t" } },
      env.ctx,
    );

    expect(result.item.branch).toBeNull();
  });

  it("uses the input branch when the vMCP has a github repo", async () => {
    const vmcp = await env.ctx.storage.virtualMcps.create(
      env.orgId,
      env.userId,
      {
        title: "gh-vmcp-explicit",
        connections: [],
        status: "active",
        pinned: false,
        metadata: {
          githubRepo: {
            owner: "acme",
            name: "repo",
            url: "https://github.com/acme/repo",
            installationId: 1,
            connectionId: "conn_x",
          },
        },
      },
    );

    const result = await COLLECTION_THREADS_CREATE.handler(
      {
        data: {
          virtual_mcp_id: vmcp.id,
          title: "t",
          branch: "deco/custom-branch",
        },
      },
      env.ctx,
    );

    expect(result.item.branch).toBe("deco/custom-branch");
  });

  it("ignores the input branch when the vMCP has no github repo", async () => {
    const vmcp = await env.ctx.storage.virtualMcps.create(
      env.orgId,
      env.userId,
      {
        title: "no-gh-with-input-branch",
        connections: [],
        status: "active",
        pinned: false,
      },
    );

    const result = await COLLECTION_THREADS_CREATE.handler(
      {
        data: {
          virtual_mcp_id: vmcp.id,
          title: "t",
          branch: "deco/should-be-ignored",
        },
      },
      env.ctx,
    );

    expect(result.item.branch).toBeNull();
  });

  it("picks the most-recently-touched sandboxMap branch when no input branch + github vMCP", async () => {
    const vmcp = await env.ctx.storage.virtualMcps.create(
      env.orgId,
      env.userId,
      {
        title: "gh-vmcp-with-vmmap",
        connections: [],
        status: "active",
        pinned: false,
        metadata: {
          githubRepo: {
            owner: "acme",
            name: "repo",
            url: "https://github.com/acme/repo",
            installationId: 1,
            connectionId: "conn_x",
          },
          sandboxMap: {
            [env.userId]: {
              "deco/old-branch": {
                "agent-sandbox": {
                  sandboxHandle: "vm_old",
                  previewUrl: null,
                  createdAt: 1000,
                },
              },
              "deco/new-branch": {
                "agent-sandbox": {
                  sandboxHandle: "vm_new",
                  previewUrl: null,
                  createdAt: 2000,
                },
              },
            },
          },
        },
      },
    );

    const result = await COLLECTION_THREADS_CREATE.handler(
      { data: { virtual_mcp_id: vmcp.id, title: "t" } },
      env.ctx,
    );

    expect(result.item.branch).toBe("deco/new-branch");
  });

  it("runtime 'sandbox' shares the given branch (a coding session continues the CMS draft)", async () => {
    const vmcp = await env.ctx.storage.virtualMcps.create(
      env.orgId,
      env.userId,
      {
        title: "gh-vmcp-sandbox-runtime",
        connections: [],
        status: "active",
        pinned: false,
        metadata: {
          githubRepo: {
            owner: "acme",
            name: "repo",
            url: "https://github.com/acme/repo",
            installationId: 1,
            connectionId: "conn_x",
          },
        },
      },
    );

    const result = await COLLECTION_THREADS_CREATE.handler(
      {
        data: {
          virtual_mcp_id: vmcp.id,
          title: "t",
          branch: "deco/cms-draft-branch",
          runtime: "sandbox",
        },
      },
      env.ctx,
    );

    expect(result.item.branch).toBe("deco/cms-draft-branch");
    expect(result.item.metadata?.runtime).toBe("sandbox");
  });

  it("persists the runtime stamp and round-trips it through storage", async () => {
    const vmcp = await env.ctx.storage.virtualMcps.create(
      env.orgId,
      env.userId,
      { title: "stamp", connections: [], status: "active", pinned: false },
    );

    const result = await COLLECTION_THREADS_CREATE.handler(
      { data: { virtual_mcp_id: vmcp.id, title: "t", runtime: "sandbox" } },
      env.ctx,
    );
    // No github repo: no branch, but the stamp still persists.
    expect(result.item.branch).toBeNull();

    const stored = await env.ctx.storage.threads.get(result.item.id);
    expect(stored?.metadata?.runtime).toBe("sandbox");
  });

  it("leaves metadata unset when no runtime is given", async () => {
    const vmcp = await env.ctx.storage.virtualMcps.create(
      env.orgId,
      env.userId,
      { title: "no-stamp", connections: [], status: "active", pinned: false },
    );

    const result = await COLLECTION_THREADS_CREATE.handler(
      { data: { virtual_mcp_id: vmcp.id, title: "t" } },
      env.ctx,
    );

    const stored = await env.ctx.storage.threads.get(result.item.id);
    expect(stored?.metadata?.runtime).toBeUndefined();
  });

  it("is idempotent: creating with the same id twice returns the same row", async () => {
    const vmcp = await env.ctx.storage.virtualMcps.create(
      env.orgId,
      env.userId,
      { title: "x", connections: [], status: "active", pinned: false },
    );

    const id = "thrd_test_idempotent";
    const first = await COLLECTION_THREADS_CREATE.handler(
      { data: { id, virtual_mcp_id: vmcp.id, title: "first" } },
      env.ctx,
    );
    const second = await COLLECTION_THREADS_CREATE.handler(
      { data: { id, virtual_mcp_id: vmcp.id, title: "second" } },
      env.ctx,
    );

    expect(second.item.id).toBe(first.item.id);
    expect(second.item.title).toBe("first"); // existing row, not overwritten
  });

  it("does not re-fire the chat_started analytics event on an id-collision replay", async () => {
    const vmcp = await env.ctx.storage.virtualMcps.create(
      env.orgId,
      env.userId,
      { title: "y", connections: [], status: "active", pinned: false },
    );
    const captureSpy = spyOn(posthog, "capture");
    captureSpy.mockClear();

    const id = "thrd_test_idempotent_analytics";
    await COLLECTION_THREADS_CREATE.handler(
      { data: { id, virtual_mcp_id: vmcp.id, title: "first" } },
      env.ctx,
    );
    await COLLECTION_THREADS_CREATE.handler(
      { data: { id, virtual_mcp_id: vmcp.id, title: "second" } },
      env.ctx,
    );

    expect(captureSpy).toHaveBeenCalledTimes(1);
    captureSpy.mockRestore();
  });

  it("rejects a virtual_mcp_id belonging to a different organization", async () => {
    const foreignVmcp = await env.ctx.storage.virtualMcps.create(
      "org_1",
      env.userId,
      { title: "foreign", connections: [], status: "active", pinned: false },
    );

    await expect(
      COLLECTION_THREADS_CREATE.handler(
        { data: { virtual_mcp_id: foreignVmcp.id, title: "t" } },
        env.ctx,
      ),
    ).rejects.toThrow(/Virtual MCP not found/i);
  });
});
