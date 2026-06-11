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

  it("unregisters the client when the request signal aborts", async () => {
    const b = new Broadcaster(100);
    const ctl = new AbortController();
    const stream = makeSseStream({ ...mkDeps(b), signal: ctl.signal })!;
    const reader = stream.getReader();
    await reader.read(); // drive start() so the controller registers
    expect(b.size()).toBe(1);
    ctl.abort();
    expect(b.size()).toBe(0);
    await reader.cancel();
  });

  it("does not register when the signal is already aborted", async () => {
    const b = new Broadcaster(100);
    const ctl = new AbortController();
    ctl.abort();
    const stream = makeSseStream({ ...mkDeps(b), signal: ctl.signal })!;
    const reader = stream.getReader();
    await reader.read();
    expect(b.size()).toBe(0);
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
