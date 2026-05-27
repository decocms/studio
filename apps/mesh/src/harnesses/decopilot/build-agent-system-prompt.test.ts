import { describe, expect, test } from "bun:test";
import { buildAgentSystemPrompt } from "./build-agent-system-prompt";

const mockAgentList = [
  {
    id: "vir_other",
    title: "Other Agent",
    description: "A sibling agent",
    status: "active" as const,
    organization_id: "org_test",
  },
];

const baseOpts = {
  ctx: {
    storage: { virtualMcps: { list: async () => mockAgentList } },
  } as never,
  organization: { id: "org_test" } as never,
  virtualMcp: { id: "vir_test", instructions: undefined } as never,
  agentInstructions: undefined,
  date: new Date("2026-05-26T00:00:00Z"),
};

describe("buildAgentSystemPrompt", () => {
  test("kind: 'agent' includes the agents block", async () => {
    const out = await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "agent",
      planMode: false,
    });
    const joined = JSON.stringify(out);
    expect(joined).toContain("available-agents");
  });

  test("kind: 'subagent' OMITS the agents block", async () => {
    const out = await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "subagent",
      planMode: false,
    });
    const joined = JSON.stringify(out);
    expect(joined).not.toContain("available-agents");
  });

  test("kind: 'subagent' uses the subagent identity prompt", async () => {
    const out = await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "subagent",
      planMode: false,
    });
    const joined = JSON.stringify(out);
    expect(joined).toContain("focused subtask agent");
    expect(joined).toContain("Rules (non-negotiable)");
  });

  test("kind: 'agent' uses the decopilot identity prompt", async () => {
    const out = await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "agent",
      planMode: false,
    });
    const joined = JSON.stringify(out);
    expect(joined).toContain("Decopilot");
  });

  test("planMode is ignored for kind: 'subagent'", async () => {
    const out = await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "subagent",
      planMode: true,
    });
    const joined = JSON.stringify(out);
    expect(joined).not.toContain("plan-mode");
  });

  test("agentInstructions are appended for both kinds", async () => {
    for (const kind of ["agent", "subagent"] as const) {
      const out = await buildAgentSystemPrompt({
        ...baseOpts,
        kind,
        planMode: false,
        agentInstructions: "ALWAYS USE THE SEARCH TOOL FIRST.",
      });
      const joined = JSON.stringify(out);
      expect(joined).toContain("ALWAYS USE THE SEARCH TOOL FIRST.");
    }
  });

  test("output is an array of system messages compatible with streamText", async () => {
    const out = await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "agent",
      planMode: false,
    });
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });
});
