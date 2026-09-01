import { describe, expect, test } from "bun:test";
import type { HarnessStreamInputWire } from "@decocms/sandbox/dispatch/schemas";
import {
  brokenStudioMcp,
  buildOptions,
  createDeltaCoalescer,
  errorFinishChunks,
  isTransientProviderRejection,
  mcpServersFor,
  promptForRun,
  promptFromUserMessage,
} from "./claude-code";
import { UiChunkTranslator } from "./to-ui-chunks";

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

describe("brokenStudioMcp", () => {
  const url = "https://studio.example/mcp";

  test("a connected server is usable", () => {
    expect(
      brokenStudioMcp([{ name: "studio", status: "connected" }], url),
    ).toBe(null);
  });

  test("pending is not broken — http servers connect asynchronously", () => {
    expect(brokenStudioMcp([{ name: "studio", status: "pending" }], url)).toBe(
      null,
    );
  });

  test("reports Studio's own server, not an org connection's", () => {
    // An org MCP (`orgMcps`) riding along on the same session can be down,
    // unauthorized or gone; that is a missing toolset, not a run to refuse.
    expect(
      brokenStudioMcp(
        [
          { name: "studio", status: "failed" },
          { name: "linear", status: "needs-auth" },
        ],
        url,
      ),
    ).toBe("studio=failed");
  });

  test("a broken org connection alone leaves the run usable", () => {
    expect(
      brokenStudioMcp(
        [
          { name: "studio", status: "connected" },
          { name: "linear", status: "failed" },
        ],
        url,
      ),
    ).toBe(null);
  });

  test("no MCP configured means nothing to wait for", () => {
    expect(brokenStudioMcp([{ name: "studio", status: "failed" }], "")).toBe(
      null,
    );
  });
});

describe("buildOptions", () => {
  test("asks the SDK for partial messages", () => {
    // Without this the SDK yields only complete assistant messages and a
    // paragraph reaches the UI as one frame after the model finished writing.
    expect(options().includePartialMessages).toBe(true);
  });

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

  test("carries the turn cap and tells the model its budget", () => {
    const prev = process.env.CLAUDE_CODE_MAX_TURNS;
    try {
      process.env.CLAUDE_CODE_MAX_TURNS = "60";
      const capped = options({ agent: { id: "a", instructions: "Review." } });
      expect(capped.maxTurns).toBe(60);
      expect((capped.systemPrompt as { append: string }).append).toContain(
        "at most 60 turns",
      );

      // A cap the model cannot see is a cap it walks into.
      for (const bad of ["", "0", "-1", "lots", "1.5"]) {
        process.env.CLAUDE_CODE_MAX_TURNS = bad;
        const uncapped = options({ agent: { id: "a", instructions: "Go." } });
        expect(uncapped.maxTurns).toBeUndefined();
        expect(
          (uncapped.systemPrompt as { append: string }).append,
        ).not.toContain("turns");
      }
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_MAX_TURNS;
      else process.env.CLAUDE_CODE_MAX_TURNS = prev;
    }
  });

  test("subtracts the dispatch's disallowed tools — that's what makes a reviewer read-only", () => {
    expect(options().disallowedTools).toBeUndefined();
    expect(
      options({ agent: { id: "a", disallowedTools: ["Write", "Edit"] } })
        .disallowedTools,
    ).toEqual(["Write", "Edit"]);
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

  test("loads the daemon's prefetched org skills as plugins, none when unset", () => {
    // The read-only shared sets used to be copied into the checkout's
    // `.claude/skills/` — the only dir the SDK scanned that was also writable —
    // and every git workaround downstream existed to hide them. A plugin dir is
    // out of the tree, so there is nothing to hide.
    expect("plugins" in options()).toBe(false);
    process.env.CLAUDE_CODE_PLUGIN_DIRS = "/app/orgfs-skills";
    try {
      expect(options().plugins).toEqual([
        { type: "local", path: "/app/orgfs-skills" },
      ]);
    } finally {
      delete process.env.CLAUDE_CODE_PLUGIN_DIRS;
    }
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
        alwaysLoad: true,
      },
    });
  });

  test("mounts no MCP server when the endpoint is the empty sentinel", () => {
    // Decopilot's in-process runs carry `mcp.url === ""`; a server pointing at
    // an empty URL would fail the SDK's startup connect.
    expect(options().mcpServers).toBeUndefined();
  });
});

describe("mcpServersFor", () => {
  const studio = {
    url: "https://studio.example/mcp/task-run/thrd_1",
    headers: { Authorization: "Bearer k" },
    expiresAt: 1,
  };

  test("mounts one server per org connection alongside Studio's", () => {
    expect(
      mcpServersFor(
        input({
          mcp: studio,
          orgMcps: [
            {
              name: "linear",
              url: "https://studio.example/api/acme/mcp/conn_1",
              headers: { Authorization: "Bearer k" },
            },
          ],
        }),
      ),
    ).toEqual({
      linear: {
        type: "http",
        url: "https://studio.example/api/acme/mcp/conn_1",
        headers: { Authorization: "Bearer k" },
      },
      studio: {
        type: "http",
        url: studio.url,
        headers: studio.headers,
        alwaysLoad: true,
      },
    });
  });

  test("org connections stay deferred; only Studio's own is always loaded", () => {
    // The whole reason an org can hand a run thirty connections: their tools
    // sit behind tool search instead of the turn-1 prompt. Studio's own cannot
    // — the board tools are how the run reports what it did.
    const servers = mcpServersFor(
      input({
        mcp: studio,
        orgMcps: [
          { name: "linear", url: "https://x.example/mcp", headers: {} },
        ],
      }),
    );
    expect(servers.linear).not.toHaveProperty("alwaysLoad");
    expect(servers.studio).toHaveProperty("alwaysLoad", true);
  });

  test("Studio's surface survives an org connection named `studio`", () => {
    const servers = mcpServersFor(
      input({
        mcp: studio,
        orgMcps: [
          { name: "studio", url: "https://elsewhere.example/mcp", headers: {} },
        ],
      }),
    );
    expect(servers.studio).toEqual({
      type: "http",
      url: studio.url,
      headers: studio.headers,
      alwaysLoad: true,
    });
  });

  test("org connections still mount when Studio's url is the empty sentinel", () => {
    expect(
      Object.keys(
        mcpServersFor(
          input({
            orgMcps: [
              { name: "linear", url: "https://x.example/mcp", headers: {} },
            ],
          }),
        ),
      ),
    ).toEqual(["linear"]);
  });
});

describe("isTransientProviderRejection", () => {
  test("matches OpenRouter's upstream relay on a server-side status", () => {
    expect(
      isTransientProviderRejection("API Error: 502 Provider returned error"),
    ).toBe(true);
    expect(
      isTransientProviderRejection("API Error: 529 Provider returned error"),
    ).toBe(true);
    expect(
      isTransientProviderRejection("API Error: 429 Provider returned error"),
    ).toBe(true);
  });

  // Inverts the previous "whatever the status" case: OpenRouter now flattens a
  // malformed request to the same relay wording, and fails over across its
  // upstreams before answering, so a 4xx is one every upstream refused.
  test("a 4xx relay is fatal — every upstream already refused it", () => {
    expect(
      isTransientProviderRejection("API Error: 400 Provider returned error"),
    ).toBe(false);
    expect(
      isTransientProviderRejection("API Error: 404 Provider returned error"),
    ).toBe(false);
  });

  test("an unparseable status keeps the benefit of the doubt", () => {
    expect(isTransientProviderRejection("Provider returned error")).toBe(true);
  });

  test("a 400 that describes the request stays fatal", () => {
    expect(
      isTransientProviderRejection(
        "API Error: 400 messages.0: text content blocks must be non-empty",
      ),
    ).toBe(false);
    expect(
      isTransientProviderRejection(
        "API Error: 400 max_tokens: must be less than or equal to 64000",
      ),
    ).toBe(false);
  });

  test("does not swallow the credit and session errors that have own paths", () => {
    expect(
      isTransientProviderRejection(
        "API Error: 402 requires more credits, requested up to 64000 tokens",
      ),
    ).toBe(false);
    expect(
      isTransientProviderRejection("Session ID abc is already in use"),
    ).toBe(false);
  });
});

describe("createDeltaCoalescer", () => {
  const delta = (id: string, text: string) => ({
    type: "text-delta",
    id,
    delta: text,
  });

  test("holds a short delta until something forces it out", () => {
    const c = createDeltaCoalescer(10);
    expect(c.push([delta("a", "hi")])).toEqual([]);
    expect(c.drain()).toEqual([delta("a", "hi")]);
    // Drained once; nothing left to emit twice.
    expect(c.drain()).toEqual([]);
  });

  test("concatenates same-block deltas and flushes at the threshold", () => {
    const c = createDeltaCoalescer(5);
    expect(c.push([delta("a", "ab")])).toEqual([]);
    expect(c.push([delta("a", "cd")])).toEqual([]);
    expect(c.push([delta("a", "ef")])).toEqual([delta("a", "abcdef")]);
    expect(c.drain()).toEqual([]);
  });

  test("a non-delta chunk flushes what is held, before itself", () => {
    const c = createDeltaCoalescer(100);
    // Ordering is the contract: text-end must never overtake its own text.
    expect(c.push([delta("a", "hi"), { type: "text-end", id: "a" }])).toEqual([
      delta("a", "hi"),
      { type: "text-end", id: "a" },
    ]);
  });

  test("a different block flushes the previous one rather than merging", () => {
    const c = createDeltaCoalescer(100);
    c.push([delta("a", "one")]);
    expect(c.push([delta("b", "two")])).toEqual([delta("a", "one")]);
    expect(c.drain()).toEqual([delta("b", "two")]);
  });

  test("reasoning and text deltas are not merged into each other", () => {
    const c = createDeltaCoalescer(100);
    c.push([{ type: "reasoning-delta", id: "a", delta: "think" }]);
    // Same id, different kind — merging would put reasoning into a text part.
    expect(c.push([delta("a", "say")])).toEqual([
      { type: "reasoning-delta", id: "a", delta: "think" },
    ]);
  });

  test("chunks that are not deltas pass through untouched", () => {
    const c = createDeltaCoalescer(100);
    const chunks = [
      { type: "text-start", id: "a" },
      { type: "tool-input-available", toolCallId: "t", toolName: "Bash" },
      { type: "finish-step" },
    ];
    expect(c.push(chunks)).toEqual(chunks);
  });

  test("a malformed delta is passed through, not swallowed", () => {
    const c = createDeltaCoalescer(100);
    // No `delta` string: not coalescable, but dropping it would lose output.
    const odd = { type: "text-delta", id: "a" };
    expect(c.push([odd])).toEqual([odd]);
  });

  test("discard drops what is held instead of emitting it", () => {
    const c = createDeltaCoalescer(100);
    c.push([delta("a", "abandoned")]);
    c.discard();
    expect(c.drain()).toEqual([]);
    // A later push starts clean, not merged into the discarded text.
    expect(c.push([delta("a", "fresh")])).toEqual([]);
    expect(c.drain()).toEqual([delta("a", "fresh")]);
  });
});

describe("errorFinishChunks", () => {
  test("closes a block stream_event left open before finish-step", () => {
    const translator = new UiChunkTranslator();
    translator.translate({
      type: "stream_event",
      event: { type: "message_start" },
    });
    translator.translate({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    });
    translator.translate({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hi" },
      },
    });
    // No `content_block_stop` — the SDK threw mid-block.
    expect(errorFinishChunks(translator)).toEqual([
      { type: "text-end", id: "stream-1" },
      { type: "finish-step" },
      { type: "finish", finishReason: "error" },
    ]);
  });

  test("nothing left open: just finish-step and finish", () => {
    const translator = new UiChunkTranslator();
    expect(errorFinishChunks(translator)).toEqual([
      { type: "finish-step" },
      { type: "finish", finishReason: "error" },
    ]);
  });
});
