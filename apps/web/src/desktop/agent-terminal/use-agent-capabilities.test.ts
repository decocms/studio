import { describe, expect, test } from "bun:test";
import { parseAgentCapabilities } from "./use-agent-capabilities";

describe("parseAgentCapabilities", () => {
  test("keeps known local terminal agents in server order", () => {
    expect(
      parseAgentCapabilities({ capabilities: ["codex", "claude-code"] }),
    ).toEqual(["codex", "claude-code"]);
  });

  test("drops unknown and malformed capability values", () => {
    expect(
      parseAgentCapabilities({
        capabilities: ["decopilot", "future", null, 1, "codex"],
      }),
    ).toEqual(["codex"]);
    expect(parseAgentCapabilities(null)).toEqual([]);
    expect(parseAgentCapabilities({ capabilities: "codex" })).toEqual([]);
  });
});
