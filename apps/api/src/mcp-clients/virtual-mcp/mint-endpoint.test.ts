import { describe, expect, it } from "bun:test";
import {
  MissingOrganizationSlugError,
  mcpEndpointUrl,
  orgMcpServers,
  runKeyPermissions,
} from "./mint-endpoint";

const publicUrl = "https://studio.example.com";
const organization = { id: "org_1", slug: "acme" };

describe("mcpEndpointUrl", () => {
  it("points agent-tools at the agent's virtual MCP", () => {
    expect(
      mcpEndpointUrl({
        publicUrl,
        agentId: "vir_123",
        organization,
        target: "agent-tools",
      }),
    ).toBe("https://studio.example.com/mcp/virtual-mcp/vir_123");
  });

  // The regression this whole change exists for: Decopilot aggregates no
  // connections, so an out-of-process harness pointed at its virtual MCP
  // connects successfully and sees zero tools. Management must NOT be
  // agent-scoped.
  it("points management at the org-scoped self MCP, ignoring the agent id", () => {
    const url = mcpEndpointUrl({
      publicUrl,
      agentId: "decopilot_org_1",
      organization,
      target: "management",
    });
    expect(url).toBe("https://studio.example.com/api/acme/mcp/self");
    expect(url).not.toContain("virtual-mcp");
    expect(url).not.toContain("decopilot_");
  });

  it("throws for a management endpoint with no slug, rather than building /api/undefined/", () => {
    expect(() =>
      mcpEndpointUrl({
        publicUrl,
        agentId: "decopilot_org_1",
        organization: { id: "org_1" },
        target: "management",
      }),
    ).toThrow(MissingOrganizationSlugError);
  });

  it("still resolves agent-tools without a slug — that path is not org-scoped", () => {
    expect(
      mcpEndpointUrl({
        publicUrl,
        agentId: "vir_123",
        organization: { id: "org_1" },
        target: "agent-tools",
      }),
    ).toBe("https://studio.example.com/mcp/virtual-mcp/vir_123");
  });
});

describe("mcpEndpointUrl task-run", () => {
  // The task-run surface is scoped by PATH, not by a tool argument — the per-run
  // key is minted with full access, so a threadId input would let one run act on
  // another run's sandbox.
  it("a task-run endpoint carries the run thread id in the path", () => {
    expect(
      mcpEndpointUrl({
        publicUrl,
        agentId: "vir_ignored",
        organization,
        target: "task-run",
        threadId: "thrd 1/2",
      }),
    ).toBe("https://studio.example.com/api/acme/mcp/task-run/thrd%201%2F2");
  });

  it("a task-run endpoint without a thread id throws before a key is minted", () => {
    expect(() =>
      mcpEndpointUrl({
        publicUrl,
        agentId: "vir_1",
        organization,
        target: "task-run",
      }),
    ).toThrow(/threadId is required/);
  });
});

describe("orgMcpServers", () => {
  const headers = { Authorization: "Bearer k" };
  const servers = (
    connections: { id: string; title?: string | null; slug?: string | null }[],
  ) =>
    orgMcpServers({
      publicUrl,
      organizationSlug: "acme",
      headers,
      connections,
    });

  it("points each connection at the org-scoped proxy, with the run's key", () => {
    expect(servers([{ id: "conn_1", slug: "linear" }])).toEqual([
      {
        name: "linear",
        url: "https://studio.example.com/api/acme/mcp/conn_1",
        headers,
      },
    ]);
  });

  it("sanitizes a title into a name a client accepts", () => {
    expect(servers([{ id: "c", title: "Google Drive!" }])[0]?.name).toBe(
      "google-drive",
    );
  });

  it("prefers the slug over the title", () => {
    expect(
      servers([{ id: "c", slug: "gdrive", title: "Drive" }])[0]?.name,
    ).toBe("gdrive");
  });

  it("dedupes names so same-titled connections stay distinct servers", () => {
    expect(
      servers([
        { id: "c1", title: "Notion" },
        { id: "c2", title: "notion" },
        { id: "c3", title: "NOTION" },
      ]).map((server) => server.name),
    ).toEqual(["notion", "notion-2", "notion-3"]);
  });

  it("falls back to a usable name when there is nothing to derive one from", () => {
    expect(
      servers([{ id: "c1", title: "///" }, { id: "c2" }]).map((s) => s.name),
    ).toEqual(["mcp", "mcp-2"]);
  });

  it("url-encodes the connection id", () => {
    expect(servers([{ id: "a/b", title: "x" }])[0]?.url).toBe(
      "https://studio.example.com/api/acme/mcp/a%2Fb",
    );
  });
});

describe("runKeyPermissions", () => {
  const permissions = (grants: Record<string, string[]>) =>
    runKeyPermissions({ toolNames: ["TASK_BOARD_ITEM_UPDATE"], grants });

  it("names every mounted connection as its own resource", () => {
    // The regression this pins: a proxied call is authorized as
    // `{ <connectionId>: [<toolName>] }`, so a key that names only `self`
    // denies every org-MCP tool the run has.
    expect(permissions({ conn_1: ["*"], conn_2: ["READ"] })).toEqual({
      self: ["TASK_BOARD_ITEM_UPDATE"],
      conn_1: ["*"],
      conn_2: ["READ"],
    });
  });

  it("grants no wildcard resource — the key is not full access", () => {
    expect(permissions({ conn_1: ["*"] })["*"]).toBeUndefined();
  });

  it("is just the tool scope when the run mounts no connections", () => {
    expect(permissions({})).toEqual({ self: ["TASK_BOARD_ITEM_UPDATE"] });
  });
});
