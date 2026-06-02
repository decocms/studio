import { describe, expect, test } from "bun:test";
import {
  FEEDBACK_MAX_TEXT_LENGTH,
  parseFeedbackBody,
  truncateForLog,
} from "./feedback";

describe("parseFeedbackBody", () => {
  test("general requires non-empty message", () => {
    expect(parseFeedbackBody({ message: "  hello  " })).toEqual({
      ok: true,
      entry: { kind: "general", message: "hello" },
    });
    expect(parseFeedbackBody({ message: "" }).ok).toBe(false);
    expect(parseFeedbackBody({}).ok).toBe(false);
  });

  test("chat_negative requires messageId and reasons or details", () => {
    expect(
      parseFeedbackBody({
        kind: "chat_negative",
        messageId: "msg-1",
        reasons: ["Slow or buggy"],
        details: " extra ",
      }),
    ).toEqual({
      ok: true,
      entry: {
        kind: "chat_negative",
        message: "extra",
        messageId: "msg-1",
        threadId: null,
        reasons: ["Slow or buggy"],
      },
    });
    expect(
      parseFeedbackBody({
        kind: "chat_negative",
        messageId: "msg-1",
        details: "only details",
      }).ok,
    ).toBe(true);
    expect(
      parseFeedbackBody({ kind: "chat_negative", messageId: "msg-1" }).ok,
    ).toBe(false);
  });

  test("rejects message over max length", () => {
    const long = "a".repeat(FEEDBACK_MAX_TEXT_LENGTH + 1);
    expect(parseFeedbackBody({ message: long }).ok).toBe(false);
  });
});

describe("truncateForLog", () => {
  test("truncates long text", () => {
    const { preview, truncated } = truncateForLog("x".repeat(600), 10);
    expect(truncated).toBe(true);
    expect(preview).toBe("xxxxxxxxxx…");
  });
});
