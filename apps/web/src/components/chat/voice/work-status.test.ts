import { expect, test } from "bun:test";
import type { ChatMessage } from "../types";
import { backgroundReactionId, turnActivity } from "./work-status";

const user = (id: string): ChatMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: "Analyze the cache and file a task" }],
});
function toolMessage(id: string, parts: unknown[], metadata?: object) {
  // MCP tool parts arrive over the wire outside the built-in part union.
  const message: ChatMessage = JSON.parse(
    JSON.stringify({ id, role: "assistant", parts, metadata }),
  );
  return message;
}
const started = (jobId: string, state = "output-available") => ({
  type: "tool-subtask",
  toolCallId: `call-${jobId}`,
  state,
  input: { prompt: "Analyze", background: true },
  output: { background: true, status: "started", jobId, note: "Running" },
});
const created = (id: string) => ({
  type: "tool-TASK_BOARD_ITEM_CREATE",
  toolCallId: `call-${id}`,
  state: "output-available",
  input: { title: "Fix search" },
  output: {
    item: { id, title: "Fix search", status: "todo" },
    deduplicated: false,
  },
});

test("finds background subtasks and created tasks of one turn", () => {
  const messages = [
    user("u1"),
    toolMessage("a1", [started("job-1"), created("task-1")]),
    user("u2"),
    toolMessage("a2", [created("task-2")]),
  ];
  expect(turnActivity(messages, "u1")).toEqual({
    backgroundJobs: ["job-1"],
    tasks: [{ id: "task-1", title: "Fix search", status: "todo" }],
  });
  expect(turnActivity(messages, "u2").tasks.map((task) => task.id)).toEqual([
    "task-2",
  ]);
  expect(turnActivity(messages, "missing")).toEqual({
    backgroundJobs: [],
    tasks: [],
  });
});

test("ignores unfinished, inline, malformed and nested subtask output", () => {
  const messages = [
    user("u1"),
    toolMessage("a1", [
      started("pending", "input-available"),
      {
        type: "tool-subtask",
        toolCallId: "inline",
        state: "output-available",
        output: { text: "Inline answer" },
      },
      {
        type: "tool-TASK_BOARD_ITEM_CREATE",
        toolCallId: "broken",
        state: "output-available",
        output: { item: { title: "No id" } },
      },
    ]),
    toolMessage("s1", [created("from-subagent")], { subtaskJobId: "job-1" }),
  ];
  expect(turnActivity(messages, "u1")).toEqual({
    backgroundJobs: [],
    tasks: [],
  });
});

test("a background reaction is its own turn", () => {
  const reaction = backgroundReactionId("job-1");
  const messages = [
    user("u1"),
    toolMessage("a1", [started("job-1")]),
    { ...user(reaction), metadata: { internal: true } },
    toolMessage("a2", [created("task-3")]),
  ];
  expect(turnActivity(messages, "u1").tasks).toEqual([]);
  expect(turnActivity(messages, reaction).tasks.map((task) => task.id)).toEqual(
    ["task-3"],
  );
});
