import { describe, expect, it } from "bun:test";
import { Broadcaster } from "./broadcast";
import { makeSseStream } from "./sse";

describe("makeSseStream", () => {
  const mkDeps = (b: Broadcaster) => ({
    broadcaster: b,
    getLifecycle: () => ({ phase: "idle" as const }),
    getDiscoveredScripts: () => null,
    getActiveTasks: () => [],
    getStatus: () => ({ state: "running" as const }),
    getBranchMeta: () => ({ kind: "unknown" as const }),
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

  it("emits lifecycle event on connect", async () => {
    const b = new Broadcaster(100);
    const stream = makeSseStream(mkDeps(b))!;
    const reader = stream.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("event: lifecycle");
    await reader.cancel();
  });

  it("emits status event in handshake", async () => {
    const b = new Broadcaster(100);
    const stream = makeSseStream(mkDeps(b))!;
    const reader = stream.getReader();
    // Read until we see status or run out of buffered events.
    let combined = "";
    for (let i = 0; i < 20; i++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      combined += new TextDecoder().decode(chunk.value);
      if (combined.includes("event: status")) break;
    }
    expect(combined).toContain("event: status");
    expect(combined).toContain('"state":"running"');
    await reader.cancel();
  });
});
