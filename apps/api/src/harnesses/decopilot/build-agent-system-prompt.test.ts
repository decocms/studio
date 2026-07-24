import { describe, expect, test } from "bun:test";
import { buildAgentSystemPrompt } from "./build-agent-system-prompt";

const baseOpts = {
  ctx: {} as never,
  organization: { id: "org_test" } as never,
  virtualMcp: { id: "vir_test", instructions: undefined } as never,
  planMode: false,
  agentInstructions: undefined,
  date: new Date("2026-05-26T00:00:00Z"),
  userContext: {
    agents: [
      {
        id: "vir_other",
        name: "Other Agent",
        description: "A sibling agent",
        status: "active" as const,
      },
    ],
  },
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

  test("kind: 'agent' renders the user-context block from passed-in userContext", async () => {
    const out = await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "agent",
      planMode: false,
      user: { id: "u1", name: "Ada", email: "ada@example.com" },
      currentThreadId: "t-current",
      userContext: {
        ...baseOpts.userContext,
        interests: [{ title: "Ship harness", summary: "extract pkg" }],
      },
    });
    const joined = JSON.stringify(out);
    expect(joined).toContain("About this user");
    expect(joined).toContain("Ship harness");
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
      isDecopilot: true,
    });
    const joined = JSON.stringify(out);
    expect(joined).toContain("Super Agent");
  });

  test("includes shared coding workspace prompt while preserving Decopilot-only blocks", async () => {
    const systemMessages = await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "agent",
      isDecopilot: true,
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

    const joined = systemMessages.map((m) => m.content).join("\n\n");
    expect(joined).toContain("<coding-workspace>");
    expect(joined).toContain("Repository: deco/site");
    expect(joined).toContain("Branch: main");
    expect(joined).toContain("Working directory: /repo");
    expect(joined).toContain("<platform>");
    expect(joined).toContain("<todo-write>");
  });

  test("kind: 'agent' with isDecopilot: false omits decopilot identity prompt", async () => {
    const out = await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "agent",
      planMode: false,
      isDecopilot: false,
    });
    const joined = JSON.stringify(out);
    expect(joined).not.toContain("Super Agent");
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

  test("kind: 'subagent' includes connections block when connectionsData is provided", async () => {
    const out = await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "subagent",
      planMode: false,
      connectionsData: {
        tools: [
          {
            safeName: "test_tool",
            rawName: "test_tool",
            connectionId: "conn_1",
          } as never,
        ],
        connectionTitleMap: new Map([["conn_1", "Test Connection"]]),
      },
    });
    const joined = JSON.stringify(out);
    expect(joined).toContain("available-connections");
    expect(joined).toContain("Test Connection");
    expect(joined).toContain("test_tool");
  });

  test("kind: 'subagent' omits connections block when connectionsData is not provided", async () => {
    const out = await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "subagent",
      planMode: false,
      // no connectionsData
    });
    const joined = JSON.stringify(out);
    expect(joined).not.toContain("available-connections");
  });

  test("kind: 'subagent' includes prompts block when passthroughClient is provided", async () => {
    const mockClient = {
      listPrompts: async () => ({
        prompts: [
          {
            name: "my-prompt",
            description: "A test prompt",
            arguments: [{ name: "topic", required: true }],
          },
        ],
      }),
    } as never;
    const out = await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "subagent",
      planMode: false,
      passthroughClient: mockClient,
    });
    const joined = JSON.stringify(out);
    expect(joined).toContain("available-prompts");
    expect(joined).toContain("my-prompt");
  });

  const fakeOrgFs = (files: Record<string, string>) => {
    const writes: { path: string; body: string }[] = [];
    const fs = {
      writes,
      read: async (volume: string, path: string) => {
        if (volume !== "home" || !(path in files)) {
          throw new Error("not a live file");
        }
        return new TextEncoder().encode(files[path]);
      },
      stat: async (volume: string, path: string) =>
        volume === "home" && path in files ? { path } : null,
      write: async (
        _volume: string,
        path: string,
        body: string | Uint8Array,
      ) => {
        const text =
          typeof body === "string" ? body : new TextDecoder().decode(body);
        files[path] = text;
        writes.push({ path, body: text });
      },
    };
    return fs;
  };

  test("kind: 'agent' eager-loads org and user MEMORY.md blocks", async () => {
    const out = await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "agent",
      ctx: {
        orgFs: fakeOrgFs({
          "MEMORY.md": "Org uses Bun workspaces.",
          "users/u1/MEMORY.md": "Ada prefers terse replies.",
        }),
      } as never,
      organization: { id: "org_test", slug: "acme" } as never,
      user: { id: "u1", name: "Ada" },
    });
    const joined = JSON.stringify(out);
    expect(joined).toContain("persistent organization memory index");
    expect(joined).toContain("Org uses Bun workspaces.");
    expect(joined).toContain("persistent user memory index");
    expect(joined).toContain("Ada prefers terse replies.");
  });

  test("user memory omitted when no user is provided", async () => {
    const out = await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "agent",
      ctx: { orgFs: fakeOrgFs({ "MEMORY.md": "Org fact." }) } as never,
      organization: { id: "org_test", slug: "acme" } as never,
      // no user
    });
    const joined = JSON.stringify(out);
    expect(joined).toContain("persistent organization memory index");
    expect(joined).not.toContain("persistent user memory index");
  });

  test("kind: 'subagent' omits memory blocks", async () => {
    const out = await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "subagent",
      ctx: { orgFs: fakeOrgFs({ "MEMORY.md": "Org fact." }) } as never,
      organization: { id: "org_test", slug: "acme" } as never,
      user: { id: "u1" },
    });
    const joined = JSON.stringify(out);
    expect(joined).not.toContain("persistent organization memory index");
    expect(joined).not.toContain("persistent user memory index");
    expect(joined).not.toContain("Org fact.");
  });

  test("seeds default MEMORY.md templates on first load when absent", async () => {
    const fs = fakeOrgFs({}); // nothing exists yet
    const out = await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "agent",
      ctx: { orgFs: fs } as never,
      organization: { id: "org_test", slug: "acme" } as never,
      user: { id: "u1", name: "Ada" },
    });
    // Both files seeded with a raw template, attributed to the current user.
    const paths = fs.writes.map((w) => w.path).sort();
    expect(paths).toEqual(["MEMORY.md", "users/u1/MEMORY.md"]);
    expect(fs.writes.find((w) => w.path === "MEMORY.md")?.body).toContain(
      "# Organization memory",
    );
    expect(
      fs.writes.find((w) => w.path === "users/u1/MEMORY.md")?.body,
    ).toContain("# User memory");
    // Freshly seeded → nothing injected this session.
    const joined = JSON.stringify(out);
    expect(joined).not.toContain("persistent organization memory index");
    expect(joined).not.toContain("persistent user memory index");
  });

  test("does not overwrite an existing file on a transient read error", async () => {
    const fs = fakeOrgFs({ "MEMORY.md": "Real memory." });
    // Make read fail even though the file exists (transient error).
    fs.read = async () => {
      throw new Error("transient");
    };
    await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "agent",
      ctx: { orgFs: fs } as never,
      organization: { id: "org_test", slug: "acme" } as never,
      user: { id: "u1" },
    });
    // stat still reports the org file as present → no clobbering write for it.
    expect(fs.writes.map((w) => w.path)).not.toContain("MEMORY.md");
  });

  test("kind: 'subagent' omits prompts block when passthroughClient is not provided", async () => {
    const out = await buildAgentSystemPrompt({
      ...baseOpts,
      kind: "subagent",
      planMode: false,
      // no passthroughClient
    });
    const joined = JSON.stringify(out);
    expect(joined).not.toContain("available-prompts");
  });
});
