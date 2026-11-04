import { describe, expect, test } from "bun:test";
import { chatRunning } from "./use-chat-running";

const NOW = Date.parse("2026-11-04T13:40:00.000Z");
const chat = (
  status: "in_progress" | "completed" | "failed",
  updated_at: string,
) => ({
  status,
  updated_at,
});

describe("chatRunning", () => {
  test("a chat in progress is running, whatever the card asked", () => {
    expect(
      chatRunning(
        chat("in_progress", "2026-11-04T13:30:00.000Z"),
        undefined,
        NOW,
      ),
    ).toBe(true);
  });

  test("a start asked after the chat last moved runs until the chat takes it", () => {
    expect(
      chatRunning(
        chat("completed", "2026-11-04T13:30:00.000Z"),
        "2026-11-04T13:39:30.000Z",
        NOW,
      ),
    ).toBe(true);
  });

  test("a chat that moved after the start was asked is done once it ends", () => {
    expect(
      chatRunning(
        chat("completed", "2026-11-04T13:39:50.000Z"),
        "2026-11-04T13:39:30.000Z",
        NOW,
      ),
    ).toBe(false);
  });

  test("a start the chat never took stops counting after the server's window", () => {
    expect(
      chatRunning(
        chat("failed", "2026-11-04T13:00:00.000Z"),
        "2026-11-04T13:30:00.000Z",
        NOW,
      ),
    ).toBe(false);
  });

  test("a chat not read yet runs only while a start was just asked", () => {
    expect(chatRunning(undefined, "2026-11-04T13:39:30.000Z", NOW)).toBe(true);
    expect(chatRunning(undefined, undefined, NOW)).toBe(false);
  });
});
