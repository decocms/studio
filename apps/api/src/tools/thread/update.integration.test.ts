import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { COLLECTION_THREADS_CREATE } from "./create";
import { COLLECTION_THREADS_UPDATE } from "./update";
import { buildThreadTestContext, type ThreadTestEnv } from "./test-helpers";

describe("COLLECTION_THREADS_UPDATE", () => {
  let env: ThreadTestEnv;

  beforeAll(async () => {
    env = await buildThreadTestContext();
  });
  afterAll(async () => {
    await env.close();
  });

  it("rejects branch=null for a github-linked thread", async () => {
    const vmcp = await env.ctx.storage.virtualMcps.create(
      env.orgId,
      env.userId,
      {
        title: "gh",
        connections: [],
        status: "active",
        pinned: false,
        metadata: {
          githubRepo: {
            owner: "a",
            name: "b",
            url: "https://github.com/a/b",
            installationId: 1,
            connectionId: "c",
          },
        },
      },
    );
    const created = await COLLECTION_THREADS_CREATE.handler(
      { data: { virtual_mcp_id: vmcp.id, title: "t" } },
      env.ctx,
    );

    await expect(
      COLLECTION_THREADS_UPDATE.handler(
        { id: created.item.id, data: { branch: null } },
        env.ctx,
      ),
    ).rejects.toThrow(/branch.*null.*github/i);
  });

  it("allows branch=null for non-github threads", async () => {
    const vmcp = await env.ctx.storage.virtualMcps.create(
      env.orgId,
      env.userId,
      { title: "no-gh", connections: [], status: "active", pinned: false },
    );
    const created = await COLLECTION_THREADS_CREATE.handler(
      { data: { virtual_mcp_id: vmcp.id, title: "t" } },
      env.ctx,
    );

    const updated = await COLLECTION_THREADS_UPDATE.handler(
      { id: created.item.id, data: { branch: null } },
      env.ctx,
    );
    expect(updated.item.branch).toBeNull();
  });

  it("allows switching to a different branch on github threads", async () => {
    const vmcp = await env.ctx.storage.virtualMcps.create(
      env.orgId,
      env.userId,
      {
        title: "gh",
        connections: [],
        status: "active",
        pinned: false,
        metadata: {
          githubRepo: {
            owner: "a",
            name: "b",
            url: "https://github.com/a/b",
            installationId: 1,
            connectionId: "c",
          },
        },
      },
    );
    const created = await COLLECTION_THREADS_CREATE.handler(
      { data: { virtual_mcp_id: vmcp.id, title: "t" } },
      env.ctx,
    );

    const updated = await COLLECTION_THREADS_UPDATE.handler(
      { id: created.item.id, data: { branch: "deco/manual-pick" } },
      env.ctx,
    );
    expect(updated.item.branch).toBe("deco/manual-pick");
  });

  it("rejects re-pointing a thread at a virtual_mcp_id from a different organization", async () => {
    const vmcp = await env.ctx.storage.virtualMcps.create(
      env.orgId,
      env.userId,
      { title: "own", connections: [], status: "active", pinned: false },
    );
    const created = await COLLECTION_THREADS_CREATE.handler(
      { data: { virtual_mcp_id: vmcp.id, title: "t" } },
      env.ctx,
    );

    const foreignVmcp = await env.ctx.storage.virtualMcps.create(
      "org_1",
      env.userId,
      { title: "foreign", connections: [], status: "active", pinned: false },
    );

    await expect(
      COLLECTION_THREADS_UPDATE.handler(
        {
          id: created.item.id,
          data: { virtual_mcp_id: foreignVmcp.id },
        },
        env.ctx,
      ),
    ).rejects.toThrow(/Virtual MCP not found/i);
  });

  it("preserves the immutable runtime stamp across an unrelated metadata write", async () => {
    const vmcp = await env.ctx.storage.virtualMcps.create(
      env.orgId,
      env.userId,
      {
        title: "sandbox-stamped",
        connections: [],
        status: "active",
        pinned: false,
        metadata: {
          previewServerUrl: "https://preview.example.com",
          fastPreview: true,
        },
      },
    );
    const created = await COLLECTION_THREADS_CREATE.handler(
      {
        data: {
          virtual_mcp_id: vmcp.id,
          title: "t",
          branch: "main",
          runtime: "sandbox",
        },
      },
      env.ctx,
    );
    expect(created.item.metadata?.runtime).toBe("sandbox");

    const updated = await COLLECTION_THREADS_UPDATE.handler(
      {
        id: created.item.id,
        data: { metadata: { expanded_tools: [] } },
      },
      env.ctx,
    );
    expect(updated.item.metadata?.runtime).toBe("sandbox");
  });
});
