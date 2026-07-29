#!/usr/bin/env node
// @ts-nocheck — plain Node fixture, zero deps, no build step.
/**
 * stub-harness.mjs — a deterministic fake `claude` CLI.
 *
 * ============================================================================
 * THIS FILE IS A WIRE-FORMAT SPEC, not just a test fixture. Read it before
 * changing anything downstream that parses its stdout.
 * ============================================================================
 *
 * Studio's Phase 2 harness crate (`apps/native/crates/harness`, see
 * the desktop migration contract §2.1) spawns the user's
 * installed `claude` binary and translates its stdout (`--output-format
 * stream-json` newline-delimited JSON) into the SSE framing pinned in
 * the native local-API contract. This script
 * stands in for that real binary so the Rust side (and this repo's e2e
 * suite) can be exercised without an installed CLI, a login, or a paid API
 * call.
 *
 * RESOLUTION CONTRACT (shared with the harness crate — see
 * the native local-API contract's env contract section):
 * local-api resolves the Claude binary via `LOCAL_API_CLAUDE_BIN` (falling
 * back to a PATH lookup of `claude`) and the Codex binary via
 * `LOCAL_API_CODEX_BIN` (falling back to PATH `codex`). The value is either
 * an absolute path to an executable, or a JSON array (`'["node",
 * "/abs/path/stub-harness.mjs"]'`) when the interpreter needs to be
 * explicit (e.g. this file has no reliable execute bit in a fresh checkout).
 * Point `LOCAL_API_CLAUDE_BIN` at this file either way — both forms work:
 *   LOCAL_API_CLAUDE_BIN="/abs/path/stub-harness.mjs"
 *   LOCAL_API_CLAUDE_BIN='["node", "/abs/path/stub-harness.mjs"]'
 *
 * REAL-CLI FLAG SURFACE this mirrors (captured via `claude -p --help` on a
 * machine with `claude` 2.1.212 installed, 2026-07-17 — see
 * the desktop migration contract's "Environment facts"; no paid API
 * call was made to produce this file, only `--help`):
 *   -p, --print                 Print response and exit (boolean; the prompt
 *                                itself is a POSITIONAL argument, `claude
 *                                [options] [prompt]` — NOT a value attached
 *                                to -p).
 *   --output-format <format>    "text" (default) | "json" | "stream-json".
 *   --verbose                   Required by the real CLI alongside `-p
 *                                --output-format stream-json` (undocumented
 *                                in `--help`'s per-flag text but enforced at
 *                                startup — the real CLI exits with "Error:
 *                                --verbose is required when using
 *                                --print --output-format=stream-json" if
 *                                omitted). This stub does NOT enforce that
 *                                (permissive > brittle for a test double),
 *                                but the harness crate should always pass it.
 *   --include-partial-messages  Only meaningful with -p + stream-json; emits
 *                                token-level `stream_event` deltas in
 *                                addition to full per-turn messages.
 *   --model <id>                Echoed into the `system/init` line's
 *                                `model` field if supplied, else "stub-model".
 *   -v, --version                Print a version string and exit 0. Used for
 *                                CLI *detection* (harness crate's
 *                                `GET /models` "detected" probe) — see
 *                                `the native local-API contract
 *                                #models--tiers-endpoint`.
 * Every other real-CLI flag (`--mcp-config`, `--allowedTools`, `--add-dir`,
 * `--session-id`, ...) is accepted and ignored (parsed generically below so
 * an unrecognized flag never gets misread as the prompt).
 *
 * NDJSON EVENT SHAPES emitted on stdout mirror the real CLI's
 * `--output-format stream-json` line shapes 1:1 in field names/types (cross-
 * checked against the `SDKMessage` union shipped in
 * `@anthropic-ai/claude-agent-sdk`'s `sdk.d.ts` — `SDKSystemMessage`
 * (`type:"system",subtype:"init"`), `SDKAssistantMessage`
 * (`type:"assistant"`), `SDKUserMessage` (`type:"user"`, used for
 * `tool_result` echoes), `SDKResultSuccess`/`SDKResultError`
 * (`type:"result"`)) — but this stub is the AUTHORITATIVE spec for which
 * FIELDS are populated and what VALUES appear per scenario; it does not
 * attempt full fidelity with every optional SDK field (agents/betas/hooks/
 * etc. are omitted, not just empty).
 *
 * DETERMINISM: every field that would be wall-clock- or randomness-derived
 * on the real CLI (uuid, session_id, duration_ms, usage token counts,
 * total_cost_usd) is a FIXED constant here, not measured/randomly
 * generated — so two runs of the same scenario produce byte-identical
 * ndjson (modulo the `slow` scenario's actual inter-chunk wall-clock delay,
 * which is a real `setTimeout`, not reflected in any emitted field). This is
 * what makes golden-transcript diffing (`apps/native/e2e/fixtures/golden/`)
 * meaningful — see the native parity contract's Phase 2 section.
 *
 * SCENARIO SELECTION: this stub looks for a `SCENARIO:<name>` token anywhere
 * in (a) argv, (b) the resolved prompt text, or (c) piped stdin (all
 * concatenated and searched with a single regex) — NOT tied to one specific
 * flag/positional convention, so it works regardless of exactly how the
 * harness crate threads the user's message through to the CLI invocation
 * (positional arg vs `--input-format stream-json` piped JSON vs anything
 * else). Supported scenarios, and the EXACT ndjson each produces on stdout
 * (one JSON object per line, in this order):
 *
 * ── SCENARIO:simple ─────────────────────────────────────────────────────
 *   1. {"type":"system","subtype":"init",...}
 *   2. {"type":"assistant","message":{...,"content":[{"type":"text","text":"Hello"}]},...}
 *   3. {"type":"assistant","message":{...,"content":[{"type":"text","text":" from"}]},...}
 *   4. {"type":"assistant","message":{...,"content":[{"type":"text","text":" stub-harness"}]},...}
 *   5. {"type":"result","subtype":"success","is_error":false,"result":"Hello from stub-harness",...}
 *   Exit code: 0.
 *
 * ── SCENARIO:tooluse ────────────────────────────────────────────────────
 *   1. system/init (tools: ["Bash"])
 *   2. assistant message, content: [{"type":"tool_use","id":"toolu_stub_0001","name":"Bash","input":{"command":"echo hi"}}]
 *   3. user message (tool_result echo), content: [{"type":"tool_result","tool_use_id":"toolu_stub_0001","content":"hi\n","is_error":false}]
 *   4. assistant message, content: [{"type":"text","text":"Ran `echo hi`. Output: hi"}]
 *   5. result/success, result:"Ran `echo hi`. Output: hi"
 *   Exit code: 0.
 *
 * ── SCENARIO:writefile ──────────────────────────────────────────────────
 *   Writes a real file, `harness-wrote.txt`, into `process.cwd()` (content:
 *   `written by stub-harness in <cwd>\n`) BEFORE emitting any ndjson — this
 *   is the one scenario that has an actual filesystem side effect, added
 *   for `apps/native/e2e/git-sandbox.e2e.test.ts`'s per-branch-workdir
 *   isolation proof (a real `harness::run::start` spawn's `cwd` is the only
 *   thing that changes between two dispatches on different branches; this
 *   scenario is how a test observes THAT cwd from the outside).
 *   1. {"type":"system","subtype":"init",...} (tools: ["Write"])
 *   2. {"type":"assistant",...,"content":[{"type":"text","text":"wrote <path>"}]}
 *   3. {"type":"result","subtype":"success","result":"wrote <path>",...}
 *   Exit code: 0.
 *
 * ── SCENARIO:slow[:<ms>] ────────────────────────────────────────────────
 *   Same 5-line shape as `simple`, but a real `setTimeout` delay (default
 *   400ms, override via a numeric suffix e.g. `SCENARIO:slow:1500`, or the
 *   `STUB_HARNESS_SLOW_MS` env var — the prompt-embedded suffix wins if
 *   both are present) is awaited BEFORE each of the 3 assistant lines (not
 *   before system/init or the final result). Exists so a test can cancel
 *   (SIGTERM/SIGKILL, or the harness crate's own abort-signal plumbing)
 *   between chunk 1 and chunk 2 and observe a clean mid-stream kill.
 *
 * ── SCENARIO:fail ───────────────────────────────────────────────────────
 *   1. system/init
 *   2. assistant message, content: [{"type":"text","text":"Working on it..."}]
 *   3. {"type":"result","subtype":"error_during_execution","is_error":true,"errors":["stub-harness: induced failure"],"result":undefined-omitted,...}
 *   Exit code: 1 (a normal nonzero process exit — NOT a signal kill, so the
 *   128+signal exit-code convention the harness crate applies to
 *   PTY/signal deaths does not apply to this scenario).
 *
 * ── SCENARIO:nosession ──────────────────────────────────────────────────
 *   Emits a nominally-successful init + assistant + result sequence with
 *   every `session_id` field deliberately omitted, then exits 0. A native
 *   thread must fail this turn instead of committing a completed assistant
 *   that cannot resume its CLI-owned history.
 *
 * ── SCENARIO:checkpoint ─────────────────────────────────────────────────
 *   First invocation emits only system/init (and therefore its session id),
 *   then hangs. A resumed invocation using that exact id emits one assistant
 *   reply + result and exits. Used to kill local-api inside the session→turn
 *   completion window and prove the SQLite queue checkpoint survives.
 *
 * ── SCENARIO:hang ───────────────────────────────────────────────────────
 *   1. system/init only. Then the process does nothing further FOREVER —
 *      no more stdout, no exit — until an external signal kills it. No
 *      custom signal handlers are installed, so a default SIGTERM/SIGKILL
 *      terminates it exactly like an unresponsive real CLI would. Exists
 *      for cancel/kill-the-process-group tests.
 *
 * ── SCENARIO:termresist ─────────────────────────────────────
 *   Same one-frame-then-hang shape as `hang`, but installs a SIGTERM
 *   handler that deliberately does nothing. This pins the harness owner's
 *   bounded TERM→KILL escalation; a TERM-only implementation leaks it.
 *
 * ── SCENARIO:fatalhang ───────────────────────────────────────────────────
 *   Emits the same terminal error frame as `fail`, then deliberately ignores
 *   SIGTERM and stays alive. A queue/dispatch implementation must reap it
 *   before releasing its concurrency slot; merely rendering the fatal frame
 *   is not process completion.
 *
 * ── (no SCENARIO tag found) ─────────────────────────────────────────────
 *   Falls back to `simple`'s behavior (using the resolved prompt text
 *   verbatim as context only — the emitted text is still the fixed "Hello
 *   from stub-harness" string; this stub never echoes arbitrary prompt
 *   content into a message body, so output stays deterministic even if the
 *   caller forgets to tag a scenario).
 *
 * VERSION PROBE: `claude --version` / `claude -v` (checked before any
 * scenario logic, short-circuits everything else) prints
 * `<STUB_HARNESS_VERSION or "0.0.0-stub"> (Claude Code)` to stdout and
 * exits 0 — no ndjson, matching the real CLI's plain-text `--version`
 * output. Override the printed version via the `STUB_HARNESS_VERSION` env
 * var (useful for asserting `GET /models` reflects a specific detected
 * version string, if the harness crate ever surfaces one).
 *
 * AUTH / LOGIN-STATUS PROBE: detection is FAIL-CLOSED (the harness crate
 * counts a CLI as "detected" only when it is installed AND logged in — see
 * `apps/native/crates/harness/src/detect.rs`). So, also before any
 * scenario logic, this stub answers the two auth probes as logged-in,
 * mirroring where each REAL CLI writes the signal:
 *   `auth status --json`  → `{"loggedIn":true}` on STDOUT, exit 0 (claude).
 *   `login status`        → `Logged in using ChatGPT` on STDERR (empty
 *                            stdout), exit 0 (codex).
 * Without this the stub would answer `--version` but fail the auth probe
 * and drop out of `GET /models` detection, breaking the parity tests.
 *
 * NON-stream-json OUTPUT FORMATS: `--output-format text` (or omitted) and
 * `--output-format json` are supported minimally — no ndjson, just the
 * scenario's final result text (or `{"result": "..."}` for `json`) once the
 * scenario completes (respecting `slow`'s delays; `fail` still exits 1;
 * `hang` still hangs forever). Not the primary contract surface (the
 * dispatch route always requests `stream-json`), kept cheap for
 * completeness/robustness only.
 */

// Static ESM imports (not `require(...)`) — deliberate: this file's tail
// awaits `runNdjsonScenario()`/`runTextOrJsonScenario()` at the top level,
// and a `require(...)` call reached FROM INSIDE an async function that's
// itself invoked via top-level `await` trips a real Node error on modern
// Node (`ERR_AMBIGUOUS_MODULE_SYNTAX`: "Cannot determine intended module
// format because both 'require' and top-level await are present") —
// `readStdinSync()`'s own `require("node:fs")` below is safe only because
// it always runs BEFORE the top-level `await` statement, never after.
// `SCENARIO:writefile` (below) needs `fs`/`path` from inside the awaited
// scenario functions, so it uses these imports instead.
import { spawn as spawnChild } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";

// ---------------------------------------------------------------------------
// argv parsing — generic enough to never accidentally swallow the prompt as
// a flag value, without having to hand-maintain the full real-CLI flag list.
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set([
  "-p",
  "--print",
  "--verbose",
  "--include-partial-messages",
  "--forward-subagent-text",
  "--replay-user-messages",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--bare",
  "--bg",
  "--background",
  "--chrome",
  "--no-chrome",
  "-c",
  "--continue",
  "--disable-slash-commands",
  "--exclude-dynamic-system-prompt-sections",
  "--fork-session",
  "--ide",
  "--include-hook-events",
  "--no-session-persistence",
  "--safe-mode",
  "--strict-mcp-config",
  "--tmux",
  "-v",
  "--version",
  "-h",
  "--help",
  "--ax-screen-reader",
  "--replay-user-messages",
]);

const VALUE_FLAGS = new Set([
  "--output-format",
  "--input-format",
  "--model",
  "--fallback-model",
  "--append-system-prompt",
  "--append-system-prompt-file",
  "--system-prompt",
  "--system-prompt-file",
  "--mcp-config",
  "--settings",
  "--session-id",
  "--permission-mode",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--add-dir",
  "--agent",
  "--agents",
  "--betas",
  "--debug-file",
  "--effort",
  "--json-schema",
  "--max-budget-usd",
  "-n",
  "--name",
  "--plugin-dir",
  "--plugin-url",
  "--setting-sources",
  "--tools",
  "--file",
  "--from-pr",
  "-d",
  "--debug",
  "-r",
  "--resume",
  "-w",
  "--worktree",
]);

function parseArgv(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("-")) {
      positionals.push(tok);
      continue;
    }
    if (BOOLEAN_FLAGS.has(tok)) {
      flags[tok] = true;
      continue;
    }
    if (VALUE_FLAGS.has(tok)) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[tok] = next;
        i++;
      } else {
        flags[tok] = true; // optional-value flag used as boolean (e.g. -r with no id)
      }
      continue;
    }
    // Unknown flag: treat as boolean so we never eat the prompt.
    flags[tok] = true;
  }
  return { flags, positionals };
}

function readStdinSync() {
  // stdin is piped (not a TTY) whenever the caller didn't give a positional
  // prompt and intends `--input-format stream-json` (or just redirected
  // /dev/null, which reads as empty — fine).
  if (process.stdin.isTTY) return "";
  try {
    return require("node:fs").readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const { flags, positionals } = parseArgv(process.argv.slice(2));

// --- version probe (short-circuits everything else) -------------------------
if (flags["-v"] || flags["--version"]) {
  const version = process.env.STUB_HARNESS_VERSION || "0.0.0-stub";
  process.stdout.write(`${version} (Claude Code)\n`);
  process.exit(0);
}

// --- auth / login-status probe (short-circuits scenario logic) --------------
// Detection is now FAIL-CLOSED (see apps/native/crates/harness/src/detect.rs):
// a CLI counts as "detected" only when it is installed AND reports a
// logged-in session. The harness crate probes `<bin> auth status --json`
// (claude) / `<bin> login status` (codex). Answer both as logged-in so this
// stub stays "detected" under the new policy — matching how the REAL CLIs
// deliver the signal: claude prints its JSON to stdout, codex prints
// "Logged in ..." to STDERR with an empty stdout.
if (positionals[0] === "auth" && positionals[1] === "status") {
  process.stdout.write('{"loggedIn":true}\n');
  process.exit(0);
}
if (positionals[0] === "login" && positionals[1] === "status") {
  process.stderr.write("Logged in using ChatGPT\n");
  process.exit(0);
}

const promptFromArgv = positionals.join(" ");
const stdinText = promptFromArgv ? "" : readStdinSync();
const prompt = promptFromArgv || stdinText;
const searchText = `${process.argv.slice(2).join(" ")} ${prompt} ${stdinText}`;

const scenarioMatch = /SCENARIO:(\w+)(?::(\d+))?/.exec(searchText);
const scenario = scenarioMatch ? scenarioMatch[1] : "simple";
const scenarioArg = scenarioMatch ? scenarioMatch[2] : undefined;
const ownership = /OWNERSHIP:([A-Za-z0-9._-]+)/.exec(searchText)?.[1];
let descendantPid;

// Install TERM resistance BEFORE publishing the invocation-log readiness
// record below. Tests may signal as soon as they observe that line, so doing
// this later would leave a false-green race against Node's default handler.
if (scenario === "termresist" || scenario === "fatalhang") {
  process.on("SIGTERM", () => {
    if (process.env.STUB_HARNESS_SIGNAL_LOG) {
      appendFileSync(
        process.env.STUB_HARNESS_SIGNAL_LOG,
        `${JSON.stringify({ pid: process.pid, signal: "SIGTERM", at: Date.now() })}\n`,
      );
    }
  });

  // The crash-recovery e2e can request a REAL TERM-resistant descendant. It
  // stays in this harness's process group (`detached` is deliberately false),
  // so only group teardown can reap it; killing just this direct Node process
  // makes the test fail. The child writes a readiness record only AFTER its
  // SIGTERM handler is installed, closing the usual signal-handler race.
  if (process.env.STUB_HARNESS_DESCENDANT_LOG) {
    const descendantScript = String.raw`
      const { appendFileSync } = require("node:fs");
      const [logPath, ownership] = process.argv.slice(1);
      const append = (event) => appendFileSync(
        logPath,
        JSON.stringify({ pid: process.pid, parentPid: process.ppid, ownership, event }) + "\n",
      );
      process.on("SIGTERM", () => append("SIGTERM"));
      append("ready");
      setInterval(() => {}, 1 << 30);
    `;
    const descendant = spawnChild(
      process.execPath,
      [
        "-e",
        descendantScript,
        process.env.STUB_HARNESS_DESCENDANT_LOG,
        ownership || `stub-${process.pid}`,
      ],
      { detached: false, stdio: "ignore" },
    );
    if (typeof descendant.pid !== "number") {
      throw new Error("stub-harness: TERM-resistant descendant has no pid");
    }
    descendantPid = descendant.pid;
    descendant.unref();
  }
}

// Optional process-lifecycle oracle for black-box local-api tests. Detection
// probes short-circuit above, so this records ONLY a real harness invocation,
// never `--version` / `auth status`. One JSON object per line lets a test prove
// both that a recovered queued tail ran and that an indeterminate pre-crash
// active head was NOT retried. The pid also makes orphan checks possible after
// local-api receives SIGTERM. Append-only is intentional: one test may span
// two local-api processes pointed at the same durable workdir/log.
if (process.env.STUB_HARNESS_INVOCATION_LOG) {
  appendFileSync(
    process.env.STUB_HARNESS_INVOCATION_LOG,
    `${JSON.stringify({
      pid: process.pid,
      scenario,
      ownership,
      descendantPid,
      prompt,
      resumeSessionId:
        typeof flags["--resume"] === "string" ? flags["--resume"] : null,
      args: process.argv.slice(2),
    })}\n`,
  );
}

const outputFormat = flags["--output-format"] || "text";
const model = flags["--model"] || "stub-model";

// ---------------------------------------------------------------------------
// Deterministic id helpers — fixed-shape "UUIDs" derived from a counter, not
// crypto randomness, so repeated runs of the same scenario are byte-for-byte
// identical (see the DETERMINISM note in the header comment above).
// ---------------------------------------------------------------------------

let uuidCounter = 0;
function detUuid() {
  const n = (uuidCounter++).toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${n}`;
}
const sessionId = `11111111-1111-4111-8111-${scenario
  .padEnd(12, "0")
  .slice(0, 12)}`;

const FIXED_USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};
const FIXED_DURATION_MS = 42;
const FIXED_DURATION_API_MS = 40;
const FIXED_COST_USD = 0.0001;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function systemInit(tools = []) {
  return {
    type: "system",
    subtype: "init",
    // Fixed, NOT `process.cwd()` — the real CLI reports its actual cwd here,
    // but this stub prioritizes determinism (see the header comment) over
    // that one field's realism, so golden-transcript diffing doesn't depend
    // on which directory the test runner happened to invoke it from.
    cwd: "/stub/cwd",
    tools,
    mcp_servers: [],
    model,
    permissionMode: "default",
    apiKeySource: "none",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    claude_code_version: "stub-harness-0.0.0",
    uuid: detUuid(),
    session_id: sessionId,
  };
}

function assistantMessage(content, extra = {}) {
  return {
    type: "assistant",
    message: {
      id: `msg_stub_${uuidCounter}`,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: null,
      stop_sequence: null,
      usage: FIXED_USAGE,
    },
    parent_tool_use_id: null,
    uuid: detUuid(),
    session_id: sessionId,
    ...extra,
  };
}

function userToolResult(toolUseId, resultText) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: resultText,
          is_error: false,
        },
      ],
    },
    parent_tool_use_id: toolUseId,
    uuid: detUuid(),
    session_id: sessionId,
  };
}

function resultSuccess(resultText, numTurns = 1) {
  return {
    type: "result",
    subtype: "success",
    duration_ms: FIXED_DURATION_MS,
    duration_api_ms: FIXED_DURATION_API_MS,
    is_error: false,
    num_turns: numTurns,
    result: resultText,
    stop_reason: "end_turn",
    total_cost_usd: FIXED_COST_USD,
    usage: FIXED_USAGE,
    modelUsage: {},
    permission_denials: [],
    uuid: detUuid(),
    session_id: sessionId,
  };
}

function resultError(errors) {
  return {
    type: "result",
    subtype: "error_during_execution",
    duration_ms: FIXED_DURATION_MS,
    duration_api_ms: FIXED_DURATION_API_MS,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: FIXED_COST_USD,
    usage: FIXED_USAGE,
    modelUsage: {},
    permission_denials: [],
    errors,
    uuid: detUuid(),
    session_id: sessionId,
  };
}

const SLOW_DEFAULT_MS = Number(process.env.STUB_HARNESS_SLOW_MS) || 400;
const slowMs = scenarioArg ? Number(scenarioArg) : SLOW_DEFAULT_MS;

async function runNdjsonScenario() {
  switch (scenario) {
    case "simple": {
      writeLine(systemInit());
      writeLine(assistantMessage([{ type: "text", text: "Hello" }]));
      writeLine(assistantMessage([{ type: "text", text: " from" }]));
      writeLine(assistantMessage([{ type: "text", text: " stub-harness" }]));
      writeLine(resultSuccess("Hello from stub-harness"));
      process.exit(0);
      break; // unreachable, keeps linters happy
    }
    case "tooluse": {
      writeLine(systemInit(["Bash"]));
      const toolUseId = "toolu_stub_0001";
      writeLine(
        assistantMessage([
          {
            type: "tool_use",
            id: toolUseId,
            name: "Bash",
            input: { command: "echo hi" },
          },
        ]),
      );
      writeLine(userToolResult(toolUseId, "hi\n"));
      writeLine(
        assistantMessage([{ type: "text", text: "Ran `echo hi`. Output: hi" }]),
      );
      writeLine(resultSuccess("Ran `echo hi`. Output: hi"));
      process.exit(0);
      break;
    }
    case "slow": {
      writeLine(systemInit());
      const parts = ["Hello", " from", " stub-harness"];
      for (const part of parts) {
        await sleep(slowMs);
        writeLine(assistantMessage([{ type: "text", text: part }]));
      }
      writeLine(resultSuccess(parts.join("")));
      process.exit(0);
      break;
    }
    case "writefile": {
      writeLine(systemInit(["Write"]));
      const cwd = process.cwd();
      const filePath = joinPath(cwd, "harness-wrote.txt");
      writeFileSync(filePath, `written by stub-harness in ${cwd}\n`);
      writeLine(
        assistantMessage([{ type: "text", text: `wrote ${filePath}` }]),
      );
      writeLine(resultSuccess(`wrote ${filePath}`));
      process.exit(0);
      break;
    }
    case "fail": {
      writeLine(systemInit());
      writeLine(assistantMessage([{ type: "text", text: "Working on it..." }]));
      writeLine(resultError(["stub-harness: induced failure"]));
      process.exit(1);
      break;
    }
    case "nosession": {
      const init = systemInit();
      delete init.session_id;
      const assistant = assistantMessage([
        { type: "text", text: "response without session" },
      ]);
      delete assistant.session_id;
      const result = resultSuccess("response without session");
      delete result.session_id;
      writeLine(init);
      writeLine(assistant);
      writeLine(result);
      process.exit(0);
      break;
    }
    case "checkpoint": {
      writeLine(systemInit());
      if (typeof flags["--resume"] === "string") {
        writeLine(
          assistantMessage([{ type: "text", text: `resumed:${prompt}` }]),
        );
        writeLine(resultSuccess(`resumed:${prompt}`));
        process.exit(0);
      }
      setInterval(() => {}, 1 << 30);
      break;
    }
    case "fatalhang": {
      writeLine(systemInit());
      writeLine(resultError(["stub-harness: fatal frame before hang"]));
      setInterval(() => {}, 1 << 30);
      break;
    }
    case "hang": {
      writeLine(systemInit());
      // Deliberately never write anything else and never exit. No signal
      // handlers installed — default Node behavior on SIGTERM/SIGKILL
      // terminates the process, which is exactly the "cancel kills a
      // hung harness" behavior under test. Keep the event loop alive.
      setInterval(() => {}, 1 << 30);
      break;
    }
    case "termresist": {
      writeLine(systemInit());
      setInterval(() => {}, 1 << 30);
      break;
    }
    default: {
      // Unknown SCENARIO:<name> tag — fail loudly rather than silently
      // behaving like `simple`, so a typo'd scenario tag in a test doesn't
      // pass by accident.
      process.stderr.write(
        `stub-harness: unknown scenario "${scenario}" (searched: ${JSON.stringify(searchText.slice(0, 200))})\n`,
      );
      process.exit(2);
    }
  }
}

async function runTextOrJsonScenario() {
  // Minimal non-stream-json path — see header comment. No ndjson; just the
  // final text (or a `{"result": "..."}` envelope for `json`) once the
  // scenario "completes".
  switch (scenario) {
    case "simple":
    case "slow": {
      if (scenario === "slow") {
        for (const _ of [0, 1, 2]) await sleep(slowMs);
      }
      const text = "Hello from stub-harness";
      process.stdout.write(
        outputFormat === "json"
          ? `${JSON.stringify({ result: text })}\n`
          : `${text}\n`,
      );
      process.exit(0);
      break;
    }
    case "tooluse": {
      const text = "Ran `echo hi`. Output: hi";
      process.stdout.write(
        outputFormat === "json"
          ? `${JSON.stringify({ result: text })}\n`
          : `${text}\n`,
      );
      process.exit(0);
      break;
    }
    case "writefile": {
      const cwd = process.cwd();
      const filePath = joinPath(cwd, "harness-wrote.txt");
      writeFileSync(filePath, `written by stub-harness in ${cwd}\n`);
      const text = `wrote ${filePath}`;
      process.stdout.write(
        outputFormat === "json"
          ? `${JSON.stringify({ result: text })}\n`
          : `${text}\n`,
      );
      process.exit(0);
      break;
    }
    case "fail": {
      process.stderr.write("stub-harness: induced failure\n");
      process.exit(1);
      break;
    }
    case "hang":
    case "termresist": {
      setInterval(() => {}, 1 << 30);
      break;
    }
    default: {
      process.stderr.write(`stub-harness: unknown scenario "${scenario}"\n`);
      process.exit(2);
    }
  }
}

if (outputFormat === "stream-json") {
  await runNdjsonScenario();
} else {
  await runTextOrJsonScenario();
}
