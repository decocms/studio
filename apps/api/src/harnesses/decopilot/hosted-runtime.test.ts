import { describe, expect, test } from "bun:test";
import { isHostedDecopilotRuntime } from "./hosted-runtime";

describe("isHostedDecopilotRuntime", () => {
  test("classifies only the exact Decopilot + agent-sandbox tuple as hosted", () => {
    const cases: Array<{
      harnessId: string | null;
      sandboxProviderKind: string | null;
      expected: boolean;
    }> = [
      {
        harnessId: "decopilot",
        sandboxProviderKind: "agent-sandbox",
        expected: true,
      },
      {
        harnessId: "decopilot",
        sandboxProviderKind: null,
        expected: false,
      },
      {
        harnessId: null,
        sandboxProviderKind: "agent-sandbox",
        expected: false,
      },
      { harnessId: null, sandboxProviderKind: null, expected: false },
      {
        harnessId: "decopilot",
        sandboxProviderKind: "user-desktop",
        expected: false,
      },
      {
        harnessId: "codex",
        sandboxProviderKind: "agent-sandbox",
        expected: false,
      },
      {
        harnessId: "future",
        sandboxProviderKind: "future-sandbox",
        expected: false,
      },
    ];

    for (const { expected, ...runtime } of cases) {
      expect(isHostedDecopilotRuntime(runtime)).toBe(expected);
    }
  });
});
