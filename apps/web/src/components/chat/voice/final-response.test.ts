import { expect, test } from "bun:test";
import type { ChatMessage } from "../types";
import { finalVoiceResponse } from "./final-response";

const user: ChatMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "Change the title" }],
};
const reply = (parts: ChatMessage["parts"]): ChatMessage => ({
  id: "assistant-1",
  role: "assistant",
  parts,
});

test("speaks only the final text part of the matching turn", () => {
  const messages: ChatMessage[] = [
    user,
    reply([
      { type: "reasoning", text: "Private reasoning", state: "done" },
      { type: "text", text: "Intermediate commentary", state: "done" },
      { type: "step-start" },
      {
        type: "text",
        text: "Changed the **title**. [Preview](https://example.test)",
        state: "done",
      },
    ]),
    { ...user, id: "user-2" },
    { ...reply([{ type: "text", text: "Another answer" }]), id: "assistant-2" },
  ];
  expect(finalVoiceResponse(messages, "user-1")).toBe(
    "Changed the title. Preview",
  );
  expect(finalVoiceResponse(messages, "user-2")).toBe("Another answer");
  expect(finalVoiceResponse(messages, "missing")).toBeNull();
});

test("waits for streaming text, tool execution and approvals", () => {
  expect(finalVoiceResponse([user], user.id)).toBeNull();
  expect(
    finalVoiceResponse(
      [user, reply([{ type: "text", text: "Partial", state: "streaming" }])],
      user.id,
    ),
  ).toBeNull();
  for (const state of ["input-available", "approval-requested"] as const) {
    const tool =
      state === "input-available"
        ? {
            type: "dynamic-tool" as const,
            toolName: "edit",
            toolCallId: "tool-1",
            state,
            input: {},
          }
        : {
            type: "dynamic-tool" as const,
            toolName: "edit",
            toolCallId: "tool-1",
            state,
            input: {},
            approval: { id: "approval-1" },
          };
    expect(
      finalVoiceResponse(
        [user, reply([{ type: "text", text: "Working" }, tool])],
        user.id,
      ),
    ).toBeNull();
  }
});

test("does not read code blocks or tool-only responses aloud", () => {
  expect(
    finalVoiceResponse(
      [user, reply([{ type: "text", text: "```js\nsecret();\n```" }])],
      user.id,
    ),
  ).toBe("");
  expect(
    finalVoiceResponse(
      [
        user,
        reply([
          {
            type: "dynamic-tool",
            toolName: "edit",
            toolCallId: "tool-1",
            state: "output-available",
            input: {},
            output: "Tool payload",
          },
        ]),
      ],
      user.id,
    ),
  ).toBe("");
  const result = finalVoiceResponse(
    [user, reply([{ type: "text", text: "A long reply. ".repeat(1500) }])],
    user.id,
  );
  expect(result!.length).toBeLessThanOrEqual(12000);
});
