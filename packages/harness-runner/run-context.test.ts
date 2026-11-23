import { describe, expect, test } from "bun:test";
import {
  HARNESS_RUN_CONTEXT_MAX_BYTES,
  harnessRunContextSchema,
} from "@decocms/sandbox/dispatch/schemas";
import manifest from "./package.json" with { type: "json" };
import {
  buildRunContext,
  capRunContext,
  readToolState,
  RUN_CONTEXT_MAX_BYTES,
  type RunContext,
} from "./run-context";

/** An `init` as the CLI sends it, with the fields a context must never carry. */
const init = {
  type: "system",
  subtype: "init",
  cwd: "/app/repo",
  session_id: "11111111-2222-3333-4444-555555555555",
  tools: ["Bash", "Read", "ToolSearch", "mcp__studio__TASK_ADD_REPO"],
  mcp_servers: [{ name: "studio", status: "pending", source: "dynamic" }],
  model: "claude-sonnet-5-5",
  permissionMode: "bypassPermissions",
  claude_code_version: "2.1.280",
  agents: ["general-purpose", "Explore"],
  skills: [
    "org-skill-a",
    "repo-skill",
    "deep-research",
    "shared-set:plugin-skill",
    "dataviz",
  ],
  plugins: [{ name: "shared-set", path: "/opt/plugins/shared-set" }],
  memory_paths: { auto: "/app/org/home/members/member_example/memory/" },
};

const run = { effort: "medium", memory: true, systemPromptAppendChars: 1234 };

const state = {
  mcpServers: [{ name: "studio", status: "connected", config: { url: "x" } }],
  mcpTools: [
    { name: "mcp__studio__TASK_ADD_REPO", isLoaded: true },
    { name: "mcp__studio__web_search", isLoaded: false },
    { name: "mcp__studio__deep_research", isLoaded: false },
  ],
  skillSources: [
    { name: "org-skill-a", source: "userSettings" },
    { name: "repo-skill", source: "projectSettings" },
    { name: "shared-set:plugin-skill", source: "plugin" },
    { name: "dataviz", source: "built-in" },
  ],
};

describe("buildRunContext", () => {
  test("records what the run was given, by name and count", () => {
    expect(
      buildRunContext(init, run, state, {
        STUDIO_SANDBOX_IMAGE_VERSION: "1.108.1",
      }),
    ).toEqual({
      runner: { version: manifest.version, image: "1.108.1", cli: "2.1.280" },
      model: "claude-sonnet-5-5",
      effort: "medium",
      permissionMode: "bypassPermissions",
      tools: {
        count: 4,
        names: ["Bash", "Read", "ToolSearch", "mcp__studio__TASK_ADD_REPO"],
      },
      deferredTools: {
        count: 2,
        names: ["mcp__studio__web_search", "mcp__studio__deep_research"],
      },
      skills: {
        count: 5,
        org: 2,
        names: ["deep-research", "shared-set:plugin-skill", "dataviz"],
      },
      mcpServers: {
        count: 1,
        servers: [{ name: "studio", status: "connected" }],
      },
      agents: { count: 2, names: ["general-purpose", "Explore"] },
      memory: true,
      systemPromptAppendChars: 1234,
    });
  });

  test("carries no path, id or server config from the SDK's messages", () => {
    const json = JSON.stringify(buildRunContext(init, run, state, {}));
    for (const leak of [
      init.cwd,
      init.session_id,
      "member_example",
      "/opt/plugins",
      '"url"',
    ]) {
      expect(json).not.toContain(leak);
    }
  });

  test("from init alone: no deferred list, and only a plugin's skills are named", () => {
    const context = buildRunContext(init, run, {}, {});
    expect(context.runner).toEqual({
      version: manifest.version,
      cli: "2.1.280",
    });
    expect(context.deferredTools).toBeUndefined();
    expect(context.tools.names).toEqual(init.tools);
    expect(context.skills).toEqual({
      count: 5,
      names: ["shared-set:plugin-skill"],
    });
    expect(context.mcpServers.servers).toEqual([
      { name: "studio", status: "pending" },
    ]);
  });

  test("a skill that only looks namespaced is not named without the CLI's sources", () => {
    const context = buildRunContext(
      { skills: ["team:secret-plan"], plugins: [] },
      run,
      {},
      {},
    );
    expect(context.skills).toEqual({ count: 1, names: [] });
  });

  test("takes the effort init reports, and none when init says none is sent", () => {
    expect(buildRunContext({ effort: "high" }, run, {}, {}).effort).toBe(
      "high",
    );
    expect(
      buildRunContext({ effort: null }, run, {}, {}).effort,
    ).toBeUndefined();
  });

  test("leaves memory out when Studio sent no setting", () => {
    const context = buildRunContext(init, { ...run, memory: undefined }, {});
    expect("memory" in context).toBe(false);
  });

  test("an init with nothing but its type still yields a valid context", () => {
    const context = buildRunContext({}, run, {}, {});
    expect(context.tools).toEqual({ count: 0, names: [] });
    expect(harnessRunContextSchema.safeParse(context).success).toBe(true);
  });

  test("clips a name longer than Studio accepts, so the context is not dropped over it", () => {
    const long = "x".repeat(400);
    const context = buildRunContext(
      {
        tools: [long],
        skills: [long],
        agents: [long],
        model: long,
        mcp_servers: [{ name: long, status: "connected" }],
      },
      run,
      { mcpTools: [{ name: `mcp__${long}`, isLoaded: false }] },
      { STUDIO_SANDBOX_IMAGE_VERSION: long },
    );
    expect(context.tools.names?.[0]).toHaveLength(256);
    expect(harnessRunContextSchema.safeParse(context).success).toBe(true);
  });

  test("what it builds is what Studio's schema accepts", () => {
    const context = buildRunContext(init, run, state, {});
    expect(harnessRunContextSchema.safeParse(context).success).toBe(true);
    expect(RUN_CONTEXT_MAX_BYTES).toBe(HARNESS_RUN_CONTEXT_MAX_BYTES);
  });
});

describe("capRunContext", () => {
  const names = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${prefix}_${i}`);
  const sized = (lists: {
    tools: number;
    deferred: number;
    skills: number;
  }): RunContext => ({
    ...buildRunContext(init, run, state, {}),
    tools: { count: lists.tools, names: names("tool", lists.tools) },
    deferredTools: {
      count: lists.deferred,
      names: names("mcp__studio__TOOL", lists.deferred),
    },
    skills: {
      count: lists.skills,
      org: 0,
      names: names("skill", lists.skills),
    },
  });
  const size = (context: RunContext | null) =>
    new TextEncoder().encode(JSON.stringify(context)).length;

  test("a context under the cap is returned as built", () => {
    const context = buildRunContext(init, run, state, {});
    expect(capRunContext(context)).toBe(context);
  });

  test("drops the longest list first and keeps its count", () => {
    const capped = capRunContext(
      sized({ tools: 20, deferred: 220, skills: 30 }),
    );
    expect(capped?.truncated).toBe(true);
    expect(capped?.deferredTools).toEqual({ count: 220 });
    expect(capped?.tools.names).toHaveLength(20);
    expect(capped?.skills.names).toHaveLength(30);
    expect(size(capped)).toBeLessThanOrEqual(RUN_CONTEXT_MAX_BYTES);
  });

  test("keeps dropping, longest next, until it fits", () => {
    const capped = capRunContext(
      sized({ tools: 500, deferred: 400, skills: 30 }),
    );
    expect(capped?.deferredTools).toEqual({ count: 400 });
    expect(capped?.tools).toEqual({ count: 500 });
    expect(capped?.skills.names).toHaveLength(30);
    expect(capped?.agents.names).toEqual(["general-purpose", "Explore"]);
    expect(size(capped)).toBeLessThanOrEqual(RUN_CONTEXT_MAX_BYTES);
  });

  test("does not change the context it was given", () => {
    const context = sized({ tools: 20, deferred: 220, skills: 30 });
    capRunContext(context);
    expect(context.deferredTools?.names).toHaveLength(220);
    expect(context.truncated).toBeUndefined();
  });

  test("counts bytes, not characters", () => {
    const context = sized({ tools: 0, deferred: 0, skills: 0 });
    context.agents = { count: 1, names: ["é".repeat(1900)] };
    expect(JSON.stringify(context).length).toBeLessThan(RUN_CONTEXT_MAX_BYTES);
    expect(capRunContext(context)?.agents).toEqual({ count: 1 });
  });

  test("is null when no list is left to drop", () => {
    const context = buildRunContext(init, run, state, {});
    context.model = "m".repeat(RUN_CONTEXT_MAX_BYTES);
    expect(capRunContext(context)).toBeNull();
  });

  test("a truncated context is still what Studio's schema accepts", () => {
    const capped = capRunContext(
      sized({ tools: 500, deferred: 400, skills: 30 }),
    );
    expect(harnessRunContextSchema.safeParse(capped).success).toBe(true);
  });
});

describe("readToolState", () => {
  const usage = {
    mcpTools: state.mcpTools,
    skills: { skillFrontmatter: state.skillSources },
  };

  test("reads server status, MCP tools and skill sources", async () => {
    const requested: unknown[] = [];
    const read = await readToolState({
      mcpServerStatus: async () => state.mcpServers,
      getContextUsage: async (opts) => {
        requested.push(opts);
        return usage;
      },
    });
    expect(read).toEqual(state);
    // `full` costs a provider request per category.
    expect(requested).toEqual([{ detail: "summary" }]);
  });

  test("keeps the half that answered", async () => {
    const read = await readToolState({
      mcpServerStatus: async () => state.mcpServers,
      getContextUsage: async () => {
        throw new Error("Query closed before response received");
      },
    });
    expect(read).toEqual({ mcpServers: state.mcpServers });
  });

  test("gives up on a CLI that does not answer", async () => {
    const never = new Promise<never>(() => {});
    const startedAt = performance.now();
    const read = await readToolState(
      { mcpServerStatus: () => never, getContextUsage: () => never },
      20,
    );
    expect(read).toEqual({});
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test("an SDK stream without these requests yields nothing, not a throw", async () => {
    const stream = {} as Parameters<typeof readToolState>[0];
    expect(await readToolState(stream)).toEqual({});
  });
});
