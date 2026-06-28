import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import {
  mergeTitleResult,
  shouldGenerateTitle,
  type TitleHandle,
} from "./title-merge";
import { isTitleResultChunk } from "./title-chunk";
import { DEFAULT_THREAD_TITLE } from "./thread-title";

/** Build an async stream from a fixed list of chunks. */
async function* streamOf(
  chunks: UIMessageChunk[],
): AsyncIterable<UIMessageChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/** A deferred title handle whose promise we resolve explicitly in tests, plus a
 *  spy on `finish()`. */
function makeTitleHandle(): {
  handle: TitleHandle;
  resolve: (title: string | null) => void;
  reject: (err: unknown) => void;
  finishCalls: () => number;
} {
  let resolve!: (title: string | null) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<string | null>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let finishCount = 0;
  return {
    handle: {
      promise,
      finish: () => {
        finishCount += 1;
      },
    },
    resolve,
    reject,
    finishCalls: () => finishCount,
  };
}

const chunk = (id: string): UIMessageChunk =>
  ({ type: "text-delta", id, delta: id }) as unknown as UIMessageChunk;

describe("mergeTitleResult", () => {
  test("interleaves the title-result chunk and finishes the handle when main ends first", async () => {
    const { handle, resolve, finishCalls } = makeTitleHandle();
    const out: UIMessageChunk[] = [];

    const merged = mergeTitleResult(streamOf([chunk("a"), chunk("b")]), handle);

    // Drain in the background; the main stream ends before the title resolves.
    const collect = (async () => {
      for await (const c of merged) out.push(c);
    })();

    // Let the generator fully drain the main stream (it ends before the title
    // resolves). A macrotask tick lets the in-flight main `next()` promises
    // settle through to `done`, at which point mergeTitleResult calls finish().
    await new Promise((r) => setTimeout(r, 0));
    expect(finishCalls()).toBe(1);

    resolve("My generated title");
    await collect;

    // finish() called exactly once (main ended first, title still pending).
    expect(finishCalls()).toBe(1);

    const titleChunks = out.filter((c) => isTitleResultChunk(c));
    expect(titleChunks).toHaveLength(1);
    expect((titleChunks[0] as { data: { title: string } }).data.title).toBe(
      "My generated title",
    );
  });

  test("yields nothing extra when the title resolves null", async () => {
    const { handle, resolve } = makeTitleHandle();
    const out: UIMessageChunk[] = [];

    const merged = mergeTitleResult(streamOf([chunk("a")]), handle);
    const collect = (async () => {
      for await (const c of merged) out.push(c);
    })();

    await Promise.resolve();
    resolve(null);
    await collect;

    expect(out.filter((c) => isTitleResultChunk(c))).toHaveLength(0);
    // Only the single main chunk passes through.
    expect(out).toHaveLength(1);
    expect((out[0] as { id: string }).id).toBe("a");
  });

  test("main chunks pass through in order", async () => {
    const { handle, resolve } = makeTitleHandle();
    const out: UIMessageChunk[] = [];

    const merged = mergeTitleResult(
      streamOf([chunk("a"), chunk("b"), chunk("c")]),
      handle,
    );
    const collect = (async () => {
      for await (const c of merged) out.push(c);
    })();

    await Promise.resolve();
    resolve("Title");
    await collect;

    const mainIds = out
      .filter((c) => !isTitleResultChunk(c))
      .map((c) => (c as { id: string }).id);
    expect(mainIds).toEqual(["a", "b", "c"]);
  });
});

describe("shouldGenerateTitle (D13 producer gate)", () => {
  test("first message of a new thread (title === default) generates a title", () => {
    expect(
      shouldGenerateTitle({ currentThreadTitle: DEFAULT_THREAD_TITLE }),
    ).toBe(true);
    // ...and the same on the main (non-subtask) core path.
    expect(
      shouldGenerateTitle({
        currentThreadTitle: DEFAULT_THREAD_TITLE,
        kind: "main",
      }),
    ).toBe(true);
  });

  test("a later message of an already-titled thread does NOT generate a title", () => {
    expect(
      shouldGenerateTitle({ currentThreadTitle: "Fix login button" }),
    ).toBe(false);
    expect(
      shouldGenerateTitle({
        currentThreadTitle: "Fix login button",
        kind: "main",
      }),
    ).toBe(false);
  });

  test("subtask runs never generate a title, even on the default title", () => {
    expect(
      shouldGenerateTitle({
        currentThreadTitle: DEFAULT_THREAD_TITLE,
        kind: "subtask",
      }),
    ).toBe(false);
  });

  test("null/undefined/empty title does not match the default → no title gen", () => {
    expect(shouldGenerateTitle({ currentThreadTitle: null })).toBe(false);
    expect(shouldGenerateTitle({ currentThreadTitle: undefined })).toBe(false);
    expect(shouldGenerateTitle({ currentThreadTitle: "" })).toBe(false);
  });
});

describe("mergeTitleResult — rejection handling", () => {
  test("does not throw and emits no title chunk when the title promise rejects", async () => {
    const { handle, reject } = makeTitleHandle();
    const out: UIMessageChunk[] = [];

    const merged = mergeTitleResult(streamOf([chunk("a")]), handle);
    const collect = (async () => {
      for await (const c of merged) out.push(c);
    })();

    await Promise.resolve();
    reject(new Error("title model failed"));
    await collect;

    expect(out.filter((c) => isTitleResultChunk(c))).toHaveLength(0);
    expect(out).toHaveLength(1);
  });
});
