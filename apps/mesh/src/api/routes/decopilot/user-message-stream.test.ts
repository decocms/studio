import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
  buildUserMessageChunk,
  isUserMessageControlChunk,
  publishUserMessage,
  USER_MESSAGE_CHUNK_TYPE,
} from "./user-message-stream";

const MESSAGE = {
  id: "u-1",
  role: "user",
  parts: [{ type: "text", text: "hello" }],
} as unknown as UIMessage;

describe("buildUserMessageChunk", () => {
  test("wraps the message in a data-user-message chunk", () => {
    expect(buildUserMessageChunk(MESSAGE)).toEqual({
      type: USER_MESSAGE_CHUNK_TYPE,
      data: MESSAGE,
    });
  });
});

describe("isUserMessageControlChunk", () => {
  test("matches the control chunk and nothing else", () => {
    expect(isUserMessageControlChunk(buildUserMessageChunk(MESSAGE))).toBe(
      true,
    );
    expect(isUserMessageControlChunk({ type: "data-run-status" })).toBe(false);
    expect(isUserMessageControlChunk({ type: "text-delta" })).toBe(false);
    expect(isUserMessageControlChunk(null)).toBe(false);
    expect(isUserMessageControlChunk("data-user-message")).toBe(false);
  });
});

describe("publishUserMessage", () => {
  test("publishes the chunk via streamBuffer.publishRawChunk", async () => {
    const calls: Array<{ taskId: string; chunk: unknown }> = [];
    await publishUserMessage(
      {
        publishRawChunk: async (taskId, chunk) => {
          calls.push({ taskId, chunk });
          return true;
        },
      },
      "task-1",
      MESSAGE,
    );
    expect(calls).toEqual([
      { taskId: "task-1", chunk: buildUserMessageChunk(MESSAGE) },
    ]);
  });

  test("is a no-op without a stream buffer", async () => {
    await expect(
      publishUserMessage(undefined, "task-1", MESSAGE),
    ).resolves.toBeUndefined();
  });

  test("swallows publish errors (best-effort)", async () => {
    await expect(
      publishUserMessage(
        {
          publishRawChunk: async () => {
            throw new Error("nats down");
          },
        },
        "task-1",
        MESSAGE,
      ),
    ).resolves.toBeUndefined();
  });
});
