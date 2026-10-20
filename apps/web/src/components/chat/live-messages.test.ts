import { describe, expect, test } from "bun:test";
import { placeLiveMessages, withLiveRunId } from "./live-messages.ts";
import type { ChatMessage } from "./types.ts";

const user = (id: string, liveRunId?: string): ChatMessage =>
  ({
    id,
    role: "user",
    parts: [{ type: "text", text: id }],
    metadata: liveRunId ? { liveRunId } : {},
  }) as ChatMessage;

const assistant = (id: string, readIds: string[] = []): ChatMessage =>
  ({
    id,
    role: "assistant",
    parts: [
      { type: "text", text: "working" },
      ...readIds.map((messageId) => ({
        type: "data-live-message",
        id: `live-message-${messageId}`,
        data: { messageId },
      })),
      { type: "text", text: "done" },
    ],
  }) as unknown as ChatMessage;

const ids = (messages: ChatMessage[]) => messages.map((m) => m.id);

describe("placeLiveMessages", () => {
  test("a read message renders at its part, not as a turn of its own", () => {
    const placed = placeLiveMessages(
      [user("u1"), assistant("a1", ["live1"]), user("live1", "thrd:f1")],
      false,
    );
    expect(ids(placed.visible)).toEqual(["u1", "a1"]);
    expect([...placed.read.keys()]).toEqual(["live1"]);
    expect(placed.pending).toEqual([]);
  });

  test("an unread one waits under the running turn", () => {
    const placed = placeLiveMessages(
      [user("u1"), assistant("a1"), user("live1", "thrd:f1")],
      true,
    );
    expect(ids(placed.visible)).toEqual(["u1", "a1"]);
    expect(ids(placed.pending)).toEqual(["live1"]);
  });

  test("an unread one shows as a plain message once the run is over", () => {
    const placed = placeLiveMessages(
      [user("u1"), assistant("a1"), user("live1", "thrd:f1")],
      false,
    );
    expect(ids(placed.visible)).toEqual(["u1", "a1", "live1"]);
    expect(placed.pending).toEqual([]);
  });

  test("ordinary messages are untouched", () => {
    const messages = [user("u1"), assistant("a1"), user("u2")];
    const placed = placeLiveMessages(messages, true);
    expect(placed.visible).toEqual(messages);
  });

  test("withLiveRunId keeps the rest of the metadata", () => {
    const tagged = withLiveRunId(
      {
        ...user("u1"),
        metadata: { created_at: "2026-01-01T00:00:00.000Z" },
      } as ChatMessage,
      "thrd:f1",
    );
    expect(tagged.metadata).toEqual({
      created_at: "2026-01-01T00:00:00.000Z",
      liveRunId: "thrd:f1",
    });
  });
});
