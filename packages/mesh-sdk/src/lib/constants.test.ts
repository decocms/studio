import { describe, expect, test } from "bun:test";
import { StudioPackAgentId, isStudioPackAgent } from "./constants";

describe("StudioPackAgentId", () => {
  test("generates the Store Manager id with the org suffix", () => {
    expect(StudioPackAgentId.STORE_MANAGER("org_xyz")).toBe(
      "studio-store-manager_org_xyz",
    );
  });
});

describe("isStudioPackAgent", () => {
  test("recognises every studio-pack manager id, including the new store-manager", () => {
    expect(isStudioPackAgent("studio-agent-manager_org_xyz")).toBe(true);
    expect(isStudioPackAgent("studio-automation-manager_org_xyz")).toBe(true);
    expect(isStudioPackAgent("studio-connection-manager_org_xyz")).toBe(true);
    expect(isStudioPackAgent("studio-store-manager_org_xyz")).toBe(true);
  });

  test("rejects unrelated ids", () => {
    expect(isStudioPackAgent(null)).toBe(false);
    expect(isStudioPackAgent(undefined)).toBe(false);
    expect(isStudioPackAgent("vir_abc")).toBe(false);
    expect(isStudioPackAgent("decopilot_org_xyz")).toBe(false);
  });
});
