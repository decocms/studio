import { describe, expect, it } from "bun:test";
import { checkApiKeyPermission } from "./api-key-permissions";

describe("checkApiKeyPermission", () => {
  it("grants when the exact (resource, tool) is in the allowlist", () => {
    expect(
      checkApiKeyPermission(
        { self: ["ORGANIZATION_GET"] },
        { self: ["ORGANIZATION_GET"] },
      ),
    ).toBe(true);
  });

  it("denies a tool outside the allowlist (the escalation we block)", () => {
    expect(
      checkApiKeyPermission(
        { self: ["ORGANIZATION_GET"] },
        { self: ["API_KEY_CREATE"] },
      ),
    ).toBe(false);
  });

  it("denies when the resource is not granted at all", () => {
    expect(
      checkApiKeyPermission(
        { self: ["ORGANIZATION_GET"] },
        { conn_123: ["SEND_MESSAGE"] },
      ),
    ).toBe(false);
  });

  it("grants every tool for a resource with a wildcard", () => {
    expect(checkApiKeyPermission({ self: ["*"] }, { self: ["ANYTHING"] })).toBe(
      true,
    );
  });

  it("honors a wildcard `*` resource granting all tools (full key)", () => {
    expect(
      checkApiKeyPermission({ "*": ["*"] }, { conn_9: ["SEND_MESSAGE"] }),
    ).toBe(true);
    expect(checkApiKeyPermission({ "*": ["*"] }, { self: ["ANYTHING"] })).toBe(
      true,
    );
  });

  it("denies everything for an empty / absent allowlist (fail-closed)", () => {
    expect(checkApiKeyPermission({}, { self: ["ORGANIZATION_GET"] })).toBe(
      false,
    );
  });

  it("requires ALL requested tools to be covered", () => {
    expect(
      checkApiKeyPermission(
        { self: ["ORGANIZATION_GET"] },
        { self: ["ORGANIZATION_GET", "API_KEY_CREATE"] },
      ),
    ).toBe(false);
  });
});
