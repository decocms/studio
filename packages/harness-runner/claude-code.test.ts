import { describe, expect, test } from "bun:test";
import type { HarnessStreamInputWire } from "@decocms/sandbox/dispatch/schemas";
import {
  buildOptions,
  promptForRun,
  promptFromUserMessage,
} from "./claude-code";

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

describe("promptForRun", () => {
  const repoWorkspace = {
    cwd: "/repo",
    repo: { owner: "o", name: "n", connectedGithub: true },
    branch: "thread-42",
  } as HarnessStreamInputWire["workspace"];

  test("a first attempt gets the turn's message, nothing else", () => {
    expect(promptForRun(input())).toBe("hi");
  });

  test("a continuation appends where to look for the interrupted work", () => {
    const prompt = promptForRun(
      input({
        workspace: repoWorkspace,
        resume: { reason: "the sandbox was replaced" },
      }),
    );
    // The task itself must survive, and the continuation must come after it.
    expect(prompt.startsWith("hi")).toBe(true);
    expect(prompt).toContain("CONTINUING this task");
    expect(prompt).toContain("the sandbox was replaced");
    // git/gh, on this task's branch: the repo is the only state that outlives
    // the pod, so the prompt has to point at it.
    expect(prompt).toContain("git log");
    expect(prompt).toContain("gh pr list --head thread-42");
    // The two instructions a resumed autonomous run must not miss.
    expect(prompt).toContain("do not start the task over");
    expect(prompt).toContain("never open a second one");
  });

  test("a continuation with no checkout names no branch", () => {
    const prompt = promptForRun(
      input({ resume: { reason: "the studio pod restarted" } }),
    );
    expect(prompt).toContain("the studio pod restarted");
    expect(prompt).toContain("<branch>");
    expect(prompt).not.toContain("undefined");
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
    const prompt = withInstructions.systemPrompt as {
      type: string;
      preset: string;
      append: string;
    };
    expect(prompt.type).toBe("preset");
    expect(prompt.preset).toBe("claude_code");
    expect(prompt.append).toStartWith("Be terse.");
  });

  test("points skill authoring at the org-fs mount, instructions or not", () => {
    // Without this the model writes a reusable skill into the checkout, where it
    // dies with the branch instead of syncing to the org.
    for (const opts of [options(), options({ agent: { id: "a" } })]) {
      const { append } = opts.systemPrompt as { append: string };
      expect(append).toContain("/skills/");
      // The path is for WRITING only. Handing it out as a place to look sent the
      // model to Bash for a listing it already had in the prompt.
      expect(append).toContain("Never search the filesystem for skills");
    }
    expect(options().skills).toBe("all");
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
    });
    expect(fresh.sessionId).toBe("sid");
    expect(fresh.resume).toBeUndefined();

    const resumed = buildOptions({
      input: input(),
      sessionId: "sid",
      resume: true,
    });
    expect(resumed.resume).toBe("sid");
    expect(resumed.sessionId).toBeUndefined();
  });

  test("takes the model pin from this process's environment", () => {
    // Exec-per-run: the run's env IS this process's, so nothing is threaded
    // through the wire and `Options.env` is left unset — the SDK defaults it to
    // process.env, which is exactly the credential the CLI needs.
    process.env.CLAUDE_CODE_MODEL = "from-env";
    try {
      expect(options().model).toBe("from-env");
      expect(options().env).toBeUndefined();
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
