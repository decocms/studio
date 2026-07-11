import { describe, expect, it } from "bun:test";
import { companionMcpUrl, isAdminRole } from "./companion-provision";

describe("companionMcpUrl", () => {
  it("builds the org self/management MCP URL", () => {
    expect(companionMcpUrl("https://studio.decocms.com", "acme")).toBe(
      "https://studio.decocms.com/api/acme/mcp/self",
    );
  });

  it("honors a non-default studio origin (self-hosted / dev)", () => {
    expect(companionMcpUrl("http://localhost:3000", "acme")).toBe(
      "http://localhost:3000/api/acme/mcp/self",
    );
  });

  it("preserves the org slug verbatim in the path", () => {
    expect(companionMcpUrl("https://studio.decocms.com", "my-team")).toBe(
      "https://studio.decocms.com/api/my-team/mcp/self",
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
