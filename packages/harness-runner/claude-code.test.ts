import { describe, expect, test } from "bun:test";
import type { HarnessStreamInputWire } from "@decocms/sandbox/dispatch/schemas";
import { buildOptions, promptFromUserMessage } from "./claude-code";

/** A minimal valid wire input; each test overrides what it cares about. */
function input(
  overrides: Partial<HarnessStreamInputWire> = {},
): HarnessStreamInputWire {
  return {
    threadId: "thrd_1",
    userMessage: { parts: [{ type: "text", text: "hi" }] },
    harness: {},
    workspace: { cwd: null },
    models: {
      thinking: { id: "m", title: "M", credentialId: "c" },
    },
    mcp: { url: "", headers: {}, expiresAt: 1 },
    mode: "default",
    temperature: 0,
    toolApprovalLevel: "auto",
    user: { id: "u", email: "e@x.com" },
    organizationId: "org_1",
    agent: { id: "agent_1" },
    ...overrides,
  } as HarnessStreamInputWire;
}

function options(overrides: Partial<HarnessStreamInputWire> = {}) {
  return buildOptions({
    input: input(overrides),
    sessionId: "11111111-1111-5111-8111-111111111111",
    resume: false,
    abortController: new AbortController(),
  });
}

describe("promptFromUserMessage", () => {
  test("joins the text parts of a UI message", () => {
    expect(
      promptFromUserMessage({
        parts: [
          { type: "text", text: "a" },
          { type: "file", url: "x" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
  });

  test("falls back to string content when there are no text parts", () => {
    expect(promptFromUserMessage({ content: "plain" })).toBe("plain");
    expect(promptFromUserMessage({ parts: [], content: "plain" })).toBe(
      "plain",
    );
  });

  test("returns empty string for shapes it cannot read", () => {
    expect(promptFromUserMessage(null)).toBe("");
    expect(promptFromUserMessage("nope")).toBe("");
    expect(promptFromUserMessage({})).toBe("");
    expect(promptFromUserMessage({ parts: [{ type: "file" }] })).toBe("");
  });
});

describe("buildOptions", () => {
  test("bypasses permissions — the pod is the isolation boundary", () => {
    expect(options().permissionMode).toBe("bypassPermissions");
  });

  test("keeps Claude Code's own prompt and appends the agent instructions", () => {
    const withInstructions = options({
      agent: { id: "a", instructions: "Be terse." },
    });
    expect(withInstructions.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Be terse.",
    });
  });

  test("omits append when the agent has no instructions", () => {
    expect(options().systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
    });
  });

  test("runs in the repo checkout when the workspace has one", () => {
    const opts = options({
      workspace: {
        cwd: "/app/repo",
        repo: { owner: "o", name: "n", connectedGithub: true },
        branch: null,
      },
    });
    expect(opts.cwd).toBe("/app/repo");
  });

  test("omits cwd for a repo-less run rather than passing null", () => {
    expect("cwd" in options()).toBe(false);
  });

  test("seeds a new session id, and resumes that same id on later turns", () => {
    const fresh = buildOptions({
      input: input(),
      sessionId: "sid",
      resume: false,
      abortController: new AbortController(),
    });
    expect(fresh.sessionId).toBe("sid");
    expect(fresh.resume).toBeUndefined();

    const resumed = buildOptions({
      input: input(),
      sessionId: "sid",
      resume: true,
      abortController: new AbortController(),
    });
    expect(resumed.resume).toBe("sid");
    expect(resumed.sessionId).toBeUndefined();
  });

  test("hands the run's credential to the CLI, alongside the inherited env", () => {
    const opts = buildOptions({
      input: input(),
      sessionId: "sid",
      resume: false,
      abortController: new AbortController(),
      runEnv: { ANTHROPIC_API_KEY: "sk-run" },
    });
    // Without this the SDK spawns the CLI with no credential at all, which
    // surfaces as "Not logged in · Please run /login".
    expect(opts.env?.ANTHROPIC_API_KEY).toBe("sk-run");
    // `Options.env` REPLACES the subprocess env, so PATH has to survive.
    expect(opts.env?.PATH).toBe(process.env.PATH);
  });

  test("the run's env wins over this process's", () => {
    process.env.CLAUDE_CODE_MODEL = "from-process";
    try {
      expect(options().model).toBe("from-process");
      const opts = buildOptions({
        input: input(),
        sessionId: "sid",
        resume: false,
        abortController: new AbortController(),
        runEnv: { CLAUDE_CODE_MODEL: "from-run" },
      });
      expect(opts.model).toBe("from-run");
    } finally {
      delete process.env.CLAUDE_CODE_MODEL;
    }
  });

  test("mounts the run's Studio MCP endpoint with its headers", () => {
    const opts = options({
      mcp: {
        url: "https://studio.example/mcp/virtual-mcp/agent_1",
        headers: { Authorization: "Bearer k", "x-org-id": "org_1" },
        expiresAt: 123,
      },
    });
    expect(opts.mcpServers).toEqual({
      studio: {
        type: "http",
        url: "https://studio.example/mcp/virtual-mcp/agent_1",
        headers: { Authorization: "Bearer k", "x-org-id": "org_1" },
      },
    });
  });

  test("mounts no MCP server when the endpoint is the empty sentinel", () => {
    // Decopilot's in-process runs carry `mcp.url === ""`; a server pointing at
    // an empty URL would fail the SDK's startup connect.
    expect(options().mcpServers).toBeUndefined();
  });
});
