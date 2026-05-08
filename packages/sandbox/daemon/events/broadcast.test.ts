import { describe, expect, it } from "bun:test";
import { Broadcaster } from "./broadcast";

describe("Broadcaster", () => {
  it("fans out log events to registered controllers", () => {
    const b = new Broadcaster(100);
    const sink: Uint8Array[] = [];
    const ctrl = {
      enqueue: (bytes: Uint8Array) => sink.push(bytes),
    } as unknown as ReadableStreamDefaultController<Uint8Array>;
    b.register(ctrl);

    b.broadcastChunk("setup", "hello\n");
    expect(sink.length).toBe(1);
    const text = new TextDecoder().decode(sink[0]);
    expect(text).toContain("event: log");
    expect(text).toContain("hello");
  });

  it("survives a controller whose enqueue throws", () => {
    const b = new Broadcaster(100);
    b.register({
      enqueue: () => {
        throw new Error("closed");
      },
    } as unknown as ReadableStreamDefaultController<Uint8Array>);
    // Must not throw.
    b.broadcastEvent("status", { ready: true });
  });

  it("records chunks into its replay buffer", () => {
    const b = new Broadcaster(100);
    b.broadcastChunk("setup", "abc");
    expect(b.replay.read("setup")).toBe("abc");
  });
});
