import { describe, expect, it } from "bun:test";
import type { UIMessageChunk } from "ai";
import { consumePartStream, type PartEmitterLike } from "./consume-part-stream";

function chunkStream(chunks: UIMessageChunk[]): AsyncIterable<UIMessageChunk> {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

class CollectorEmitter implements PartEmitterLike {
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
  async emitStepParts() {}
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
  it("assembles a text message and calls emitFinal", async () => {
    const emitter = new CollectorEmitter();
    // Chunk type names confirmed from ai@6.0.191 UIMessageChunk union:
    //   'start', 'text-start', 'text-delta', 'text-end', 'finish'
    // The 'start-step'/'finish-step' pair marks steps; 'start'/'finish' wrap the message.
    const chunks = chunkStream([
      { type: "start" } as UIMessageChunk,
      { type: "start-step" } as UIMessageChunk,
      { type: "text-start", id: "t1" } as UIMessageChunk,
      { type: "text-delta", id: "t1", delta: "hello " } as UIMessageChunk,
      { type: "text-delta", id: "t1", delta: "world" } as UIMessageChunk,
      { type: "text-end", id: "t1" } as UIMessageChunk,
      { type: "finish-step" } as UIMessageChunk,
      { type: "finish" } as UIMessageChunk,
    ]);
    const ui = consumePartStream(chunks, emitter);
    await drain(ui);
    expect(emitter.finals.map((f) => f.text)).toEqual(["hello world"]);
  });
});
