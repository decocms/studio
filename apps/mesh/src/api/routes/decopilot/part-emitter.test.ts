import { describe, it, expect } from "bun:test";
import { isFinalPart, PartEmitter } from "./part-emitter";
import type { ThreadMessagePart } from "@/storage/fold-parts";
import type { SqlThreadMessagePartStorage } from "@/storage/thread-message-parts";

// ---------------------------------------------------------------------------
// isFinalPart — pure
// ---------------------------------------------------------------------------

describe("isFinalPart", () => {
  it("text/reasoning: streaming is NOT final, done/undefined IS final", () => {
    expect(isFinalPart({ type: "text", state: "streaming" })).toBe(false);
    expect(isFinalPart({ type: "text", state: "done" })).toBe(true);
    expect(isFinalPart({ type: "text" })).toBe(true);
    expect(isFinalPart({ type: "reasoning", state: "streaming" })).toBe(false);
    expect(isFinalPart({ type: "reasoning", state: "done" })).toBe(true);
  });

  it("tool parts: only terminal output states are final", () => {
    expect(isFinalPart({ type: "tool-foo", state: "input-streaming" })).toBe(
      false,
    );
    expect(isFinalPart({ type: "tool-foo", state: "input-available" })).toBe(
      false,
    );
    expect(isFinalPart({ type: "tool-foo", state: "approval-requested" })).toBe(
      false,
    );
    expect(isFinalPart({ type: "tool-foo", state: "output-available" })).toBe(
      true,
    );
    expect(isFinalPart({ type: "tool-foo", state: "output-error" })).toBe(true);
    expect(isFinalPart({ type: "tool-foo", state: "output-denied" })).toBe(
      true,
    );
    expect(
      isFinalPart({ type: "dynamic-tool", state: "input-available" }),
    ).toBe(false);
    expect(
      isFinalPart({ type: "dynamic-tool", state: "output-available" }),
    ).toBe(true);
  });

  it("step-start is never persisted (not final)", () => {
    expect(isFinalPart({ type: "step-start" })).toBe(false);
  });

  it("file/source/data are terminal by nature", () => {
    expect(
      isFinalPart({ type: "file", url: "x", mediaType: "image/png" }),
    ).toBe(true);
    expect(isFinalPart({ type: "source-url" })).toBe(true);
    expect(isFinalPart({ type: "data-foo" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PartEmitter — id/seq/created_at scheme & idempotency.
// The collector below ONLY records the rows passed to appendParts; its return
// value (void) never feeds back into emitter logic, so this exercises pure
// emitter behavior, not a behavior-driving mock.
// ---------------------------------------------------------------------------

function makeCollector() {
  const rows: ThreadMessagePart[] = [];
  const storage = {
    appendParts: async (parts: ThreadMessagePart[]) => {
      // Mirror the real ON CONFLICT (id) DO NOTHING: first write of an id wins.
      for (const p of parts) {
        if (!rows.some((r) => r.id === p.id)) rows.push(p);
      }
    },
  } as unknown as SqlThreadMessagePartStorage;
  return { rows, storage };
}

function newEmitter(base = 1_000) {
  const { rows, storage } = makeCollector();
  const emitter = new PartEmitter({
    storage,
    orgId: "org1",
    threadId: "thrd1",
    runId: "run1",
    baseTimeMs: base,
  });
  return { rows, emitter };
}

describe("PartEmitter", () => {
  it("user message: emits final parts + one finish anchor with stable ids", async () => {
    const { rows, emitter } = newEmitter();
    await emitter.emitUserMessage({
      id: "msg_user",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    });

    expect(rows.map((r) => r.id)).toEqual(["run1:0", "run1:1"]);
    expect(rows[0]!.kind).toBe("text");
    expect(rows[1]!.kind).toBe("finish");
    // created_at derived from base + seq (monotonic), not Date.now()
    expect(rows[0]!.created_at).toBe(new Date(1_000).toISOString());
    expect(rows[1]!.created_at).toBe(new Date(1_001).toISOString());
  });

  it("payload is the exact source part element (read path folds it back)", async () => {
    const { rows, emitter } = newEmitter();
    const part = { type: "text", text: "hi", state: "done" };
    await emitter.emitFinal({ id: "m", role: "assistant", parts: [part] });
    expect(rows[0]!.payload).toEqual(part);
  });

  it("cumulative onStepFinish: a part that becomes final later lands once, at a stable seq", async () => {
    const { rows, emitter } = newEmitter();

    // Step 1: text done + tool call still in-flight (cumulative array).
    await emitter.emitStepParts({
      id: "m",
      role: "assistant",
      parts: [
        { type: "text", text: "thinking", state: "done" }, // idx 0 → final
        { type: "tool-x", state: "input-available", input: {} }, // idx 1 → not final
      ],
    });

    // Step 2: same array grows; tool now has output → becomes final.
    await emitter.emitStepParts({
      id: "m",
      role: "assistant",
      parts: [
        { type: "text", text: "thinking", state: "done" }, // idx 0 (already emitted)
        { type: "tool-x", state: "output-available", input: {}, output: 42 }, // idx 1 → now final
        { type: "text", text: "answer", state: "done" }, // idx 2 → final
      ],
    });

    // idx0 → seq0, idx1 → seq1 (stable across the two steps), idx2 → seq2.
    expect(rows.map((r) => r.id)).toEqual(["run1:0", "run1:1", "run1:2"]);
    const idx1 = rows.find((r) => r.id === "run1:1")!;
    expect(idx1.kind).toBe("tool_result");
    expect(idx1.payload).toMatchObject({ state: "output-available" });
  });

  it("re-emitting the same final array is idempotent (no duplicate rows)", async () => {
    const { rows, emitter } = newEmitter();
    const msg = {
      id: "m",
      role: "assistant" as const,
      parts: [{ type: "text", text: "a", state: "done" }],
    };
    await emitter.emitStepParts(msg);
    await emitter.emitStepParts(msg);
    await emitter.emitFinal(msg);
    await emitter.emitFinal(msg);
    // one text + one finish, regardless of repeated emits
    expect(rows.map((r) => r.id)).toEqual(["run1:0", "run1:1"]);
  });

  it("finish anchor is emitted at most once per message", async () => {
    const { rows, emitter } = newEmitter();
    await emitter.emitFinal({
      id: "m",
      role: "assistant",
      parts: [{ type: "text", text: "a", state: "done" }],
    });
    await emitter.emitFinal({
      id: "m",
      role: "assistant",
      parts: [{ type: "text", text: "a", state: "done" }],
    });
    expect(rows.filter((r) => r.kind === "finish")).toHaveLength(1);
  });

  it("error: emits an error part + finish", async () => {
    const { rows, emitter } = newEmitter();
    await emitter.emitError("msg_err", "boom");
    expect(rows.map((r) => r.kind)).toEqual(["error", "finish"]);
    expect(rows[0]!.payload).toMatchObject({ text: "Error: boom" });
  });

  it("user-before-assistant ordering holds via monotonic created_at", async () => {
    const { rows, emitter } = newEmitter();
    await emitter.emitUserMessage({
      id: "u",
      role: "user",
      parts: [{ type: "text", text: "q" }],
    });
    await emitter.emitFinal({
      id: "a",
      role: "assistant",
      parts: [{ type: "text", text: "r", state: "done" }],
    });
    const u = rows.find((r) => r.message_id === "u" && r.kind === "text")!;
    const a = rows.find((r) => r.message_id === "a" && r.kind === "text")!;
    expect(u.created_at < a.created_at).toBe(true);
  });
});
