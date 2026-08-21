import { describe, expect, test } from "bun:test";
import {
  StudioPackAgentId,
  getWellKnownReportVirtualMCP,
  isStudioPackAgent,
} from "./constants";

describe("StudioPackAgentId", () => {
  test("generates org-scoped manager ids", () => {
    expect(StudioPackAgentId.API_KEY_MANAGER("org_xyz")).toBe(
      "studio-api-key-manager_org_xyz",
    );
  });
});

describe("isStudioPackAgent", () => {
  test("recognises every studio-pack manager id", () => {
    expect(isStudioPackAgent("studio-agent-manager_org_xyz")).toBe(true);
    expect(isStudioPackAgent("studio-automation-manager_org_xyz")).toBe(true);
    expect(isStudioPackAgent("studio-connection-manager_org_xyz")).toBe(true);
    expect(isStudioPackAgent("studio-api-key-manager_org_xyz")).toBe(true);
    expect(isStudioPackAgent("studio-store-manager_org_xyz")).toBe(true);
    expect(isStudioPackAgent("studio-brand-manager_org_xyz")).toBe(true);
    expect(isStudioPackAgent("studio-usage-manager_org_xyz")).toBe(true);
  });

  test("rejects unrelated ids", () => {
    expect(isStudioPackAgent(null)).toBe(false);
    expect(isStudioPackAgent(undefined)).toBe(false);
    expect(isStudioPackAgent("vir_abc")).toBe(false);
    // Retired: its tools are Super Agent built-ins now.
    expect(isStudioPackAgent("studio-task-manager_org_xyz")).toBe(false);
    expect(isStudioPackAgent("decopilot_org_xyz")).toBe(false);
  });
});

describe("getWellKnownReportVirtualMCP", () => {
  test("pins the Commerce Discovery agent to the org sidebar", () => {
    expect(getWellKnownReportVirtualMCP("org_xyz", "conn_xyz").pinned).toBe(
      true,
    );
  });
});
