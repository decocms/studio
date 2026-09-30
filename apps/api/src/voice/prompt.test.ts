import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { TEXT_MODE_PROMPT, VOICE_MODE_PROMPT } from "@decocms/shared/voice";
import { withVoiceResponseStyle } from "./prompt";

test("turn style reaches the coding-agent message without changing persisted user text", () => {
  const message: UIMessage = {
    id: "message_example",
    role: "user",
    parts: [{ type: "text", text: "Change the homepage title" }],
  };
  const spoken = withVoiceResponseStyle(message, true);
  expect(spoken.parts.at(-1)).toEqual({
    type: "text",
    text: VOICE_MODE_PROMPT,
  });
  expect(withVoiceResponseStyle(message, false).parts.at(-1)).toEqual({
    type: "text",
    text: TEXT_MODE_PROMPT,
  });
  expect(message.parts).toHaveLength(1);
  expect(spoken.parts[0]).toEqual(message.parts[0]);
  expect(spoken.id).toBe(message.id);
});

test("spoken request context follows the style without joining the user text", () => {
  const message: UIMessage = {
    id: "message_example",
    role: "user",
    parts: [{ type: "text", text: "And the second one?" }],
  };
  const spoken = withVoiceResponseStyle(message, true, "voice context");
  expect(spoken.parts).toEqual([
    message.parts[0],
    { type: "text", text: VOICE_MODE_PROMPT },
    { type: "text", text: "voice context" },
  ]);
  expect(withVoiceResponseStyle(message, true).parts).toHaveLength(2);
});
