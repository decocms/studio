import { describe, expect, it } from "bun:test";
import type { UIMessageChunk } from "ai";
import { consumePartStream, type PartEmitterLike } from "./consume-part-stream";

function chunkStream(chunks: UIMessageChunk[]): AsyncIterable<UIMessageChunk> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

class CollectorEmitter implements PartEmitterLike {
  steps = 0;
  finals: { id: string; text: string }[] = [];
  errors: string[] = [];
  private textOf(m: { id: string; parts?: unknown[] }) {
    const t = (m.parts ?? []).find(
      (p): p is { type: string; text: string } =>
        typeof p === "object" &&
        p !== null &&
        (p as { type?: string }).type === "text",
    );
    return { id: m.id, text: t?.text ?? "" };
  }
  async emitStepParts() {
    this.steps++;
  }
  async emitFinal(m: { id: string; parts?: unknown[] }) {
    this.finals.push(this.textOf(m));
  }
  async emitError(_messageId: string, errorText: string) {
    this.errors.push(errorText);
  }
}

async function drain(s: ReadableStream): Promise<void> {
  const r = s.getReader();
  try {
    while (true) {
      const { done } = await r.read();
      if (done) break;
    }
  } finally {
    r.releaseLock();
  }
}

describe("consumePartStream", () => {
  it("assembles a text message, calls emitFinal, resolves whenComplete", async () => {
    const emitter = new CollectorEmitter();
    const chunks = chunkStream([
      { type: "start" },
      { type: "start-step" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "hello " },
      { type: "text-delta", id: "t1", delta: "world" },
      { type: "text-end", id: "t1" },
      { type: "finish-step" },
      { type: "finish" },
    ] as UIMessageChunk[]);
    const { uiStream, whenComplete } = consumePartStream(chunks, emitter);
    await drain(uiStream);
    await whenComplete;
    expect(emitter.finals.map((f) => f.text)).toEqual(["hello world"]);
    expect(emitter.errors).toEqual([]);
  });

  it("calls emitStepParts once per finished step", async () => {
    const emitter = new CollectorEmitter();
    const chunks = chunkStream([
      { type: "start" },
      { type: "start-step" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "a" },
      { type: "text-end", id: "t1" },
      { type: "finish-step" },
      { type: "start-step" },
      { type: "text-start", id: "t2" },
      { type: "text-delta", id: "t2", delta: "b" },
      { type: "text-end", id: "t2" },
      { type: "finish-step" },
      { type: "finish" },
    ] as UIMessageChunk[]);
    const { uiStream, whenComplete } = consumePartStream(chunks, emitter);
    await drain(uiStream);
    await whenComplete;
    expect(emitter.steps).toBe(2);
  });

  it("on a throwing source: emitError exactly once, no emitFinal, whenComplete resolves", async () => {
    const emitter = new CollectorEmitter();
    async function* throwing(): AsyncIterable<UIMessageChunk> {
      yield { type: "start" } as UIMessageChunk;
      throw new Error("desktop boom");
    }
    const { uiStream, whenComplete } = consumePartStream(throwing(), emitter);
    await drain(uiStream).catch(() => {});
    await whenComplete;
    expect(emitter.errors).toHaveLength(1);
    expect(emitter.errors[0]).toContain("boom");
    expect(emitter.finals).toEqual([]);
  });
});
