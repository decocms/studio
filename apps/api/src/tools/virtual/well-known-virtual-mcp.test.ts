import { describe, expect, test } from "bun:test";
import { getBrandContextSetupId, getDecopilotId } from "@decocms/shared/sdk";
import { isUndeletableWellKnownVirtualMcp } from "./well-known-virtual-mcp";

describe("isUndeletableWellKnownVirtualMcp", () => {
  test("flags the Super Agent (decopilot) id for any org", () => {
    expect(isUndeletableWellKnownVirtualMcp(getDecopilotId("org_123"))).toBe(
      true,
    );
  });

  test("flags the brand-context-setup id for any org", () => {
    expect(
      isUndeletableWellKnownVirtualMcp(getBrandContextSetupId("org_123")),
    ).toBe(true);
  });

  test("does not flag a normal virtual MCP id", () => {
    expect(isUndeletableWellKnownVirtualMcp("conn_abc123")).toBe(false);
  });
});
