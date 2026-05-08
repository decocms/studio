import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { COLLECTION_THREADS_CREATE } from "./create";
import { buildThreadTestContext, type ThreadTestEnv } from "./test-helpers";

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

    expect(result.item.branch).toMatch(/^deco\/[a-z]+-[a-z]+$/);
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

  it("picks the most-recently-touched vmMap branch when no input branch + github vMCP", async () => {
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
          vmMap: {
            [env.userId]: {
              "deco/old-branch": {
                vmId: "vm_old",
                previewUrl: null,
                createdAt: 1000,
              },
              "deco/new-branch": {
                vmId: "vm_new",
                previewUrl: null,
                createdAt: 2000,
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
});
