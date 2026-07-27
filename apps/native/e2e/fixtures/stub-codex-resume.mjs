#!/usr/bin/env node
// @ts-nocheck — plain Node fixture, zero deps, no build step.
/**
 * Deterministic Codex CLI oracle for the native chat resume contract.
 *
 * The first `codex exec` invocation emits `thread.started`; resumed
 * invocations deliberately do not. Real Codex currently repeats the event,
 * but omitting it here pins the stronger invariant: a caller that already
 * supplied a durable resume id must preserve that id even when a later CLI
 * process exits without restating it.
 */

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const sessionId = "019f7325-3e34-7b30-863a-861396b02def";

if (args.includes("--version") || args.includes("-V")) {
  process.stdout.write("codex-cli 0.145.0-stub\n");
  process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
  process.stderr.write("Logged in using ChatGPT\n");
  process.exit(0);
}

const resumeIndex = args.indexOf("resume");
const resumed = resumeIndex >= 0;
const suppliedSessionId = resumed ? args[resumeIndex + 1] : undefined;
const prompt = resumed ? args[resumeIndex + 2] : args.at(-1);
const ownership = /OWNERSHIP:([A-Za-z0-9._-]+)/.exec(prompt ?? "")?.[1];

if (resumed && suppliedSessionId !== sessionId) {
  process.stderr.write(
    `unexpected resume session: ${JSON.stringify(suppliedSessionId)}\n`,
  );
  process.exit(2);
}
if (typeof prompt !== "string" || prompt.length === 0) {
  process.stderr.write("missing single-turn prompt\n");
  process.exit(2);
}

if (process.env.STUB_CODEX_INVOCATION_LOG) {
  appendFileSync(
    process.env.STUB_CODEX_INVOCATION_LOG,
    `${JSON.stringify({
      args,
      pid: process.pid,
      ownership,
      prompt,
      resumeSessionId: suppliedSessionId ?? null,
    })}\n`,
  );
}

const write = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

// Deliberately emitted only for the first turn. `RunHandle` must seed its
// session state from the supplied resume id on subsequent turns.
if (!resumed) {
  write({ type: "thread.started", thread_id: sessionId });
}
if (!resumed && prompt.includes("CHECKPOINT_FIRST")) {
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}
write({ type: "turn.started" });
write({
  type: "item.completed",
  item: {
    id: "item_0",
    type: "agent_message",
    text: `reply:${prompt}`,
  },
});
write({
  type: "turn.completed",
  usage: {
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 1,
  },
});
