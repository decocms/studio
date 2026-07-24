/**
 * Usage metadata tests
 *
 * Regression tests for usage calculation correctness.
 * Verifies that usage is attached per-message (from finish part)
 * rather than accumulated across messages.
 */

import { describe, expect, test } from "bun:test";
import { calculateUsageStats } from "@decocms/shared/sdk";

describe("calculateUsageStats - multi-turn usage", () => {
  /**
   * Regression test: each message should have only its own usage.
   * When backend sends correct per-message usage, thread total = sum of messages.
   */
  test("sums per-message usage correctly for multi-turn conversation", () => {
    const messages = [
      {
        id: "msg-1",
        role: "assistant" as const,
        metadata: {
          usage: {
            totalTokens: 1000,
            inputTokens: 500,
            outputTokens: 500,
          },
        },
      },
      {
        id: "msg-2",
        role: "assistant" as const,
        metadata: {
          usage: {
            totalTokens: 500,
            inputTokens: 200,
            outputTokens: 300,
          },
        },
      },
    ];

    const result = calculateUsageStats(messages);

    expect(result.totalTokens).toBe(1500);
    expect(result.inputTokens).toBe(700);
    expect(result.outputTokens).toBe(800);
  });

  test("handles messages with no usage", () => {
    const messages = [
      { metadata: { usage: { totalTokens: 100 } } },
      { metadata: {} },
    ];

    const result = calculateUsageStats(messages);

    expect(result.totalTokens).toBe(100);
  });
});
