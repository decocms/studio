#!/usr/bin/env node
// @ts-nocheck — plain Node fixture, zero deps, no build step.
/**
 * Deterministic Claude Code CLI oracle for the native chat resume contract.
 *
 * The first invocation emits `system.init.session_id`; resumed invocations
 * deliberately do not repeat the id. That pins the stronger contract: the
 * caller must preserve the durable `--resume` token it supplied while sending
 * only the newest user prompt to each fresh CLI process.
 */

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const sessionId = "770886ee-0c27-444d-b6b1-85fa370466e7";

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write("2.1.218-stub (Claude Code)\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write('{"loggedIn":true}\n');
  process.exit(0);
}

const promptIndex = args.indexOf("-p");
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : undefined;
const resumeIndex = args.indexOf("--resume");
const resumed = resumeIndex >= 0;
const suppliedSessionId = resumed ? args[resumeIndex + 1] : undefined;

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

if (process.env.STUB_CLAUDE_INVOCATION_LOG) {
  appendFileSync(
    process.env.STUB_CLAUDE_INVOCATION_LOG,
    `${JSON.stringify({
      args,
      prompt,
      resumeSessionId: suppliedSessionId ?? null,
    })}\n`,
  );
}

const write = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

if (!resumed) {
  write({
    type: "system",
    subtype: "init",
    session_id: sessionId,
  });
}
write({
  type: "assistant",
  message: {
    id: "msg_resume_stub",
    role: "assistant",
    content: [{ type: "text", text: `reply:${prompt}` }],
  },
});
write({
  type: "result",
  subtype: "success",
  is_error: false,
  result: `reply:${prompt}`,
  ...(resumed ? {} : { session_id: sessionId }),
  usage: {
    input_tokens: 1,
    output_tokens: 1,
  },
});
