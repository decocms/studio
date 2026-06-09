import { describe, expect, it } from "bun:test";
import {
  createAgentPrepareStep,
  reconstructEnabledTools,
} from "./agent-loop-state";

describe("reconstructEnabledTools", () => {
  it("restores enabled tools from prior enable_tool results and normalizes old names", () => {
    const enabled = reconstructEnabledTools(
      [
        {
          role: "assistant",
          parts: [
            {
              toolName: "enable_tool",
              result: { enabled: ["github-search", "already_safe"] },
            },
          ],
        },
      ],
      new Set(["github_search", "already_safe"]),
    );

    expect([...enabled].sort()).toEqual(["already_safe", "github_search"]);
  });
});

describe("createAgentPrepareStep", () => {
  it("keeps built-ins and read-only enabled tools in plan mode", () => {
    const prepareStep = createAgentPrepareStep({
      modeConfig: { isPlanMode: true },
      streamTools: {
        todo_write: {} as never,
        readonly_search: {} as never,
        write_file: {} as never,
        enable_tool: {} as never,
      } as never,
      builtInToolNames: ["todo_write"],
      enabledTools: new Set(["readonly_search", "write_file"]),
      toolAnnotations: new Map([
        ["readonly_search", { readOnlyHint: true }],
        ["write_file", { readOnlyHint: false }],
      ]),
      pendingImages: [],
      hasEnableTool: true,
    });

    const result = prepareStep({ messages: [{ role: "user", content: "hi" }] });

    expect(result.activeTools).toEqual([
      "todo_write",
      "enable_tool",
      "readonly_search",
    ]);
  });
});
