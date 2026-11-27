import { describe, expect, it } from "bun:test";
import {
  automationHarnessError,
  automationRunHarness,
  parseAutomationHarnessId,
} from "./run-harness";

const TOOLS = ["reports_run_due"];

describe("automationRunHarness", () => {
  it("keeps today's choice for an automation that chose nothing", () => {
    for (const flagEnabled of [true, false]) {
      expect(
        automationRunHarness({
          chosen: null,
          toolAllowlist: TOOLS,
          sandboxAvailable: true,
          flagEnabled,
        }),
      ).toBe("claude-code");
      expect(
        automationRunHarness({
          chosen: null,
          toolAllowlist: TOOLS,
          sandboxAvailable: false,
          flagEnabled,
        }),
      ).toBe("decopilot");
    }
  });

  it("runs on Decopilot when the automation chose it, the flag is on and it has an allowlist", () => {
    expect(
      automationRunHarness({
        chosen: "decopilot",
        toolAllowlist: TOOLS,
        sandboxAvailable: true,
        flagEnabled: true,
      }),
    ).toBe("decopilot");
  });

  it("falls back to the sandbox when the org flag is off", () => {
    expect(
      automationRunHarness({
        chosen: "decopilot",
        toolAllowlist: TOOLS,
        sandboxAvailable: true,
        flagEnabled: false,
      }),
    ).toBe("claude-code");
  });

  it("falls back to the sandbox without an allowlist, where a file tool could start a pod", () => {
    for (const toolAllowlist of [null, []]) {
      expect(
        automationRunHarness({
          chosen: "decopilot",
          toolAllowlist,
          sandboxAvailable: true,
          flagEnabled: true,
        }),
      ).toBe("claude-code");
    }
  });

  it("falls back to the sandbox when the allowlist names a file tool", () => {
    expect(
      automationRunHarness({
        chosen: "decopilot",
        toolAllowlist: [...TOOLS, "bash"],
        sandboxAvailable: true,
        flagEnabled: true,
      }),
    ).toBe("claude-code");
  });

  it("is Decopilot on a deployment without sandboxes, whatever was chosen", () => {
    expect(
      automationRunHarness({
        chosen: "decopilot",
        toolAllowlist: null,
        sandboxAvailable: false,
        flagEnabled: false,
      }),
    ).toBe("decopilot");
  });
});

describe("parseAutomationHarnessId", () => {
  it("reads the one harness an automation may choose", () => {
    expect(parseAutomationHarnessId("decopilot")).toBe("decopilot");
  });

  it("reads anything else as no choice", () => {
    for (const value of [null, undefined, "", "claude-code", "codex", 1, {}]) {
      expect(parseAutomationHarnessId(value)).toBeNull();
    }
  });
});

describe("automationHarnessError", () => {
  it("always lets an automation go back to the default", () => {
    expect(
      automationHarnessError({
        chosen: null,
        toolAllowlist: null,
        flagEnabled: false,
      }),
    ).toBeNull();
  });

  it("refuses Decopilot while the org flag is off", () => {
    expect(
      automationHarnessError({
        chosen: "decopilot",
        toolAllowlist: TOOLS,
        flagEnabled: false,
      }),
    ).toContain("automation_harness_decopilot");
  });

  it("refuses Decopilot without an allowlist", () => {
    for (const toolAllowlist of [null, []]) {
      expect(
        automationHarnessError({
          chosen: "decopilot",
          toolAllowlist,
          flagEnabled: true,
        }),
      ).toContain("tools");
    }
  });

  it("refuses Decopilot with a file tool in the allowlist, naming it", () => {
    for (const tool of [
      "read",
      "write",
      "edit",
      "grep",
      "glob",
      "bash",
      "skill",
    ]) {
      expect(
        automationHarnessError({
          chosen: "decopilot",
          toolAllowlist: [...TOOLS, tool],
          flagEnabled: true,
        }),
      ).toContain(tool);
    }
  });

  it("accepts Decopilot with the flag on and an allowlist", () => {
    expect(
      automationHarnessError({
        chosen: "decopilot",
        toolAllowlist: TOOLS,
        flagEnabled: true,
      }),
    ).toBeNull();
  });
});
