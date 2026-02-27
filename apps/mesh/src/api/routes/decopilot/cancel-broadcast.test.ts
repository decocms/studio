import { describe, it, expect } from "bun:test";
import { LocalCancelBroadcast } from "./cancel-broadcast";

describe("LocalCancelBroadcast", () => {
  it("start stores the onCancel callback", async () => {
    const broadcast = new LocalCancelBroadcast();
    const cancelled: string[] = [];

    await broadcast.start((id) => cancelled.push(id));
    broadcast.broadcast("thread-1");

    expect(cancelled).toEqual(["thread-1"]);
  });

  it("broadcast invokes callback for each call", async () => {
    const broadcast = new LocalCancelBroadcast();
    const cancelled: string[] = [];

    await broadcast.start((id) => cancelled.push(id));
    broadcast.broadcast("a");
    broadcast.broadcast("b");

    expect(cancelled).toEqual(["a", "b"]);
  });

  it("stop nulls the callback so broadcast is a no-op", async () => {
    const broadcast = new LocalCancelBroadcast();
    const cancelled: string[] = [];

    await broadcast.start((id) => cancelled.push(id));
    await broadcast.stop();
    broadcast.broadcast("thread-1");

    expect(cancelled).toHaveLength(0);
  });

  it("broadcast before start is a no-op (no throw)", () => {
    const broadcast = new LocalCancelBroadcast();
    expect(() => broadcast.broadcast("thread-1")).not.toThrow();
  });
});
