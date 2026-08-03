import type { UIMessageChunk } from "ai";
import { describe, expect, test } from "bun:test";
import { makeTitleResultChunk } from "@/harnesses/lib/title-chunk";
import { DEFAULT_THREAD_TITLE } from "./constants";
import {
  consumeHarnessStream,
  type HarnessStreamPersistence,
} from "./consume-harness-stream";
import { projectChunks } from "./project-chunks";

function helloChunks(): AsyncIterable<UIMessageChunk> {
  return (async function* () {
    yield { type: "start" } as UIMessageChunk;
    yield {
      type: "message-metadata",
      messageMetadata: {
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    } as UIMessageChunk;
    yield { type: "text-start", id: "txt" } as UIMessageChunk;
    yield { type: "text-delta", id: "txt", delta: "hello" } as UIMessageChunk;
    yield { type: "text-end", id: "txt" } as UIMessageChunk;
    yield {
      type: "finish",
      finishReason: "stop",
      totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    } as UIMessageChunk;
  })();
}

/** A turn whose stream carries an auto-generated title-result chunk. */
function helloChunksWithTitle(title: string): AsyncIterable<UIMessageChunk> {
  return (async function* () {
    yield { type: "start" } as UIMessageChunk;
    yield makeTitleResultChunk(title) as unknown as UIMessageChunk;
    yield { type: "text-start", id: "txt" } as UIMessageChunk;
    yield { type: "text-delta", id: "txt", delta: "hello" } as UIMessageChunk;
    yield { type: "text-end", id: "txt" } as UIMessageChunk;
    yield { type: "finish", finishReason: "stop" } as UIMessageChunk;
  })();
}

function recordingPersistence() {
  const finals: Array<{ id: string; parts?: unknown[] }> = [];
  const errors: Array<[string, string]> = [];
  const persistence: HarnessStreamPersistence = {
    emitStepParts: async () => {},
    emitFinal: async (m) => {
      finals.push(m);
    },
    emitError: async (id, text) => {
      errors.push([id, text]);
    },
  };
  return { finals, errors, persistence };
}

describe("projectChunks", () => {
  test("reassembles raw chunks and persists the final assistant message", async () => {
    const { finals, persistence } = recordingPersistence();
    const result = await projectChunks({ chunks: helloChunks(), persistence });
    expect(finals).toHaveLength(1);
    const text = (finals[0]!.parts ?? []).find(
      (p) => (p as { type?: string }).type === "text",
    ) as { text?: string } | undefined;
    expect(text?.text).toBe("hello");
    expect(result.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    });
  });

  test("a thrown source surfaces via emitError and rethrows", async () => {
    const { errors, persistence } = recordingPersistence();
    const boom = (async function* () {
      yield { type: "start" } as UIMessageChunk;
      throw new Error("provider exploded");
    })();
    await expect(projectChunks({ chunks: boom, persistence })).rejects.toThrow(
      "provider exploded",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]![1]).toBe("provider exploded");
  });

  test("persists the auto-title when the thread title is still the default", async () => {
    const { persistence } = recordingPersistence();
    const persisted: Array<{ threadId: string; title: string }> = [];
    await projectChunks({
      chunks: helloChunksWithTitle("Generated Title"),
      persistence,
      title: {
        threadId: "run_1",
        currentThreadTitle: DEFAULT_THREAD_TITLE,
        persistTitle: async (threadId, title) => {
          persisted.push({ threadId, title });
        },
      },
    });
    expect(persisted).toEqual([
      { threadId: "run_1", title: "Generated Title" },
    ]);
  });

  test("does NOT overwrite a user-renamed (non-default) thread title", async () => {
    const { persistence } = recordingPersistence();
    const persisted: Array<{ threadId: string; title: string }> = [];
    await projectChunks({
      chunks: helloChunksWithTitle("Auto Title Should Not Apply"),
      persistence,
      title: {
        threadId: "run_1",
        currentThreadTitle: "User Renamed Me",
        persistTitle: async (threadId, title) => {
          persisted.push({ threadId, title });
        },
      },
    });
    // The gate is closed (current title != default) — the auto-title is dropped.
    expect(persisted).toEqual([]);
  });

  test("a persistence failure (emitFinal throws) surfaces so the projector can retry", async () => {
    // The durable DB-writer's contract is "persist or fail loudly".
    // consumeHarnessStream swallows persistence errors (logs them) so the live
    // UI path survives a DB hiccup; the projector must NOT — a swallowed write
    // would silently lose a part. projectChunks re-throws it so the projector
    // consumer can retry or DLQ the run.
    const persistence: HarnessStreamPersistence = {
      emitStepParts: async () => {},
      emitFinal: async () => {
        throw new Error("db write failed");
      },
      emitError: async () => {},
    };
    await expect(
      projectChunks({ chunks: helloChunks(), persistence }),
    ).rejects.toThrow("db write failed");
  });

  // ── Task 4: characterization ─────────────────────────────────────────────
  // Observed signal for a stream that ends in an in-band {type:"error"} chunk
  // (no {type:"finish"} chunk follows). This pins the detector used in Task 5.
  //
  // OBSERVED (run 2026-06-17):
  //   finishReason: undefined   — the SDK does NOT set finishReason for error
  //                               chunks; the 'finish' chunk was never emitted.
  //   onError fires:  true      — processUIMessageStream case "error" calls
  //                               onError(new Error(chunk.errorText)), which
  //                               flows to consumeHarnessStream's onError and
  //                               then to hooks.onError.
  //   error part in message:    — the SDK does NOT add an error part to
  //     none                      message.parts; onError is a side-channel.
  //
  // DETECTOR RULE (Task 5): key off hooks.onError firing (an `errorSeen` flag),
  // NOT finishReason === "error" (that never comes). This is the terminal signal
  // because a multi-step agent that emits an error mid-run then recovers would
  // have emitted a {type:"finish"} chunk afterwards — meaning the final finish
  // chunk's finishReason would be something other than error, and the error
  // would not be the LAST observable event.
  test("characterize: in-band error chunk → onError fires, finishReason is undefined (D)", async () => {
    // A harness-error stream: partial text then an in-band error chunk, no
    // {type:"finish"} follows (matches link-ingest error event shape).
    const errorStream = (async function* (): AsyncGenerator<UIMessageChunk> {
      yield { type: "start" } as UIMessageChunk;
      yield { type: "text-start", id: "t" } as UIMessageChunk;
      yield { type: "text-delta", id: "t", delta: "partial" } as UIMessageChunk;
      yield { type: "text-end", id: "t" } as UIMessageChunk;
      yield {
        type: "error",
        errorText: "harness_error: boom",
      } as UIMessageChunk;
    })();

    let observedFinishReason: string | undefined = "NOT_CALLED";
    let observedOnErrorFired = false;
    const emittedErrors: Array<[string, string]> = [];

    const noopPersistence: HarnessStreamPersistence = {
      emitStepParts: async () => {},
      emitFinal: async () => {},
      emitError: async (id, text) => {
        emittedErrors.push([id, text]);
      },
    };

    // Drive the stream directly through consumeHarnessStream so we can
    // observe the raw hook values without projectChunks's error-capture layer.
    const { uiStream, whenComplete } = consumeHarnessStream({
      chunks: errorStream,
      originalMessages: [],
      title: {
        currentThreadTitle: undefined,
        threadId: "char-test",
        persistTitle: async () => {},
      },
      persistence: noopPersistence,
      hooks: {
        onFinish: (_message, finishReason) => {
          observedFinishReason = finishReason;
        },
        onError: () => {
          observedOnErrorFired = true;
        },
      },
    });

    const reader = uiStream.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
    await whenComplete;

    // OBSERVED: finishReason is undefined (no {type:"finish"} chunk was emitted)
    expect(observedFinishReason).toBeUndefined();
    // OBSERVED: onError hook fires for in-band error chunks
    expect(observedOnErrorFired).toBe(true);
    // OBSERVED: emitError is called with the raw error text
    expect(emittedErrors).toHaveLength(1);
    expect(emittedErrors[0]![1]).toBe("harness_error: boom");
  });

  // ── Task 5: outcome surfacing ────────────────────────────────────────────
  test("reports failed=true when the reconstructed run ends in a harness error", async () => {
    const errorEndingStream =
      (async function* (): AsyncGenerator<UIMessageChunk> {
        yield { type: "start" } as UIMessageChunk;
        yield { type: "text-start", id: "t" } as UIMessageChunk;
        yield {
          type: "text-delta",
          id: "t",
          delta: "partial",
        } as UIMessageChunk;
        yield { type: "text-end", id: "t" } as UIMessageChunk;
        yield {
          type: "error",
          errorText: "harness_error: boom",
        } as UIMessageChunk;
      })();

    const noopPersistence: HarnessStreamPersistence = {
      emitStepParts: async () => {},
      emitFinal: async () => {},
      emitError: async () => {},
    };

    const res = await projectChunks({
      chunks: errorEndingStream,
      persistence: noopPersistence,
    });
    expect(res.failed).toBe(true);
  });

  test("reports failed=false for a clean finish", async () => {
    const noopPersistence: HarnessStreamPersistence = {
      emitStepParts: async () => {},
      emitFinal: async () => {},
      emitError: async () => {},
    };

    const res = await projectChunks({
      chunks: helloChunks(),
      persistence: noopPersistence,
    });
    expect(res.failed).toBe(false);
    // finishReason propagated so downstream consumers (Task 6 workflow) can read it.
    expect(res.finishReason).toBe("stop");
  });

  test("captures usage totals from the finish chunk", async () => {
    const noopPersistence: HarnessStreamPersistence = {
      emitStepParts: async () => {},
      emitFinal: async () => {},
      emitError: async () => {},
    };

    const res = await projectChunks({
      chunks: helloChunks(),
      persistence: noopPersistence,
    });

    expect(res.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    });
  });

  test("defaults usage totals to zero when no usage hook fires", async () => {
    const noopPersistence: HarnessStreamPersistence = {
      emitStepParts: async () => {},
      emitFinal: async () => {},
      emitError: async () => {},
    };

    const res = await projectChunks({
      chunks: helloChunksWithTitle("Generated Title"),
      persistence: noopPersistence,
    });

    expect(res.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });

  // ── I1 regression guard: mid-run error then recovery ─────────────────────
  // A multi-step run that emits an error chunk mid-run then RECOVERS and ends
  // with a natural {type:"finish"} must NOT be classified as failed. The
  // terminal outcome (finish) wins over the non-terminal in-band error.
  test("mid-run error followed by recovery finish → failed=false (I1 regression guard)", async () => {
    const recoveryStream = (async function* (): AsyncGenerator<UIMessageChunk> {
      yield { type: "start" } as UIMessageChunk;
      yield { type: "text-start", id: "t1" } as UIMessageChunk;
      yield {
        type: "text-delta",
        id: "t1",
        delta: "before error",
      } as UIMessageChunk;
      yield { type: "text-end", id: "t1" } as UIMessageChunk;
      yield {
        type: "error",
        errorText: "transient_error: retry-able",
      } as UIMessageChunk;
      yield { type: "text-start", id: "t2" } as UIMessageChunk;
      yield {
        type: "text-delta",
        id: "t2",
        delta: "after recovery",
      } as UIMessageChunk;
      yield { type: "text-end", id: "t2" } as UIMessageChunk;
      yield {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      } as UIMessageChunk;
    })();

    const noopPersistence: HarnessStreamPersistence = {
      emitStepParts: async () => {},
      emitFinal: async () => {},
      emitError: async () => {},
    };

    const res = await projectChunks({
      chunks: recoveryStream,
      persistence: noopPersistence,
    });
    // Error was non-terminal — the stream recovered and finished naturally.
    expect(res.failed).toBe(false);
    expect(res.finishReason).toBe("stop");
  });

  test("a thrown source error still throws (not classified as failed=true)", async () => {
    // A THROWN exception from the source (infra/redelivery signal) must still
    // throw — it is not a "clean harness error verdict".
    const noopPersistence: HarnessStreamPersistence = {
      emitStepParts: async () => {},
      emitFinal: async () => {},
      emitError: async () => {},
    };
    const boom = (async function* () {
      yield { type: "start" } as UIMessageChunk;
      throw new Error("provider exploded");
    })();
    await expect(
      projectChunks({ chunks: boom, persistence: noopPersistence }),
    ).rejects.toThrow("provider exploded");
  });

  test("ignores data-run-status chunks when projecting assistant parts", async () => {
    const emitted: Array<{ id: string; parts?: unknown[] }> = [];

    await projectChunks({
      chunks: (async function* () {
        yield {
          type: "data-run-status",
          id: "run-status",
          data: { stage: "gathering-context" },
        } as UIMessageChunk;
        yield {
          type: "data-run-status",
          id: "run-status",
          data: { stage: "future-stage" },
        } as unknown as UIMessageChunk;
        yield {
          type: "data-run-status",
          id: "run-status",
          data: {},
        } as unknown as UIMessageChunk;
        yield { type: "start", messageId: "m-1" } as UIMessageChunk;
        yield { type: "text-start", id: "txt" } as UIMessageChunk;
        yield {
          type: "text-delta",
          id: "txt",
          delta: "hello",
        } as UIMessageChunk;
        yield { type: "text-end", id: "txt" } as UIMessageChunk;
        yield { type: "finish", finishReason: "stop" } as UIMessageChunk;
      })(),
      persistence: {
        emitStepParts: async (message) => {
          emitted.push({ id: message.id, parts: message.parts });
        },
        emitFinal: async (message) => {
          emitted.push({ id: message.id, parts: message.parts });
        },
        emitError: async () => {},
      },
    });

    expect(
      emitted
        .flatMap((message) => message.parts ?? [])
        .some((part) => {
          return (
            typeof part === "object" &&
            part !== null &&
            (part as { type?: unknown }).type === "data-run-status"
          );
        }),
    ).toBe(false);
    expect(
      emitted
        .flatMap((message) => message.parts ?? [])
        .some((part) => {
          return (
            typeof part === "object" &&
            part !== null &&
            (part as { type?: unknown; text?: unknown }).type === "text" &&
            (part as { text?: unknown }).text === "hello"
          );
        }),
    ).toBe(true);
  });

  test("ignores data-user-message chunks when projecting assistant parts", async () => {
    const emitted: Array<{ id: string; parts?: unknown[] }> = [];

    await projectChunks({
      chunks: (async function* () {
        yield {
          type: "data-user-message",
          data: {
            id: "u-1",
            role: "user",
            parts: [{ type: "text", text: "hi" }],
          },
        } as unknown as UIMessageChunk;
        yield { type: "start", messageId: "m-1" } as UIMessageChunk;
        yield { type: "text-start", id: "txt" } as UIMessageChunk;
        yield {
          type: "text-delta",
          id: "txt",
          delta: "hello",
        } as UIMessageChunk;
        yield { type: "text-end", id: "txt" } as UIMessageChunk;
        yield { type: "finish", finishReason: "stop" } as UIMessageChunk;
      })(),
      persistence: {
        emitStepParts: async (message) => {
          emitted.push({ id: message.id, parts: message.parts });
        },
        emitFinal: async (message) => {
          emitted.push({ id: message.id, parts: message.parts });
        },
        emitError: async () => {},
      },
    });

    // The user-message chunk must not leak into any projected assistant part,
    // and the assistant text still folds normally.
    expect(
      emitted
        .flatMap((message) => message.parts ?? [])
        .some(
          (part) =>
            typeof part === "object" &&
            part !== null &&
            (part as { type?: unknown }).type === "data-user-message",
        ),
    ).toBe(false);
    expect(emitted.some((m) => m.id === "u-1")).toBe(false);
    expect(
      emitted
        .flatMap((message) => message.parts ?? [])
        .some(
          (part) =>
            typeof part === "object" &&
            part !== null &&
            (part as { type?: unknown; text?: unknown }).type === "text" &&
            (part as { text?: unknown }).text === "hello",
        ),
    ).toBe(true);
  });
});
