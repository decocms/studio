/**
 * What a claude-code run was given, sent on its `finish` chunk as
 * `messageMetadata.context` so Studio stores it with the run's usage. Names and
 * counts only: no prompt text, no environment, no paths, no ids.
 *
 * The wire shape is `harnessRunContextSchema` in
 * `packages/sandbox/dispatch/schemas.ts`, restated here because this package is
 * installed into the sandbox image from a tarball and cannot import a
 * workspace module at runtime.
 */

import manifest from "./package.json" with { type: "json" };

/** `HARNESS_RUN_CONTEXT_MAX_BYTES` in the wire contract. */
export const RUN_CONTEXT_MAX_BYTES = 4096;

/** The longest string the wire contract accepts; a longer one is clipped so Studio keeps the context. */
const TEXT_MAX_CHARS = 256;

/** How long a finishing run waits for the CLI to describe its tools. */
const TOOL_STATE_WAIT_MS = 1_000;

/** Baked into the sandbox image at build time; unset anywhere else. */
const IMAGE_VERSION_ENV = "STUDIO_SANDBOX_IMAGE_VERSION";

interface CountedNames {
  count: number;
  names?: string[];
}

export interface RunContext {
  runner: { version: string; image?: string; cli?: string };
  model?: string;
  effort?: string;
  permissionMode?: string;
  tools: CountedNames;
  deferredTools?: CountedNames;
  skills: { count: number; org?: number; names?: string[] };
  mcpServers: { count: number; servers?: { name: string; status: string }[] };
  agents: CountedNames;
  memory?: boolean;
  systemPromptAppendChars: number;
  truncated?: true;
}

/** The fields of the SDK's `system`/`init` message a context is built from. */
export interface InitFacts {
  tools?: string[];
  skills?: string[];
  agents?: string[];
  mcp_servers?: { name: string; status: string }[];
  plugins?: { name: string }[];
  model?: string;
  permissionMode?: string;
  claude_code_version?: string;
  effort?: string | null;
}

/** What only the runner knows about the run. */
export interface RunFacts {
  /** The effort passed to the SDK, used when `init` does not report one. */
  effort: string;
  /** Undefined when Studio sent no memory setting and the CLI default applies. */
  memory: boolean | undefined;
  systemPromptAppendChars: number;
}

/**
 * What the CLI knows once its MCP servers had a turn to connect. `init` lists
 * an http server as `pending` with none of its tools, and never says which
 * tools are deferred or who owns a skill.
 */
export interface ToolState {
  mcpServers?: { name: string; status: string }[];
  mcpTools?: { name: string; isLoaded?: boolean }[];
  skillSources?: { name: string; source: string }[];
}

interface ToolStateSource {
  mcpServerStatus(): Promise<{ name: string; status: string }[]>;
  getContextUsage(opts: { detail: "summary" }): Promise<{
    mcpTools?: { name: string; isLoaded?: boolean }[];
    skills?: { skillFrontmatter?: { name: string; source: string }[] };
  }>;
}

/**
 * Ask the CLI for {@link ToolState}, giving up after `waitMs`. Never throws:
 * a session that already closed, or an SDK without these requests, yields `{}`
 * and the context is built from `init` alone. `summary` answers from local
 * estimates; `full` would count tokens with one provider request per category.
 */
export async function readToolState(
  source: ToolStateSource,
  waitMs = TOOL_STATE_WAIT_MS,
): Promise<ToolState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  try {
    const settled = await Promise.race([
      Promise.allSettled([
        source.mcpServerStatus(),
        source.getContextUsage({ detail: "summary" }),
      ]),
      timeout,
    ]);
    if (!settled) return {};
    const [servers, usage] = settled;
    return {
      ...(servers.status === "fulfilled" ? { mcpServers: servers.value } : {}),
      ...(usage.status === "fulfilled"
        ? {
            mcpTools: usage.value.mcpTools,
            skillSources: usage.value.skills?.skillFrontmatter,
          }
        : {}),
    };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

const clip = (text: string): string => text.slice(0, TEXT_MAX_CHARS);

const unique = (names: string[]): string[] => [...new Set(names)];

const counted = (names: string[]): CountedNames => ({
  count: names.length,
  names: names.map(clip),
});

/** Pure: the context of a run from its first `init`, before {@link capRunContext}. */
export function buildRunContext(
  init: InitFacts,
  run: RunFacts,
  state: ToolState = {},
  env: Record<string, string | undefined> = process.env,
): RunContext {
  const deferred = state.mcpTools
    ?.filter((tool) => tool.isLoaded === false)
    .map((tool) => tool.name);
  const deferredSet = new Set(deferred);
  const tools = unique([
    ...(init.tools ?? []),
    ...(state.mcpTools ?? []).map((tool) => tool.name),
  ]).filter((name) => !deferredSet.has(name));

  const skills = unique(init.skills ?? []);
  const plugins = new Set((init.plugins ?? []).map((plugin) => plugin.name));
  const fromPlugin = (name: string) =>
    name.includes(":") && plugins.has(name.slice(0, name.indexOf(":")));
  const orgOwned = state.skillSources
    ? new Set(
        state.skillSources
          .filter(({ source }) => source !== "built-in" && source !== "plugin")
          .map(({ name }) => name),
      )
    : null;
  // Without the CLI's sources only a plugin's skill is known not to be the org's.
  const namedSkills = skills.filter((name) =>
    orgOwned ? !orgOwned.has(name) : fromPlugin(name),
  );

  const servers = (state.mcpServers ?? init.mcp_servers ?? []).map(
    ({ name, status }) => ({ name: clip(name), status: clip(status) }),
  );
  const image = env[IMAGE_VERSION_ENV];
  const effort = init.effort === undefined ? run.effort : init.effort;

  return {
    runner: {
      version: manifest.version,
      ...(image ? { image: clip(image) } : {}),
      ...(init.claude_code_version
        ? { cli: clip(init.claude_code_version) }
        : {}),
    },
    ...(init.model ? { model: clip(init.model) } : {}),
    ...(effort ? { effort: clip(effort) } : {}),
    ...(init.permissionMode
      ? { permissionMode: clip(init.permissionMode) }
      : {}),
    tools: counted(tools),
    ...(deferred ? { deferredTools: counted(unique(deferred)) } : {}),
    skills: {
      count: skills.length,
      ...(orgOwned ? { org: skills.length - namedSkills.length } : {}),
      names: namedSkills.map(clip),
    },
    mcpServers: { count: servers.length, servers },
    agents: counted(unique(init.agents ?? [])),
    ...(run.memory === undefined ? {} : { memory: run.memory }),
    systemPromptAppendChars: run.systemPromptAppendChars,
  };
}

const bytes = (value: unknown): number =>
  value === undefined
    ? 0
    : new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Fit a context into `maxBytes` of JSON by dropping whole lists, longest
 * first, keeping every count and marking the result `truncated`. `null` when
 * it does not fit even with no list left.
 */
export function capRunContext(
  context: RunContext,
  maxBytes = RUN_CONTEXT_MAX_BYTES,
): RunContext | null {
  if (bytes(context) <= maxBytes) return context;
  const capped: RunContext = {
    ...context,
    tools: { ...context.tools },
    ...(context.deferredTools
      ? { deferredTools: { ...context.deferredTools } }
      : {}),
    skills: { ...context.skills },
    mcpServers: { ...context.mcpServers },
    agents: { ...context.agents },
    truncated: true,
  };
  const lists = [
    { size: bytes(capped.tools.names), drop: () => delete capped.tools.names },
    {
      size: bytes(capped.deferredTools?.names),
      drop: () => delete capped.deferredTools?.names,
    },
    {
      size: bytes(capped.skills.names),
      drop: () => delete capped.skills.names,
    },
    {
      size: bytes(capped.mcpServers.servers),
      drop: () => delete capped.mcpServers.servers,
    },
    {
      size: bytes(capped.agents.names),
      drop: () => delete capped.agents.names,
    },
  ].sort((a, b) => b.size - a.size);
  for (const list of lists) {
    list.drop();
    if (bytes(capped) <= maxBytes) return capped;
  }
  return null;
}
