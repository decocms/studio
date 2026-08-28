/**
 * The `claude-code` harness: one Studio dispatch → one Claude Agent SDK turn.
 *
 * Runs inside the sandbox pod, next to the checkout the daemon already cloned.
 * Studio hands over a `HarnessStreamInputWire`; this returns the turn's whole
 * `UIMessageChunk[]`, which is all a turn ever is here — the SDK reports
 * nothing Studio can render until `result`. That is also what makes the
 * assistant `messageId` derivable (the Anthropic message id of the turn, so a
 * re-delivered turn dedupes).
 *
 * Tools come from three places and none needs configuring here: Claude Code's
 * built-ins operate on the checkout, Studio's own tools arrive over MCP from the
 * endpoint minted for this run, and the org's MCP connections arrive as one
 * server each (`orgMcps`, when the org opted in). Permissions are bypassed —
 * the pod is the isolation boundary, and there is no UI to answer a prompt.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessStreamInputWire } from "@decocms/sandbox/dispatch/schemas";
import {
  turnFinishChunks,
  turnStartChunks,
  UiChunkTranslator,
  type SdkResultMessage,
} from "./to-ui-chunks";

const ENVS = {
  STUDIO_MCP_SERVER_NAME: "studio",
  MODEL_ENV: "CLAUDE_CODE_MODEL",
  EXECUTABLE_ENV: "CLAUDE_CODE_PATH",
  // Absolute plugin dirs the sandbox daemon prefetched the org's skills into,
  // colon-separated. Set by the daemon, not by Studio: it is the daemon that
  // knows where it wrote them, and the value must not outlive that pod.
  PLUGIN_DIRS_ENV: "CLAUDE_CODE_PLUGIN_DIRS",
  MAX_TURNS_ENV: "CLAUDE_CODE_MAX_TURNS",
};

/**
 * The turn cap for this run, or `undefined` for the SDK's own default. Set by
 * Studio per model class (see `claude-code-env.ts`); a non-numeric or
 * non-positive value is treated as unset rather than failing the run — an
 * uncapped run is a cost problem, a refused one is a broken board.
 */
function maxTurnsFromEnv(): number | undefined {
  const parsed = Number(process.env[ENVS.MAX_TURNS_ENV]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Told to the model, because a cap it cannot see is a cap it walks into. With
 * the budget in the prompt it front-loads the work and commits a verdict.
 */
function turnBudgetInstruction(maxTurns: number): string {
  return (
    `You have at most ${maxTurns} turns for this run, and the run is cut off ` +
    `when they are spent. Plan for that budget: gather what you need in as ` +
    `few, as broad steps as you can, and reach and record your conclusion ` +
    `well before the last turn rather than exploring until you are stopped.`
  );
}

/**
 * One frame of a turn's output. `error` accompanies whatever the turn managed
 * to produce and only ever appears on the last frame.
 */
export interface HarnessRunResult {
  chunks: unknown[];
  error?: { code: string; message: string } | null;
}

/**
 * Where a frame goes: one JSON line on stdout, read by the daemon and forwarded
 * to Studio as it arrives. Emitting per SDK message rather than once at the end
 * is what lets Studio persist a turn's work while the turn is still running.
 */
export type EmitFrame = (frame: HarnessRunResult) => void;

/**
 * The instruction that turns a restarted turn into a continuation.
 *
 * This is the INTERRUPTED-turn path, not the follow-up path, and the difference
 * is what survived. A turn cut short mid-flight never reached the `result` that
 * records its session (see `sessionFile`), so there is no transcript to resume —
 * not in a replacement pod, and not in this one. What it does have is the work
 * itself: the checkout, and on a replaced pod a clone of the branch the dying
 * daemon pushed on SIGTERM. So this tells the model where to look rather than
 * what was done — the repo is the source of truth for a turn that left no record
 * of itself.
 *
 * A turn that COMPLETED is the other case entirely, and needs none of this: its
 * session is saved to the org volume and restored into whatever pod the next
 * message lands in, so the SDK resumes the actual conversation.
 *
 * The "update, don't open a second one" line is load-bearing: without it a
 * continuation that finds its own finished work opens a duplicate pull request.
 */
function resumeInstruction(
  resume: { reason: string },
  branch: string | null,
): string {
  const ref = branch ? `\`${branch}\`` : "this task's branch";
  return [
    "",
    "---",
    "",
    "IMPORTANT — you are CONTINUING this task, not starting it. A previous " +
      `attempt was cut short by infrastructure (${resume.reason}), not by you, ` +
      "and its conversation is gone. Whatever it finished is on disk and in git.",
    "",
    "Before anything else, find out where it got to:",
    "- `git status` and `git diff` — uncommitted work in this checkout",
    `- \`git log --oneline -20\` — commits on ${ref}, including any the previous`,
    "  attempt's sandbox pushed as it shut down",
    `- \`gh pr list --head ${branch ?? "<branch>"}\` — whether a pull request already exists`,
    "",
    "Then CONTINUE that work — do not start the task over, and do not redo a " +
      "step that is already committed. If a pull request already exists for " +
      "this branch, push to it; never open a second one.",
  ].join("\n");
}

/**
 * The whole prompt for one dispatch: the turn's message, plus the continuation
 * instruction when this dispatch is picking up an interrupted turn. Pure, so the
 * unit test owns the wording.
 */
export function promptForRun(input: HarnessStreamInputWire): string {
  const prompt = promptFromUserMessage(input.userMessage);
  if (!input.resume) return prompt;
  // Appended, not prepended: it has to be the last thing the model reads, after
  // the task's own "how to finish" instructions.
  return (
    prompt +
    resumeInstruction(
      input.resume,
      input.workspace.cwd === null ? null : input.workspace.branch,
    )
  );
}

/** Extract the prompt text from Studio's opaque `userMessage` wire object. */
export function promptFromUserMessage(userMessage: unknown): string {
  if (typeof userMessage !== "object" || userMessage === null) return "";
  const parts = (userMessage as { parts?: unknown }).parts;
  if (Array.isArray(parts)) {
    const texts: string[] = [];
    for (const part of parts) {
      if (typeof part !== "object" || part === null) continue;
      const typed = part as { type?: unknown; text?: unknown };
      if (typed.type === "text" && typeof typed.text === "string") {
        texts.push(typed.text);
      }
    }
    if (texts.length > 0) return texts.join("\n");
  }
  const content = (userMessage as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}

/**
 * Where this thread's Claude Code session id is remembered.
 *
 * Stored, not derived: one file under the same config dir as the transcript the
 * SDK keeps, so the id and the session it names live and die together. Resuming
 * an id the SDK never persisted fails the whole run, so "no file" has to mean
 * "no session", and it does.
 *
 * The pair no longer dies with the pod. The daemon copies both onto the org
 * volume when a run ends and back before the next one starts
 * (`internal/orgfs/sessions.go`), preserving exactly this invariant — it writes
 * the id only after the transcript has landed. So a follow-up on a thread whose
 * pod was reclaimed hours ago still resumes the real conversation; this file
 * just reads what is there.
 */
function sessionFile(threadId: string): string {
  const dir =
    process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME ?? "."}/.claude`;
  return `${dir}/deco-sessions/${threadId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * The pod's user-scope Claude config dir — the same one `sessionFile` writes to,
 * and the one the daemon links `skills` out of onto the org-fs mount.
 */
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME ?? "."}/.claude`;
}

/**
 * Where a skill the agent authors has to land to outlive the pod: the user-scope
 * skills dir, which the daemon links onto the org's `org/home/skills` (see
 * `ensureSkillsLinkLocked`). Writing there IS an org-fs write, so the skill is
 * shared org-wide; a skill written into the checkout only reaches whoever merges
 * the branch.
 *
 * Absolute, not `~/…`: the Write tool takes a path, not a shell word, so a tilde
 * would create a literal `~` directory next to the checkout and the skill would
 * die with the pod.
 */
function skillsInstruction(): string {
  const dir = `${claudeConfigDir()}/skills`;
  return (
    // READING is deliberately not given a path. Every discovered skill's name and
    // description is already in this prompt, so a path here only invites the model
    // to go `ls` for what it was just handed — which is exactly what it did.
    "Your available skills are already listed for you with their descriptions; " +
    "invoke one with the Skill tool. Never search the filesystem for skills and " +
    "never read a SKILL.md yourself.\n\n" +
    "When you WRITE or edit a reusable skill, put it at " +
    `\`${dir}/<name>/SKILL.md\` (frontmatter \`name\` + \`description\`), using ` +
    "that absolute path — never `~`. That folder syncs to the org, so the skill " +
    "outlives this sandbox and every teammate's run sees it. Do NOT put a skill " +
    "in the checkout's `.claude/skills/`, and do not commit one to the repo, " +
    "unless the task explicitly asks for a skill scoped to that repository."
  );
}

/** SDK options for one run. Exported for the unit test — it is the whole policy. */
export function buildOptions(args: {
  input: HarnessStreamInputWire;
  sessionId: string;
  resume: boolean;
}): Options {
  const { input, sessionId, resume } = args;
  const cwd = input.workspace.cwd ?? undefined;
  const instructions = input.agent.instructions;
  const model = process.env[ENVS.MODEL_ENV];
  const maxTurns = maxTurnsFromEnv();
  const instructionsWithSkills = [
    instructions,
    skillsInstruction(),
    maxTurns === undefined ? undefined : turnBudgetInstruction(maxTurns),
  ]
    .filter(Boolean)
    .join("\n\n");
  const executable = process.env[ENVS.EXECUTABLE_ENV];
  const pluginDirs = (process.env[ENVS.PLUGIN_DIRS_ENV] ?? "")
    .split(":")
    .filter(Boolean);
  const mcpServers = mcpServersFor(input);
  return {
    ...(cwd ? { cwd } : {}),
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    // The pod is the isolation boundary and no approval UI exists upstream.
    permissionMode: "bypassPermissions",
    // Keep Claude Code's own prompt (it is what makes the built-in tools work)
    // and append the Studio agent's instructions rather than replacing it.
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: instructionsWithSkills,
    },
    // Two sources, both wired by the daemon. The org's writable skills are
    // `~/.claude/skills`, symlinked onto the org-fs mount and discovered from
    // the `user` setting source. The read-only shared sets are prefetched to pod
    // disk and loaded as local plugins — out of the checkout, so nothing about
    // them is the repo's business.
    skills: "all",
    ...(pluginDirs.length
      ? {
          plugins: pluginDirs.map((path) => ({ type: "local" as const, path })),
        }
      : {}),
    ...(model ? { model } : {}),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    // ponytail: fixed, not configurable — raise it here if runs come back thin.
    effort: "low",
    // Token-level streaming. Without this the SDK yields only COMPLETE
    // assistant messages, so a paragraph reaches the UI as one 5KB frame after
    // the model finished writing it — the run reads as frozen while it is in
    // fact mid-sentence. `to-ui-chunks.ts` folds the resulting `stream_event`
    // deltas into the same chunk vocabulary, and `push` coalesces them, so
    // nothing downstream sees a per-token frame.
    includePartialMessages: true,
    // Per-dispatch tool subtraction (a reviewer run is read-only; the Super
    // Agent's is not). `disallowedTools` is enforced by the harness itself, so
    // it holds under `bypassPermissions`.
    ...(input.agent.disallowedTools?.length
      ? { disallowedTools: input.agent.disallowedTools }
      : {}),
    // Resume keeps the thread's history in the SDK's own transcript instead of
    // replaying it as prompt text. `sessionId` seeds a new one at the same id
    // so the next turn can resume it.
    ...(resume ? { resume: sessionId } : { sessionId }),
    ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
  };
}

/**
 * Every MCP server this run mounts: Studio's own surface under a fixed name,
 * plus one per org connection Studio sent in `orgMcps` (each already named and
 * deduped there). The Studio entry wins a name clash — an org connection called
 * `studio` must not displace the surface the run reports its work through.
 *
 * The two differ in ONE option, and it is the whole reason an org can hand a
 * run thirty connections without drowning it: `alwaysLoad`.
 *
 * - Org connections are left at the default, which means their tools are
 *   DEFERRED behind Claude Code's tool search — the model sees them only after
 *   searching for one, so N connections cost the prompt nothing up front, and
 *   their servers connect in the background instead of blocking the session.
 * - Studio's own server is `alwaysLoad: true`. Its tools are how the run
 *   reports what it did (the board), so they have to be in the turn-1 prompt
 *   rather than behind a search the model may never run. It is also what makes
 *   the `brokenStudioMcp` preflight mean anything: `alwaysLoad` blocks startup
 *   until the server connects (capped at 5s), so `system/init` reports it as
 *   connected or failed instead of the `pending` a deferred server shows.
 *
 * Deferral is Claude Code's own behavior, not something requested here, and it
 * only applies when tool search is on — which it is NOT on a non-first-party
 * `ANTHROPIC_BASE_URL` (our OpenRouter path) unless `ENABLE_TOOL_SEARCH` is set
 * for that process. On those runs every org tool loads eagerly, so a big org is
 * still a big prompt. Setting it there is a decision about whether the proxy
 * forwards `tool_reference` blocks, which is not this file's to make.
 *
 * Exported for the unit test, which owns the merge.
 */
export function mcpServersFor(
  input: HarnessStreamInputWire,
): NonNullable<Options["mcpServers"]> {
  const servers: NonNullable<Options["mcpServers"]> = {};
  for (const server of input.orgMcps ?? []) {
    if (server.name === ENVS.STUDIO_MCP_SERVER_NAME) continue;
    servers[server.name] = {
      type: "http" as const,
      url: server.url,
      headers: server.headers,
    };
  }
  // Decopilot's in-process runs carry the empty sentinel; a server pointing at
  // an empty URL fails the SDK's startup connect.
  if (input.mcp.url) {
    servers[ENVS.STUDIO_MCP_SERVER_NAME] = {
      type: "http" as const,
      url: input.mcp.url,
      headers: input.mcp.headers,
      alwaysLoad: true,
    };
  }
  return servers;
}

/**
 * Studio's MCP servers this session will never get tools from, as
 * `name=status` — or `null` when the session can act on Studio.
 *
 * Keys off the server STATUS, not the tool count: an http MCP server connects
 * asynchronously, so `pending` with zero `mcp__` tools at init is the normal
 * case, not a misconfiguration. Exported for the unit test.
 */
export function brokenStudioMcp(
  servers: { name: string; status: string }[],
  mcpUrl: string,
): string | null {
  if (!mcpUrl) return null;
  const broken = servers.filter(
    (server) =>
      // STUDIO's server only. The org's connections ride along on the same
      // session (`orgMcps`) and any of them can be down, unauthorized, or just
      // gone — that is a missing toolset, not a reason to refuse the run and
      // burn the whole retry budget on it.
      server.name === ENVS.STUDIO_MCP_SERVER_NAME &&
      ["failed", "needs-auth", "disabled"].includes(server.status),
  );
  if (broken.length === 0) return null;
  return broken.map((server) => `${server.name}=${server.status}`).join(" ");
}

/**
 * Attempts at reaching Studio's MCP before a run gives up, and the base of the
 * backoff between them (2s, 4s, 8s, 16s, 32s, 64s, 128s — ~4 minutes in all).
 *
 * What this waits out is Studio being momentarily unreachable: a rolling
 * restart, a saturated pod, a moment with no free DB connection. That is over
 * in seconds and has nothing to do with the task, so surfacing it as a failed
 * run — which is what used to happen — put an infrastructure hiccup in front of
 * the user. A retry costs one SDK session start; the session has produced
 * nothing at that point (the preflight reads `system/init`, the first message
 * of all), so restarting it loses nothing.
 *
 * Four minutes rather than the original thirty seconds: a rolling deploy of the
 * Studio API is minutes, not seconds, and a run dispatched into one used to burn
 * its whole retry budget inside a single unavailable window and fail. The pod is
 * already provisioned and idle either way — waiting costs its TTL, not a user's
 * task. The ceiling still exists on purpose: past it, refusing beats running an
 * agent that cannot see the org's tools (see the `fail` below).
 */
const MCP_ATTEMPTS = 8;
const MCP_BACKOFF_BASE_MS = 2_000;

/**
 * Retries allowed against a rejecting upstream model provider, and the base of
 * the equal-jittered backoff between them (0.5-1s, 1-2s, 2-4s).
 *
 * OpenRouter fronts one Claude model with several upstreams (Anthropic, Bedrock,
 * Vertex, Azure) and picks one per request, so a request it relays as
 * `400 Provider returned error` is a property of the upstream it happened to
 * pick, not of the request: on production threads the SAME prompt in the SAME
 * pod failed and then completed 87 seconds later, untouched. The SDK will not
 * retry it for us — a 400 is a permanent client error by every Anthropic SDK's
 * rules, which is the right default and the wrong one here.
 *
 * Three retries because one is only worth anything if it lands on a different
 * upstream, which it does immediately; waiting longer buys nothing.
 * The jitter is not decoration — these failures arrive in bursts (14 threads in
 * one hour on one org), so an unjittered backoff would retry them in lockstep.
 */
const PROVIDER_RETRIES = 3;
const PROVIDER_BACKOFF_BASE_MS = 1_000;

/**
 * Whether an SDK throw is the upstream provider failing rather than the request
 * being wrong.
 *
 * Matched on OpenRouter's own relay wording, not on the status code: a 400 whose
 * body describes the request (`messages.0: text content blocks must be
 * non-empty`) is a bug a retry would only repeat, and must stay fatal. Exported
 * for the unit test — pure.
 */
export function isTransientProviderRejection(message: string): boolean {
  return /provider returned error/i.test(message);
}

/**
 * Equal-jitter exponential backoff for {@link PROVIDER_RETRIES}.
 *
 * Hand-rolled rather than `exponentialBackoffWithJitter` from
 * `@decocms/shared/std`, which every other retry in the repo uses: this package
 * is installed into the sandbox image from a tarball and so can only depend on
 * published packages, which a private workspace module is not. Same reason
 * `Bun.sleep` stands in for `sleep` here and on the MCP path above.
 */
function providerBackoffMs(attempt: number): number {
  const exponential = PROVIDER_BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return Math.round(exponential * (0.5 + Math.random() / 2));
}

/**
 * A live-only progress chunk telling the UI what this pause is.
 *
 * The shape is the `data-run-status` contract owned by
 * `apps/api/src/api/routes/decopilot/run-status-stage.ts`, restated here rather
 * than imported: this package is installed into the sandbox image from a tarball
 * (`packages/sandbox/image/Dockerfile`) and can only depend on published
 * packages, so the process boundary is the wall. Studio drops these from the
 * durable projection (`isTransientControlChunk`), so a retry the user watched
 * happen leaves nothing behind in the thread.
 */
function retryingProviderChunk(): Record<string, unknown> {
  return {
    type: "data-run-status",
    id: "run-status",
    data: { stage: "retrying-provider" },
  };
}

/**
 * Drops a `text-end` / `reasoning-end` whose part the consumer does not have
 * open, and mirrors the AI SDK reducer's own part lifecycle to decide that.
 *
 * The reducer throws on an orphan end — `Received reasoning-end for missing
 * reasoning part with ID "stream-2"` — and that throw kills the stream
 * mid-run. Observed live: an agent that had cloned its repo and was still
 * working in its pod had its Studio-side run torn down after two tool calls,
 * while the pod kept going for minutes, oblivious.
 *
 * Two things upstream can separate an end from its start, and neither is a
 * bug this can be fixed at:
 *
 *  - **A restart drops the start.** `pending` buffers everything until the
 *    turn's message id is known, and an abandoned attempt clears it wholesale
 *    (`pending.length = 0`) along with the coalescer — but `UiChunkTranslator`
 *    keeps its `openStreamBlocks`, so the next `message_start` closes a block
 *    whose start went in the bin.
 *  - **A `finish-step` lands between them.** The reducer CLEARS its open parts
 *    on that boundary, so every end after it is an orphan by definition. The
 *    step-boundary call sites close open blocks first for exactly this reason;
 *    this is the backstop for the next call site that forgets.
 *
 * Rather than chase each path, this sits at the one place every chunk reaches
 * the consumer and enforces the reducer's rule directly: a start opens an id,
 * an end closes it, and `finish-step` clears them all. An end with no open id
 * is dropped — the part it referred to is already closed or was never opened,
 * so dropping it costs nothing and keeps the run alive.
 */
export function createOrphanEndGuard(): (chunks: unknown[]) => unknown[] {
  const open = new Set<string>();
  return (chunks) =>
    chunks.filter((chunk) => {
      if (typeof chunk !== "object" || chunk === null) return true;
      const { type, id } = chunk as { type?: unknown; id?: unknown };
      if (type === "finish-step") {
        open.clear();
        return true;
      }
      if (typeof type !== "string" || typeof id !== "string") return true;
      // Keyed on KIND and id, like the coalescer's merge check: ids are minted
      // distinctly today, so a `reasoning-end` landing on a `text` part's id
      // means something upstream is confused, and closing that part on its
      // behalf would corrupt it rather than just misorder it.
      if (type === "text-start" || type === "reasoning-start") {
        open.add(`${type.slice(0, -"-start".length)}:${id}`);
        return true;
      }
      // `delete` returns whether it was open — exactly the keep/drop answer.
      if (type === "text-end" || type === "reasoning-end") {
        return open.delete(`${type.slice(0, -"-end".length)}:${id}`);
      }
      return true;
    });
}

/**
 * Coalesces adjacent text/reasoning deltas so token-level streaming does not
 * become token-level *framing*.
 *
 * `includePartialMessages` makes the SDK yield one message per token, and the
 * caller turns every emission into one dispatch frame — forwarding them 1:1
 * would push tens of thousands of ~60-byte frames per run through the daemon,
 * JetStream and every open SSE connection. Deltas on the same block concatenate
 * losslessly, so they are held until they are worth a frame.
 *
 * Ordering is preserved exactly: a non-delta chunk flushes whatever is held
 * before it goes out, so `text-end` can never overtake its own text.
 *
 * ponytail: size-based, no timer. ~200 chars is well under a second at model
 * output rates, and a timer would need a flush race at every turn exit for no
 * visible gain. If a slow model ever feels chunky, add the timer here.
 */
export function createDeltaCoalescer(flushChars = 200): {
  push(chunks: unknown[]): unknown[];
  drain(): unknown[];
  discard(): void;
} {
  let held: { type: string; id: string; delta: string } | null = null;

  const asDelta = (
    chunk: unknown,
  ): { type: string; id: string; delta: string } | null => {
    if (typeof chunk !== "object" || chunk === null) return null;
    const record = chunk as Record<string, unknown>;
    if (record.type !== "text-delta" && record.type !== "reasoning-delta") {
      return null;
    }
    if (typeof record.id !== "string" || typeof record.delta !== "string") {
      return null;
    }
    return { type: record.type, id: record.id, delta: record.delta };
  };

  return {
    push(chunks) {
      const out: unknown[] = [];
      for (const chunk of chunks) {
        const delta = asDelta(chunk);
        if (!delta) {
          if (held) out.push(held);
          held = null;
          out.push(chunk);
          continue;
        }
        // Both type AND id: ids are minted distinctly today, but merging a
        // reasoning delta into a text part on an id collision would corrupt
        // the part rather than just misorder it.
        if (held && held.type === delta.type && held.id === delta.id) {
          held.delta += delta.delta;
        } else {
          if (held) out.push(held);
          held = delta;
        }
        if (held.delta.length >= flushChars) {
          out.push(held);
          held = null;
        }
      }
      return out;
    },
    drain() {
      if (!held) return [];
      const chunk = held;
      held = null;
      return [chunk];
    },
    discard() {
      held = null;
    },
  };
}

/**
 * Run one turn, emitting its chunks as the SDK produces them. An SDK throw
 * becomes a final `error` frame after whatever the turn had already emitted, so
 * a crash mid-turn still shows the work instead of an empty message.
 */
export async function runClaudeCode(
  input: HarnessStreamInputWire,
  emit: EmitFrame,
): Promise<void> {
  const file = sessionFile(input.threadId);
  const stored = (
    await Bun.file(file)
      .text()
      .catch(() => "")
  ).trim();
  // Mutable: a crashed/duplicate prior run can leave this thread's Claude Code
  // session locked, and the SDK then refuses to resume OR recreate it ("Session
  // ID … is already in use"). The attempt loop below forks a fresh id once on
  // that error, so both must be reassignable.
  let sessionId = stored || crypto.randomUUID();
  let resumeSession = stored.length > 0;

  const translator = new UiChunkTranslator();
  let messageId: string | undefined;
  // Chunks translated before the turn's message id is known. Every chunk has to
  // land after `turnStartChunks`, and that needs the id — so anything the SDK
  // produces before the first assistant message waits here, never longer.
  const pending: unknown[] = [];
  let started = false;
  const guard = createOrphanEndGuard();
  const startTurn = (id: string) => {
    if (started) return;
    started = true;
    emit({ chunks: guard([...turnStartChunks(id), ...pending.splice(0)]) });
  };
  /**
   * Whether a failed attempt can be restarted without duplicating work.
   *
   * `started` flips on the turn's first assistant message, and a tool call is
   * part of one — so an un-started turn has run no tool and side-effected
   * nothing, and restarting it loses only the request that failed. Past that
   * point a restart would re-run work and splice two generations into one
   * message, which is a worse failure than the one it recovers from.
   */
  const canRestartCleanly = () => !started;
  const coalescer = createDeltaCoalescer();
  const send = (chunks: unknown[]) => {
    if (chunks.length === 0) return;
    // Buffered chunks are guarded when `startTurn` flushes them, not here: an
    // end whose start is still sitting in `pending` is not an orphan, and
    // `pending` is dropped WHOLESALE on a restart, so what survives is only
    // decidable at the emit that actually sends it.
    if (started) {
      const guarded = guard(chunks);
      if (guarded.length > 0) emit({ chunks: guarded });
    } else pending.push(...chunks);
  };
  const push = (chunks: unknown[]) => {
    if (chunks.length === 0) return;
    send(coalescer.push(chunks));
  };
  /** Emit whatever the coalescer is still holding. Every turn exit owes this. */
  const drain = () => send(coalescer.drain());

  try {
    let forkedForSession = false;
    let restartedWithoutResume = false;
    let providerRetries = 0;
    for (let attempt = 1; ; attempt++) {
      let broken: string | null;
      try {
        broken = await attemptTurn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // The SDK refuses a session id that is already in use — a prior run for
        // this thread crashed or double-dispatched and left it locked, so every
        // resume/recreate fails on the same id. Fork a FRESH session once and
        // restart the attempt loop; losing that transcript beats failing every
        // retry forever. Only once — a second "in use" is a real problem.
        // The stored id names a transcript this pod's SDK cannot resolve, so
        // the resume fails the WHOLE run — strictly worse than the fresh start
        // the session was meant to improve on. Causes vary (a transcript copied
        // under a different cwd slug, a truncated file, an SDK that changed
        // where it files them) and none are worth distinguishing: drop the
        // resume and run the turn. Once — a second one is not the session.
        if (
          !restartedWithoutResume &&
          resumeSession &&
          /no conversation found|session .* not found/i.test(msg)
        ) {
          restartedWithoutResume = true;
          console.error(
            `[claude-code] session ${sessionId} does not resolve here — ` +
              `starting a fresh session for this turn`,
          );
          sessionId = crypto.randomUUID();
          resumeSession = false;
          attempt = 0;
          continue;
        }
        if (
          canRestartCleanly() &&
          providerRetries < PROVIDER_RETRIES &&
          isTransientProviderRejection(msg)
        ) {
          providerRetries++;
          const waitMs = providerBackoffMs(providerRetries);
          console.error(
            `[claude-code] provider rejected the request (${msg}) — retrying ` +
              `in ${waitMs}ms (attempt ${providerRetries}/${PROVIDER_RETRIES})`,
          );
          // Straight to `emit`: `push` buffers until the turn starts.
          emit({ chunks: [retryingProviderChunk()] });
          // What the dead attempt buffered is not part of the next one.
          pending.length = 0;
          // Nor is a delta it left half-coalesced — discard it, don't drain it.
          coalescer.discard();
          await Bun.sleep(waitMs);
          if (!resumeSession) sessionId = crypto.randomUUID();
          attempt = 0;
          continue;
        }
        if (!forkedForSession && /is already in use/i.test(msg)) {
          forkedForSession = true;
          console.error(
            `[claude-code] session ${sessionId} in use — forking a fresh ` +
              `session and retrying`,
          );
          sessionId = crypto.randomUUID();
          resumeSession = false;
          attempt = 0;
          continue;
        }
        throw err;
      }
      if (!broken) return;
      if (attempt >= MCP_ATTEMPTS) {
        fail(
          `studio MCP is unusable (${input.mcp.url}): ${broken}. The harness ` +
            `cannot act on Studio; refusing to run rather than return a result ` +
            `that changed nothing.`,
        );
        return;
      }
      // A fresh id per retry, whenever there is no transcript to resume. The
      // previous attempt's CLI may still be releasing its hold on the old one,
      // and nothing is lost: a preflight that never reached the model persisted
      // no session. A RESUMING attempt keeps its id — the transcript is the
      // point — and falls back on the fork above if the hold outlives it.
      if (!resumeSession) sessionId = crypto.randomUUID();
      const waitMs = MCP_BACKOFF_BASE_MS * 2 ** (attempt - 1);
      console.error(
        `[claude-code] mcp unusable (${broken}) — retrying in ${waitMs}ms ` +
          `(attempt ${attempt}/${MCP_ATTEMPTS})`,
      );
      await Bun.sleep(waitMs);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  /**
   * Stop an attempt's SDK session, so the next attempt can have one.
   *
   * The session id is held by the `claude` child process, not by this one, and
   * the CLI refuses a session that another process still holds. Both calls are
   * best-effort — a session that is already gone is exactly the state we want.
   */
  async function endSession(stream: ReturnType<typeof query>): Promise<void> {
    try {
      await stream.interrupt();
    } catch {
      // Only valid mid-turn on a streaming input; not an error worth reporting.
    }
    try {
      await stream.return(undefined);
    } catch {
      // Ditto: the generator may already be done.
    }
  }

  /**
   * One SDK session. Returns the broken-MCP description when the preflight
   * found Studio unreachable — the one outcome worth starting over for — and
   * `null` once the turn has been reported, however it ended.
   */
  async function attemptTurn(): Promise<string | null> {
    const stream = query({
      prompt: promptForRun(input),
      options: buildOptions({ input, sessionId, resume: resumeSession }),
    });

    try {
      return await consumeStream(stream);
    } catch (err) {
      // Any throw here otherwise leaves the session locked for the next attempt.
      await endSession(stream);
      throw err;
    }
  }

  async function consumeStream(
    stream: ReturnType<typeof query>,
  ): Promise<string | null> {
    const startedAt = Date.now();
    for await (const message of stream) {
      // Every SDK message, with the seconds it took to arrive. Without this a
      // run stalled on the model, on a tool, or on MCP looks exactly like a run
      // that is working — both are silence in the pod log.
      console.error(
        `[claude-code] sdk ${message.type}${
          "subtype" in message && message.subtype ? `/${message.subtype}` : ""
        } +${Math.round((Date.now() - startedAt) / 1000)}s`,
      );
      // A failed MCP connection is not an error the SDK raises — the tools just
      // aren't in the model's list, and the run reads as "the agent ignored its
      // instructions". The init message is the only place that distinguishes
      // the two, so log it.
      if (message.type === "system" && message.subtype === "init") {
        const studioToolCount = message.tools.filter((tool) =>
          tool.startsWith("mcp__"),
        ).length;
        // Skills are a filesystem contract across two processes (the daemon
        // links the dir, the SDK scans it) and a broken link is silent — the
        // model just never mentions a skill. Log what it actually found.
        console.error(
          `[claude-code] skills (${message.skills.length}): ${
            message.skills.join(" ") || "none discovered"
          }`,
        );
        console.error(
          `[claude-code] mcp: ${
            message.mcp_servers
              .map((server) => `${server.name}=${server.status}`)
              .join(" ") || "none configured"
          } | studio tools: ${studioToolCount}`,
        );
        // A run that cannot reach Studio (no board update, no state change)
        // still produces a confident-looking answer — the failure that reads as
        // success. Never run in that state; the caller retries instead.
        const broken = brokenStudioMcp(message.mcp_servers, input.mcp.url);
        if (broken) {
          // End the session before the caller retries. Abandoning the iteration
          // is not enough: the CLI process stays alive holding this session id,
          // so the next attempt dies on "Session ID … is already in use" —
          // which the fork-once recovery above absorbs exactly once, and the
          // attempt after that fails the whole run. Observed live: a run with
          // an unreachable MCP crashed on its THIRD attempt instead of waiting
          // out the deploy the retry budget exists for.
          await endSession(stream);
          return broken;
        }
      }
      // First Anthropic message id of the turn becomes Studio's assistant
      // message id: stable if the same turn is delivered twice.
      // Every assistant message opens a step, and closes the previous one. The
      // step boundary is not cosmetic: Studio persists a run's parts on
      // `finish-step` (`emitStepParts`), so a turn wrapped in ONE step reaches
      // the database only when the whole loop ends, however early its chunks
      // arrived. Tool results (the `user` message that follows) belong to the
      // step whose call produced them, which is why the close happens here and
      // not when they arrive.
      if (message.type === "assistant") {
        const id = message.message.id;
        if (!messageId && typeof id === "string" && id.length > 0) {
          messageId = id;
        }
        // Close whatever `stream_event` left open BEFORE the step boundary —
        // the SDK reducer drops its open parts on `finish-step`, so an end
        // emitted after it is an orphan that throws and kills the run.
        if (started)
          push([
            ...translator.closeOpenStreamBlocks(),
            { type: "finish-step" },
            { type: "start-step" },
          ]);
        else startTurn(messageId ?? `msg_${message.uuid}`);
      }
      push([...translator.translate(message)]);
      if (message.type !== "result") continue;
      // Remember the session only once a turn completed on it. ponytail: a
      // failed turn therefore starts the next one fresh, losing the history —
      // the alternative is resuming a session the SDK may have left unwritten,
      // which fails the whole run instead of just forgetting.
      await Bun.write(file, sessionId);
      startTurn(messageId ?? `msg_${message.uuid}`);
      drain();
      emit({
        chunks: [
          ...turnFinishChunks(
            message as SdkResultMessage,
            translator.contextTokens,
          ),
        ],
      });
      return null;
    }
    fail("claude-code ended without a result");
    return null;
  }

  /** Close whatever the turn had emitted, then report what ended it. */
  function fail(message: string) {
    const error = { code: "harness_crashed", message };
    drain();
    if (!started && pending.length === 0) {
      emit({ chunks: [], error });
      return;
    }
    startTurn(messageId ?? `msg_${Date.now()}`);
    emit({
      chunks: errorFinishChunks(translator),
      error,
    });
  }
}

/**
 * Chunks for an aborted turn: close whatever `stream_event` left open, then
 * finish the step and the run.
 *
 * Same orphan-end hazard the step boundary above guards against — the AI SDK
 * reducer clears its open text/reasoning parts on `finish-step`, so an end
 * emitted after it throws and drops the stream. An SDK throw mid-block (a
 * network drop, a crash) reaches `fail()` with a block `stream_event` opened
 * and never closed; without this, `finish-step` went out first and the part
 * was left open forever instead of throwing — no crash, but a message that
 * reads as still streaming after the run has already failed.
 */
export function errorFinishChunks(translator: UiChunkTranslator): unknown[] {
  return [
    ...translator.closeOpenStreamBlocks(),
    { type: "finish-step" },
    { type: "finish", finishReason: "error" },
  ];
}
