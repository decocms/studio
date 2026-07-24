import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
  deriveHighlightFlags,
  type HighlightFlags,
} from "./use-highlight-count";

const noFlags: HighlightFlags = {
  isCreditExhausted: false,
  isPaidSeatRequired: false,
  hasTodos: false,
  showError: false,
  showWarning: false,
  hasApprovals: false,
  hasPlans: false,
  isWaitingForUserInput: false,
  todos: [],
};

const baseInput = {
  messages: [] as UIMessage[],
  error: null as Error | null,
  finishReason: null as string | null,
  isStreaming: false,
  isWaitingForApprovals: false,
};

describe("deriveHighlightFlags", () => {
  test("empty state → all flags false", () => {
    expect(deriveHighlightFlags(baseInput)).toEqual(noFlags);
  });

  test("error while not streaming → showError true", () => {
    expect(
      deriveHighlightFlags({
        ...baseInput,
        error: new Error("boom"),
      }),
    ).toEqual({ ...noFlags, showError: true });
  });

  test("error while streaming → showError false", () => {
    expect(
      deriveHighlightFlags({
        ...baseInput,
        error: new Error("boom"),
        isStreaming: true,
      }),
    ).toEqual(noFlags);
  });

  test("credit error → isCreditExhausted true, all other flags false", () => {
    // isCreditError checks for `[CREDITS]` prefix in the error message.
    const err = new Error("[CREDITS] insufficient credits");
    expect(
      deriveHighlightFlags({
        ...baseInput,
        error: err,
      }),
    ).toEqual({ ...noFlags, isCreditExhausted: true });
  });

  test("paid-seat error → isPaidSeatRequired true, all other flags false", () => {
    // isPaidSeatError checks for `[PAID_SEAT_REQUIRED]` prefix.
    const err = new Error("[PAID_SEAT_REQUIRED] this action needs a paid seat");
    expect(
      deriveHighlightFlags({
        ...baseInput,
        error: err,
      }),
    ).toEqual({ ...noFlags, isPaidSeatRequired: true });
  });

  test("paid-seat error while streaming → showError false", () => {
    expect(
      deriveHighlightFlags({
        ...baseInput,
        error: new Error("[PAID_SEAT_REQUIRED] nope"),
        isStreaming: true,
      }),
    ).toEqual(noFlags);
  });

  test("finishReason 'length' (not streaming, no error) → showWarning true", () => {
    expect(
      deriveHighlightFlags({
        ...baseInput,
        finishReason: "length",
      }),
    ).toEqual({ ...noFlags, showWarning: true });
  });

  test("finishReason 'stop' → showWarning false (normal completion)", () => {
    expect(
      deriveHighlightFlags({
        ...baseInput,
        finishReason: "stop",
      }),
    ).toEqual(noFlags);
  });

  test("finishReason 'tool-calls' with pending user_ask → showWarning suppressed", () => {
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-user_ask",
            toolCallId: "c1",
            state: "input-available",
            input: { question: "?" },
          },
        ],
      } as unknown as UIMessage,
    ];
    expect(
      deriveHighlightFlags({
        ...baseInput,
        finishReason: "tool-calls",
        messages,
      }),
    ).toEqual({ ...noFlags, isWaitingForUserInput: true });
  });

  test("todos present → hasTodos true, todos exposed for reuse", () => {
    const todos = [
      {
        content: "A",
        activeForm: "Doing A",
        status: "pending" as const,
      },
    ];
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-todo_write",
            toolCallId: "c1",
            state: "input-available",
            input: { todos },
          },
        ],
      } as unknown as UIMessage,
    ];
    expect(deriveHighlightFlags({ ...baseInput, messages })).toEqual({
      ...noFlags,
      hasTodos: true,
      todos,
    });
  });

  test("streaming + isWaitingForApprovals → hasApprovals true", () => {
    expect(
      deriveHighlightFlags({
        ...baseInput,
        isStreaming: true,
        isWaitingForApprovals: true,
      }),
    ).toEqual({ ...noFlags, hasApprovals: true });
  });
});
