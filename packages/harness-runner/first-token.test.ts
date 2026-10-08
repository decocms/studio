import { expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessStreamInputWire } from "@decocms/sandbox/dispatch/schemas";

const log: string[] = [];
let queries = 0;

/** One turn's SDK messages; `first` adds the session's init. */
async function* turnMessages(first: boolean, id: string) {
  if (first) {
    yield {
      type: "system",
      subtype: "init",
      tools: [],
      skills: [],
      mcp_servers: [],
    };
  }
  for (const event of [
    { type: "message_start", message: { id } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    },
  ]) {
    yield { type: "stream_event", parent_tool_use_id: null, event };
  }
  log.push("sdk:assistant");
  yield {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: `${id}-a`,
    message: { id, content: [{ type: "text", text: "Hello" }] },
  };
  yield {
    type: "result",
    subtype: "success",
    uuid: `${id}-r`,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt }: { prompt: string | AsyncIterable<unknown> }) => {
    queries++;
    const messages = async function* () {
      if (typeof prompt === "string") {
        yield* turnMessages(true, "msg_1");
        return;
      }
      let turn = 0;
      for await (const _ of prompt) {
        turn++;
        yield* turnMessages(turn === 1, `msg_${turn}`);
      }
    };
    return Object.assign(messages(), { interrupt: async () => {} });
  },
}));

const input = {
  threadId: "thrd_1",
  userMessage: { parts: [{ type: "text", text: "hi" }] },
  harness: {},
  workspace: { cwd: null },
  models: { thinking: { id: "m", title: "M", credentialId: "c" } },
  mcp: { url: "", headers: {}, expiresAt: 1 },
  mode: "default",
  temperature: 0,
  toolApprovalLevel: "auto",
  user: { id: "u", email: "e@x.com" },
  organizationId: "org_1",
  agent: { id: "agent_1" },
} as HarnessStreamInputWire;

const collect = (frame: { chunks: unknown[] }) => {
  for (const chunk of frame.chunks as { type: string }[]) log.push(chunk.type);
};

test("the first text delta leaves before the first complete assistant message", async () => {
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "runner-"));
  const { runClaudeCode } = await import("./claude-code");
  log.length = 0;
  await runClaudeCode(input, collect);
  expect(log.indexOf("text-delta")).toBeGreaterThan(-1);
  expect(log.indexOf("text-delta")).toBeLessThan(log.indexOf("sdk:assistant"));
  // Still one step: the stream opened it, the assistant message must not split it.
  expect(log.filter((type) => type === "start-step")).toHaveLength(1);
});

test("a persistent runner answers the next turn on the same SDK session", async () => {
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "runner-"));
  process.env.HARNESS_RUNNER_PERSISTENT = "1";
  try {
    const { runClaudeCode } = await import("./claude-code");
    queries = 0;
    log.length = 0;
    await runClaudeCode(input, collect);
    await runClaudeCode(input, collect);
    expect(queries).toBe(1);
    expect(log.filter((type) => type === "text-delta")).toHaveLength(2);
    expect(log.filter((type) => type === "finish")).toHaveLength(2);
  } finally {
    delete process.env.HARNESS_RUNNER_PERSISTENT;
  }
});
