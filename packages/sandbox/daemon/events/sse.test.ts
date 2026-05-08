import { describe, expect, it } from "bun:test";
import { Broadcaster } from "./broadcast";
import { makeSseStream } from "./sse";

describe("makeSseStream", () => {
  const mkDeps = (b: Broadcaster) => ({
    broadcaster: b,
    getLastStatus: () => ({
      status: "booting" as const,
      port: null,
      htmlSupport: false,
    }),
    getDiscoveredScripts: () => null,
    getActiveTasks: () => [],
    getIntent: () => ({ state: "running" as const }),
    getLastBranchStatus: () => ({ kind: "initializing" as const }),
    maxClients: 10,
  });

  it("returns null when max clients exceeded", () => {
    const b = new Broadcaster(100);
    for (let i = 0; i < 10; i++) {
      b.register({
        enqueue: () => {},
      } as unknown as ReadableStreamDefaultController<Uint8Array>);
    }
    expect(makeSseStream(mkDeps(b))).toBeNull();
  });

  it("emits status event on connect", async () => {
    const b = new Broadcaster(100);
    const stream = makeSseStream(mkDeps(b))!;
    const reader = stream.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("event: status");
    await reader.cancel();
  });

  it("emits intent event in handshake", async () => {
    const b = new Broadcaster(100);
    const stream = makeSseStream(mkDeps(b))!;
    const reader = stream.getReader();
    // Read until we see intent or run out of buffered events.
    let combined = "";
    for (let i = 0; i < 20; i++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      combined += new TextDecoder().decode(chunk.value);
      if (combined.includes("event: intent")) break;
    }
    expect(combined).toContain("event: intent");
    expect(combined).toContain('"state":"running"');
    await reader.cancel();
  });
});
