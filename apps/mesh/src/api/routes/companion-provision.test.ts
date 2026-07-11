import { describe, expect, it } from "bun:test";
import { companionMcpUrl, isAdminRole } from "./companion-provision";

describe("companionMcpUrl", () => {
  it("builds the Decopilot virtual-MCP URL for an org", () => {
    expect(
      companionMcpUrl("https://studio.decocms.com", "acme", "org_123"),
    ).toBe(
      "https://studio.decocms.com/api/acme/mcp/virtual-mcp/decopilot_org_123",
    );
  });

  it("honors a non-default studio origin (self-hosted / dev)", () => {
    expect(companionMcpUrl("http://localhost:3000", "acme", "org_123")).toBe(
      "http://localhost:3000/api/acme/mcp/virtual-mcp/decopilot_org_123",
    );
  });

  it("preserves the org slug verbatim in the path", () => {
    expect(
      companionMcpUrl("https://studio.decocms.com", "my-team", "org_abc"),
    ).toBe(
      "https://studio.decocms.com/api/my-team/mcp/virtual-mcp/decopilot_org_abc",
    );
  });
});

describe("isAdminRole", () => {
  it("grants for built-in admin roles", () => {
    expect(isAdminRole("owner")).toBe(true);
    expect(isAdminRole("admin")).toBe(true);
  });

  it("denies the plain member role and custom roles", () => {
    expect(isAdminRole("user")).toBe(false);
    expect(isAdminRole("billing-viewer")).toBe(false);
  });

  it("grants when any of several roles is admin", () => {
    expect(isAdminRole("user,admin")).toBe(true);
    expect(isAdminRole("billing-viewer, owner")).toBe(true);
  });

  it("denies empty / missing role (safe default)", () => {
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole("")).toBe(false);
  });
});
