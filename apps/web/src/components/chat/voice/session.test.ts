import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { ChatMessage } from "../types";
import type {
  ConversationCallbacks,
  ConversationUpdate,
  VoiceConversation,
} from "./conversation";

const updates: ConversationUpdate[] = [];
let callbacks: ConversationCallbacks | undefined;
mock.module("./conversation", () => ({
  startVoiceConversation: async (
    _connection: unknown,
    _language: unknown,
    received: ConversationCallbacks,
  ): Promise<VoiceConversation> => {
    callbacks = received;
    return {
      endSession: async () => {},
      publishUpdate: (update) => updates.push(update),
      setMicMuted: () => {},
      getOutputVolume: () => 0,
    };
  },
}));
const { VoiceSession } = await import("./session");
type Bindings = import("./session").VoiceBindings;

afterEach(() => {
  mock.restore();
  updates.length = 0;
  callbacks = undefined;
});

function message(id: string, role: "user" | "assistant", parts: unknown[]) {
  // MCP tool parts arrive over the wire outside the built-in part union.
  const parsed: ChatMessage = JSON.parse(JSON.stringify({ id, role, parts }));
  return parsed;
}
const text = (value: string) => ({ type: "text", text: value, state: "done" });

async function connect() {
  const reservation = async () =>
    Response.json({
      provider: "openai",
      transport: "webrtc",
      token: "token_example",
      expiresAt: Date.now() + 60_000,
    });
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(reservation, { preconnect: fetch.preconnect }),
  );
  const sent: string[] = [];
  const bindings: Bindings = {
    sendVoiceMessage: async (id) => {
      sent.push(id);
      return true;
    },
    voiceContext: undefined,
    messages: [],
    status: "ready",
    error: null,
    finishReason: null,
    isStreaming: false,
    isRunInProgress: false,
    isWaitingForApprovals: false,
    stop: () => {},
  };
  const session = new VoiceSession("/api/org_example/threads/t1/voice", "pt");
  session.updateBindings(bindings, true);
  await session.start();
  if (!callbacks) throw new Error("conversation did not start");
  return { session, bindings, sent, callbacks };
}

const workStatus = () =>
  JSON.parse(
    updates.findLast((update) => update.contextId === "studio-work")?.text ??
      "{}",
  );
const results = () =>
  updates
    .filter((update) => !update.contextId && update.text.includes("result"))
    .map((update) => JSON.parse(update.text).result);

test("background subtasks report their reaction, not the start notice", async () => {
  const { session, bindings, sent, callbacks } = await connect();
  const receipt = await callbacks.onDelegate({
    request: "Analisa o cache",
    delegationId: "delegation-1",
  });
  expect(receipt.status).toBe("accepted");
  const [id] = sent;
  if (!id) throw new Error("request was not sent");
  expect(workStatus().requests[0].status).toBe("queued");

  const started = message(id, "user", [text("Analisa o cache")]);
  const ack = message("a1", "assistant", [
    {
      type: "tool-subtask",
      toolCallId: "call-1",
      state: "output-available",
      input: { prompt: "Analyze", background: true },
      output: { background: true, status: "started", jobId: "job-1" },
    },
    text("Comecei a análise em segundo plano."),
  ]);
  session.updateBindings({ ...bindings, messages: [started, ack] }, true);
  expect(workStatus().requests[0].status).toBe("running_in_background");
  expect(results()).toEqual([]);

  const reaction = message("job-1:react-msg", "user", [text("nudge")]);
  const answer = message("a2", "assistant", [
    {
      type: "tool-TASK_BOARD_ITEM_CREATE",
      toolCallId: "call-2",
      state: "output-available",
      input: { title: "Fix cache" },
      output: { item: { id: "task-1", title: "Fix cache", status: "todo" } },
    },
    text("O cache está em 25%. Criei uma task."),
  ]);
  session.updateBindings(
    { ...bindings, messages: [started, ack, reaction, answer] },
    true,
  );
  expect(results()).toEqual(["O cache está em 25%. Criei uma task."]);
  expect(workStatus()).toMatchObject({
    requests: [{ status: "finished" }],
    tasks: [{ title: "Fix cache", status: "todo" }],
  });
  session.stop();
});

test("only tasks created in the call are announced", async () => {
  const { session, bindings, sent, callbacks } = await connect();
  await callbacks.onDelegate({ request: "Cria a task", delegationId: "d1" });
  const [id] = sent;
  if (!id) throw new Error("request was not sent");
  // The board event can precede the tool output that names the task.
  session.taskUpdated({ id: "task-1", title: "Fix search", status: "todo" });
  session.taskUpdated({
    id: "task-1",
    title: "Fix search",
    status: "in_progress",
  });
  session.updateBindings(
    {
      ...bindings,
      messages: [
        message(id, "user", [text("Cria a task")]),
        message("a1", "assistant", [
          {
            type: "tool-TASK_BOARD_ITEM_CREATE",
            toolCallId: "call-1",
            state: "output-available",
            input: { title: "Fix search" },
            output: {
              item: { id: "task-1", title: "Fix search", status: "todo" },
            },
          },
          text("Criei a task."),
        ]),
      ],
    },
    true,
  );
  expect(workStatus().tasks).toEqual([
    { title: "Fix search", status: "in_progress" },
  ]);
  const before = updates.length;
  session.taskUpdated({ id: "other", title: "Unrelated", status: "done" });
  session.taskUpdated({
    id: "task-1",
    title: "Fix search",
    status: "in_progress",
  });
  expect(updates.length).toBe(before);
  session.taskUpdated({ id: "task-1", title: "Fix search", status: "done" });
  expect(updates.slice(before)[0]?.text).toBe(
    JSON.stringify({ task: "Fix search", status: "done" }),
  );
  session.taskDeleted("task-1");
  expect(workStatus().tasks).toEqual([]);
  session.stop();
});
