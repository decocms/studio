import { describe, expect, test } from "bun:test";
import { buildDesktopPrompt } from "./desktop-prompt";

describe("buildDesktopPrompt", () => {
  test("includes shared coding workspace context", () => {
    const prompt = buildDesktopPrompt({
      agentId: "vir_test",
      isDecopilotAgent: false,
      connectionsBlockTools: [],
      connectionTitleMap: new Map(),
      agentInstructions: "Use the repo carefully.",
      codingWorkspace: {
        repo: {
          owner: "deco",
          name: "site",
          connectedGithub: true,
        },
        branch: "main",
        cwd: "/repo",
        workspaceKind: "github",
      },
    });

    const joined = prompt.systemMessages.map((m) => m.content).join("\n\n");
    expect(joined).toContain("<coding-workspace>");
    expect(joined).toContain("Repository: deco/site");
    expect(joined).toContain("Use the repo carefully.");
  });
});
