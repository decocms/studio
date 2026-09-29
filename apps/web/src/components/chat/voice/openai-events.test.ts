import { expect, test } from "bun:test";
import type { ConversationCallbacks } from "./conversation";
import { OpenAIConversationEvents } from "./openai-events";

function setup(tool?: (parameters: unknown) => string | Promise<string>) {
  const sent: object[] = [];
  const messages: Parameters<ConversationCallbacks["onMessage"]>[0][] = [];
  const modes: string[] = [];
  let errors = 0;
  let executions = 0;
  const callbacks: ConversationCallbacks = {
    clientTools: {
      delegate_to_agent: (parameters) => {
        executions++;
        return tool?.(parameters) ?? JSON.stringify({ status: "accepted" });
      },
    },
    onMessage: (message) => {
      messages.push(message);
    },
    onModeChange: ({ mode }) => {
      modes.push(mode);
    },
    onConnect() {},
    onDisconnect() {},
    onVadScore() {},
    onUserSpeaking() {},
    onError: () => {
      errors++;
    },
  };
  return {
    events: new OpenAIConversationEvents((event) => {
      sent.push(event);
    }, callbacks),
    sent,
    messages,
    modes,
    executions: () => executions,
    errors: () => errors,
  };
}
const call = {
  type: "function_call",
  call_id: "call-example",
  name: "delegate_to_agent",
  arguments: '{"request":"Check analytics"}',
};
const created = (id: string) => ({
  type: "response.created",
  response: { id },
});
const done = (id: string, output: unknown[] = [], status = "completed") => ({
  type: "response.done",
  response: { id, status, output },
});

test("completed calls execute once and acknowledge acceptance without waiting for work", async () => {
  const state = setup();
  state.events.receive(created("response-example"));
  state.events.receive(done("response-example", [call]));
  state.events.receive(done("response-example", [call]));
  await Promise.resolve();
  expect(state.executions()).toBe(1);
  expect(state.sent).toEqual([
    {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: call.call_id,
        output: '{"status":"accepted"}',
      },
    },
    { type: "response.create" },
  ]);
});

test("tool completion during another response waits instead of creating overlapping responses", async () => {
  const pending = Promise.withResolvers<string>();
  const state = setup(() => pending.promise);
  state.events.receive(created("first"));
  state.events.receive(done("first", [call]));
  state.events.receive(created("second"));
  pending.resolve('{"status":"accepted"}');
  await Promise.resolve();
  expect(state.sent).toHaveLength(1);
  state.events.receive(done("second"));
  expect(state.sent.at(-1)).toEqual({ type: "response.create" });
});

test("announcements wait for speech and the automatic user response", () => {
  const state = setup();
  state.events.receive({ type: "input_audio_buffer.speech_started" });
  state.events.userMessage("Background task finished");
  expect(state.sent).toHaveLength(1);
  state.events.receive({ type: "input_audio_buffer.speech_stopped" });
  state.events.receive({
    type: "input_audio_buffer.committed",
    item_id: "utterance-example",
  });
  state.events.receive(created("answer"));
  state.events.receive(done("answer"));
  // The automatic response already includes the background context.
  expect(state.sent).toHaveLength(1);
});

test("audio playback keeps the conversation busy after generation finishes", () => {
  const state = setup();
  state.events.receive(created("answer"));
  state.events.receive({ type: "output_audio_buffer.started" });
  state.events.receive(done("answer"));
  expect(state.modes.at(-1)).toBe("speaking");
  state.events.userMessage("Background result");
  expect(state.sent).toHaveLength(1);
  state.events.receive({ type: "output_audio_buffer.stopped" });
  expect(state.sent.at(-1)).toEqual({ type: "response.create" });
});

test("audio commit and delayed transcription share an utterance identity", () => {
  const state = setup();
  state.events.receive({
    type: "input_audio_buffer.committed",
    item_id: "utterance-example",
  });
  state.events.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "utterance-example",
    transcript: "Check analytics",
  });
  expect(state.messages.map((message) => message.event_id)).toEqual([
    "utterance-example",
    "utterance-example",
  ]);
});

test("cancelled responses never execute unfinished work requests", async () => {
  const state = setup();
  state.events.receive(created("answer"));
  state.events.receive(done("answer", [call], "cancelled"));
  await Promise.resolve();
  expect(state.executions()).toBe(0);
  expect(state.sent).toHaveLength(0);
});

test("leaving voice discards pending tool replies and late provider events", async () => {
  const pending = Promise.withResolvers<string>();
  const state = setup(() => pending.promise);
  state.events.receive(created("answer"));
  state.events.receive(done("answer", [call]));
  state.events.close();
  pending.resolve('{"status":"accepted"}');
  await Promise.resolve();
  state.events.userMessage("late result");
  state.events.receive({ type: "error" });
  expect(state.sent).toHaveLength(0);
  expect(state.errors()).toBe(0);
});

test("malformed tool arguments and unknown tool names are rejected without execution", async () => {
  const state = setup();
  state.events.receive(
    done("answer", [
      { ...call, arguments: "invalid json" },
      { ...call, call_id: "unknown", name: "toString" },
    ]),
  );
  await Promise.resolve();
  expect(state.executions()).toBe(0);
  expect(state.sent).toContainEqual(
    expect.objectContaining({
      type: "conversation.item.create",
      item: expect.objectContaining({
        type: "function_call_output",
        output: expect.stringContaining('"rejected"'),
      }),
    }),
  );
});

test("context replacement removes stale facts without requesting speech", () => {
  const state = setup();
  state.events.contextualUpdate("old view", "view");
  state.events.contextualUpdate("new view", "view");
  expect(state.sent).toHaveLength(3);
  expect(state.sent.at(-1)).toEqual(
    expect.objectContaining({ type: "conversation.item.delete" }),
  );
  expect(state.sent).not.toContainEqual({ type: "response.create" });
});
