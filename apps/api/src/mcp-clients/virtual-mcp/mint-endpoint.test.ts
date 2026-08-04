import { describe, expect, it } from "bun:test";
import { MissingOrganizationSlugError, mcpEndpointUrl } from "./mint-endpoint";

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
