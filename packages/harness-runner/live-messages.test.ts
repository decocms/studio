import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessStreamInputWire } from "@decocms/sandbox/dispatch/schemas";
import {
  LiveMessageInbox,
  LiveMessageTurn,
  liveMessageAckLine,
  mergeTurnResults,
  parseLiveMessageLine,
} from "./live-messages";

describe("the stdin line", () => {
  test("parses a live message and nothing else", () => {
    expect(
      parseLiveMessageLine({ liveMessage: { id: "m1", text: "hi" } }),
    ).toEqual({ id: "m1", text: "hi" });
    for (const other of [
      null,
      "x",
      { harnessId: "claude-code", input: {} },
      { liveMessage: { id: "", text: "hi" } },
      { liveMessage: { id: "m1", text: "   " } },
      { liveMessage: { id: 1, text: "hi" } },
    ]) {
      expect(parseLiveMessageLine(other)).toBeNull();
    }
  });

  test("the ack is the shape the daemon reads", () => {
    expect(JSON.parse(liveMessageAckLine("m1", true))).toEqual({
      liveMessageAck: { id: "m1", accepted: true },
    });
  });
});

describe("LiveMessageTurn", () => {
  test("sends each accepted message once, and again to a fresh input", () => {
    const turn = new LiveMessageTurn();
    const first: SDKUserMessage[] = [];
    turn.attach((m) => first.push(m));
    expect(turn.accept({ id: "m1", text: "a" })).toBe(true);
    // Redelivered by the daemon: accepted, not sent twice.
    expect(turn.accept({ id: "m1", text: "a" })).toBe(true);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      type: "user",
      message: { role: "user", content: "a" },
      priority: "next",
    });
    const retry: SDKUserMessage[] = [];
    turn.attach((m) => retry.push(m));
    expect(retry.map((m) => m.uuid)).toEqual(first.map((m) => m.uuid));
  });

  test("marks read by uuid, and refuses once closed", () => {
    const turn = new LiveMessageTurn();
    const sent: SDKUserMessage[] = [];
    turn.attach((m) => sent.push(m));
    turn.accept({ id: "m1", text: "a" });
    turn.accept({ id: "m2", text: "b" });
    expect(turn.markRead("not-ours")).toBeNull();
    expect(turn.markRead(sent[0]?.uuid)).toBe("m1");
    expect(turn.markRead(sent[0]?.uuid)).toBeNull();
    expect(turn.close()).toEqual(["m2"]);
    expect(turn.accept({ id: "m3", text: "c" })).toBe(false);
  });

  test("the inbox refuses when no turn is running", () => {
    const inbox = new LiveMessageInbox();
    expect(inbox.deliver({ id: "m1", text: "a" })).toBe(false);
    const turn = new LiveMessageTurn();
    inbox.open((m) => turn.accept(m));
    expect(inbox.deliver({ id: "m1", text: "a" })).toBe(true);
    inbox.close();
    expect(inbox.deliver({ id: "m2", text: "b" })).toBe(false);
  });

  test("an asynchronous native refusal stays false after the inbox closes", async () => {
    const inbox = new LiveMessageInbox();
    const ack = Promise.withResolvers<boolean>();
    inbox.open(() => ack.promise);
    const delivery = inbox.deliver({ id: "m1", text: "a" });
    inbox.close();
    expect(inbox.deliver({ id: "m2", text: "b" })).toBe(false);
    ack.resolve(false);
    expect(await delivery).toBe(false);
  });
});

test("usage is summed across CLI turns; the session's running cost is not", () => {
  const merged = mergeTurnResults(
    {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.1,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.25,
      usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 },
    },
  );
  expect(merged.usage).toEqual({
    input_tokens: 17,
    output_tokens: 8,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 0,
  });
  expect(merged.total_cost_usd).toBe(0.25);
});

// ---------------------------------------------------------------------------
// The turn loop against a scripted SDK session. The SDK is the boundary: what
// it is asked (options, prompt) and what it answers are what Claude Code does
// with a `priority: "next"` message under `--replay-user-messages`.
// ---------------------------------------------------------------------------

type Scripted = (session: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  received: () => Promise<SDKUserMessage[]>;
  waitFor: (count: number) => Promise<SDKUserMessage[]>;
}) => AsyncGenerator<Record<string, unknown>>;

let script: Scripted;
let lastOptions: Record<string, unknown> = {};

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({
    prompt,
    options,
  }: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options: Record<string, unknown>;
  }) => {
    lastOptions = options;
    const got: SDKUserMessage[] = [];
    let wake: (() => void) | null = null;
    if (typeof prompt !== "string") {
      void (async () => {
        for await (const message of prompt) {
          got.push(message);
          wake?.();
        }
      })();
    }
    const waitFor = async (count: number) => {
      while (got.length < count) {
        await new Promise<void>((resolve) => (wake = resolve));
      }
      return got;
    };
    return Object.assign(
      script({ prompt, received: async () => got, waitFor }),
      { interrupt: async () => {} },
    );
  },
}));

const stream = (event: Record<string, unknown>) => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event,
});

/** One API message streaming `text`, then its restatement. */
function* textMessage(id: string, text: string) {
  yield stream({ type: "message_start", message: { id } });
  yield stream({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  yield stream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  });
  yield stream({ type: "content_block_stop", index: 0 });
  yield {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: `${id}-a`,
    message: { id, content: [{ type: "text", text }] },
  };
}

const result = (uuid: string, extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  uuid,
  usage: { input_tokens: 1, output_tokens: 1 },
  ...extra,
});

const init = {
  type: "system",
  subtype: "init",
  tools: [],
  skills: [],
  mcp_servers: [],
};

function input(liveMessages: boolean): HarnessStreamInputWire {
  return {
    threadId: `thrd_${Math.random().toString(36).slice(2)}`,
    userMessage: { parts: [{ type: "text", text: "fix the build" }] },
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
    ...(liveMessages ? { liveMessages: true } : {}),
  } as HarnessStreamInputWire;
}

async function run(
  liveMessages: boolean,
  during: (inbox: LiveMessageInbox) => void,
) {
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "runner-"));
  const { runClaudeCode } = await import("./claude-code");
  const inbox = new LiveMessageInbox();
  const chunks: Array<Record<string, unknown>> = [];
  const done = runClaudeCode(
    input(liveMessages),
    (frame) => chunks.push(...(frame.chunks as Array<Record<string, unknown>>)),
    0,
    inbox,
  );
  during(inbox);
  await done;
  return { chunks, inbox };
}

const typesOf = (chunks: Array<Record<string, unknown>>) =>
  chunks.map((chunk) =>
    chunk.type === "text-delta" ? `text:${chunk.delta}` : String(chunk.type),
  );

describe("a run that takes live messages", () => {
  test("shows a message where the model read it, between tool rounds", async () => {
    script = async function* ({ waitFor }) {
      yield init;
      yield* textMessage("msg_1", "Looking");
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        uuid: "msg_1-b",
        message: {
          id: "msg_1",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      };
      // The message reaches the CLI while the tool runs…
      const [, live] = await waitFor(2);
      yield {
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
          ],
        },
      };
      // …and is folded in before the next model call.
      yield {
        type: "user",
        isReplay: true,
        parent_tool_use_id: null,
        uuid: live?.uuid,
        message: live?.message,
      };
      yield* textMessage("msg_2", "Updating the changelog too");
      yield result("r1", { user_message_uuids: [live?.uuid] });
    };
    let accepted = false;
    const { chunks, inbox } = await run(true, (inbox) => {
      accepted = inbox.deliver({
        id: "studio-msg-1",
        text: "also the changelog",
      });
    });
    expect(accepted).toBe(true);
    expect(lastOptions.extraArgs).toEqual({ "replay-user-messages": null });
    const types = typesOf(chunks);
    const marker = types.indexOf("data-live-message");
    expect(types.filter((t) => t === "data-live-message")).toHaveLength(1);
    expect(marker).toBeGreaterThan(types.indexOf("tool-output-available"));
    expect(marker).toBeLessThan(
      types.indexOf("text:Updating the changelog too"),
    );
    expect(chunks[marker]).toMatchObject({
      data: { messageId: "studio-msg-1" },
    });
    expect(types.filter((t) => t === "finish")).toHaveLength(1);
    // Finished: the next message is refused, so Studio queues it.
    expect(inbox.deliver({ id: "studio-msg-2", text: "late" })).toBe(false);
  });

  test("a message the turn ended without reading runs as part of the same run", async () => {
    script = async function* ({ waitFor }) {
      yield init;
      yield* textMessage("msg_1", "First answer");
      await waitFor(2);
      yield result("r1", {
        queued_turn_count: 1,
        usage: { input_tokens: 10, output_tokens: 4 },
      });
      // The CLI starts its next turn for the queued message, without an echo.
      yield* textMessage("msg_2", "Second answer");
      yield result("r2", { usage: { input_tokens: 6, output_tokens: 2 } });
    };
    const { chunks } = await run(true, (inbox) => {
      inbox.deliver({ id: "studio-msg-1", text: "and another thing" });
    });
    const types = typesOf(chunks);
    expect(types.filter((t) => t === "finish")).toHaveLength(1);
    expect(types.indexOf("text:First answer")).toBeLessThan(
      types.indexOf("data-live-message"),
    );
    expect(types.indexOf("data-live-message")).toBeLessThan(
      types.indexOf("text:Second answer"),
    );
    const finish = chunks.find((chunk) => chunk.type === "finish") as {
      messageMetadata?: { usage?: { outputTokens?: number } };
    };
    expect(finish.messageMetadata?.usage?.outputTokens).toBe(6);
  });

  test("without the flag the prompt is a string and nothing is taken", async () => {
    let prompt: unknown;
    script = async function* (session) {
      prompt = session.prompt;
      yield init;
      yield* textMessage("msg_1", "Done");
      yield result("r1");
    };
    let accepted = true;
    const { chunks } = await run(false, (inbox) => {
      accepted = inbox.deliver({ id: "studio-msg-1", text: "hi" });
    });
    expect(typeof prompt).toBe("string");
    expect(accepted).toBe(false);
    expect(lastOptions.extraArgs).toBeUndefined();
    expect(typesOf(chunks)).not.toContain("data-live-message");
  });
});
