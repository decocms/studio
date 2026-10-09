import { describe, expect, test } from "bun:test";
import { harnessStreamInputSchema } from "@decocms/sandbox/dispatch/schemas";
import { modeInstruction, sandboxRunPrompt } from "./sandbox-run-prompt";

describe("modeInstruction", () => {
  test("each tool pill names its studio tool", () => {
    expect(modeInstruction("gen-image")).toContain("`generate_image`");
    expect(modeInstruction("web-search")).toContain("`web_search`");
    expect(modeInstruction("deep-research")).toContain("`deep_research`");
    expect(modeInstruction("gen-image")).toContain("`studio` MCP server");
  });

  test("default and plan add no line", () => {
    expect(modeInstruction("default")).toBeNull();
    expect(modeInstruction("plan")).toBeNull();
  });

  test("every mode a tool pill sends is accepted on the dispatch wire", () => {
    const modes = harnessStreamInputSchema.shape.mode.options;
    for (const mode of ["gen-image", "web-search", "deep-research"] as const) {
      expect(modes).toContain(mode);
    }
  });
});

describe("sandboxRunPrompt", () => {
  const base = {
    mode: "default" as const,
    threadId: "thread-now",
    agentId: "agent-self",
    userEmail: "person@example.com",
  };

  test("renders interests, recent threads and sibling agents", () => {
    const prompt = sandboxRunPrompt({
      ...base,
      userContext: {
        interests: [{ title: "Launch v2", summary: "Ship the new checkout" }],
        recentThreads: {
          total: 2,
          threads: [
            {
              id: "thread-now",
              title: "This chat",
              updated_at: "2026-10-06T00:00:00Z",
            },
            {
              id: "thread-old",
              title: "Pricing page copy",
              updated_at: "2026-10-01T00:00:00Z",
            },
          ],
        },
        agents: [
          {
            id: "agent-self",
            name: "Me",
            description: null,
            status: "active",
          },
          {
            id: "agent-sales",
            name: "Sales",
            description: "Answers pricing",
            status: "active",
          },
          {
            id: "agent-off",
            name: "Retired",
            description: null,
            status: "inactive",
          },
        ],
      },
    });
    expect(prompt).toContain("person@example.com");
    expect(prompt).toContain("Launch v2: Ship the new checkout");
    expect(prompt).toContain('"Pricing page copy"');
    expect(prompt).not.toContain('"This chat"');
    expect(prompt).toContain("agent-sales,Sales,Answers pricing");
    expect(prompt).not.toContain("agent-self");
    expect(prompt).not.toContain("agent-off");
  });

  test("appends the mode line", () => {
    const prompt = sandboxRunPrompt({
      ...base,
      mode: "web-search",
      userContext: {},
    });
    expect(prompt).toContain("`web_search`");
  });

  test("is empty when there is nothing to say", () => {
    expect(
      sandboxRunPrompt({ ...base, userEmail: undefined, userContext: {} }),
    ).toBe("");
  });
});
