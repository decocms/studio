import { expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessStreamInputWire } from "@decocms/sandbox/dispatch/schemas";

const log: string[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    const messages = async function* () {
      yield {
        type: "system",
        subtype: "init",
        tools: [],
        skills: [],
        mcp_servers: [],
      };
      for (const event of [
        { type: "message_start", message: { id: "msg_1" } },
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
        uuid: "u1",
        message: { id: "msg_1", content: [{ type: "text", text: "Hello" }] },
      };
      yield {
        type: "result",
        subtype: "success",
        uuid: "u2",
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
    return Object.assign(messages(), { interrupt: async () => {} });
  },
}));

test("the first text delta leaves before the first complete assistant message", async () => {
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "runner-"));
  const { runClaudeCode } = await import("./claude-code");
  await runClaudeCode(
    {
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
    } as HarnessStreamInputWire,
    (frame) => {
      for (const chunk of frame.chunks as { type: string }[]) {
        log.push(chunk.type);
      }
    },
  );
  expect(log.indexOf("text-delta")).toBeGreaterThan(-1);
  expect(log.indexOf("text-delta")).toBeLessThan(log.indexOf("sdk:assistant"));
  // Still one step: the stream opened it, the assistant message must not split it.
  expect(log.filter((type) => type === "start-step")).toHaveLength(1);
});
