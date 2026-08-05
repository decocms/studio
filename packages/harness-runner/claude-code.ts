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
 * Tools come from two places and neither needs configuring here: Claude Code's
 * built-ins operate on the checkout, and Studio's org tools arrive over MCP
 * from the endpoint minted for this run. Permissions are bypassed — the pod is
 * the isolation boundary, and there is no UI to answer a prompt.
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
};

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
 * A resumed run has no transcript to inherit — a new pod's SDK session is empty,
 * and even in the same pod the session is only remembered once a turn COMPLETED
 * (see `sessionFile`). What it does have is the work itself: the checkout, and on
 * a replaced pod a clone of the branch the dying daemon pushed on SIGTERM. So
 * this tells the model where to look rather than what was done — the repo is the
 * source of truth, and it is the only one that survives the pod.
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
export function skillsInstruction(): string {
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
  const instructionsWithSkills = [instructions, skillsInstruction()]
    .filter(Boolean)
    .join("\n\n");
  const executable = process.env[ENVS.EXECUTABLE_ENV];
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
    // The org's skills reach the pod as `~/.claude/skills` (the daemon links it
    // onto the org-fs mount), which the SDK discovers from the `user` setting
    // source — but only once skills are turned on for the session.
    skills: "all",
    ...(model ? { model } : {}),
    // ponytail: fixed, not configurable — raise it here if runs come back thin.
    effort: "low",
    // Resume keeps the thread's history in the SDK's own transcript instead of
    // replaying it as prompt text. `sessionId` seeds a new one at the same id
    // so the next turn can resume it.
    ...(resume ? { resume: sessionId } : { sessionId }),
    ...(input.mcp.url
      ? {
          mcpServers: {
            [ENVS.STUDIO_MCP_SERVER_NAME]: {
              type: "http" as const,
              url: input.mcp.url,
              headers: input.mcp.headers,
            },
          },
        }
      : {}),
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
  const sessionId = stored || crypto.randomUUID();

  const translator = new UiChunkTranslator();
  let messageId: string | undefined;
  // Chunks translated before the turn's message id is known. Every chunk has to
  // land after `turnStartChunks`, and that needs the id — so anything the SDK
  // produces before the first assistant message waits here, never longer.
  const pending: unknown[] = [];
  let started = false;
  const startTurn = (id: string) => {
    if (started) return;
    started = true;
    emit({ chunks: [...turnStartChunks(id), ...pending.splice(0)] });
  };
  const push = (chunks: unknown[]) => {
    if (chunks.length === 0) return;
    if (started) emit({ chunks });
    else pending.push(...chunks);
  };

  try {
    const stream = query({
      prompt: promptForRun(input),
      options: buildOptions({ input, sessionId, resume: stored.length > 0 }),
    });

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
        // success. Fail on it. Key off the server STATUS, not the tool count:
        // an http MCP server connects asynchronously, so `pending` with zero
        // mcp__ tools at init is the normal case, not a misconfiguration.
        const broken = message.mcp_servers.filter((server) =>
          ["failed", "needs-auth", "disabled"].includes(server.status),
        );
        if (input.mcp.url && broken.length > 0) {
          fail(
            `studio MCP is unusable (${input.mcp.url}): ${broken
              .map((server) => `${server.name}=${server.status}`)
              .join(" ")}. The harness cannot act on Studio; refusing to run ` +
              `rather than return a result that changed nothing.`,
          );
          return;
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
        if (started) push([{ type: "finish-step" }, { type: "start-step" }]);
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
      emit({
        chunks: [
          ...turnFinishChunks(
            message as SdkResultMessage,
            translator.contextTokens,
          ),
        ],
      });
      return;
    }
    fail("claude-code ended without a result");
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  /** Close whatever the turn had emitted, then report what ended it. */
  function fail(message: string) {
    const error = { code: "harness_crashed", message };
    if (!started && pending.length === 0) {
      emit({ chunks: [], error });
      return;
    }
    startTurn(messageId ?? `msg_${Date.now()}`);
    emit({
      chunks: [
        { type: "finish-step" },
        { type: "finish", finishReason: "error" },
      ],
      error,
    });
  }
}
