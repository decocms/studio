/**
 * Unit tests for the title interceptor — pure logic, no MeshContext, no
 * provider, no storage. Injected `persistTitle` deps keep this at the unit
 * tier per TESTING.md.
 *
 * Each test drives an async generator of UIMessageChunk into the
 * interceptor and asserts:
 *  - chunk pass-through preserves order
 *  - data-title-result chunks are swallowed (never yielded)
 *  - the title is persisted + the data-thread-title chunk is written
 */
import { describe, expect, mock, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import {
  makeTitleInputChunk,
  makeTitleResultChunk,
} from "../../../harnesses/title-chunk";
import {
  interceptTitleChunks,
  type TitleInterceptorDeps,
} from "./title-interceptor";

interface StubDeps {
  persistTitle: ReturnType<typeof mock>;
  onTitleUpdated: ReturnType<typeof mock>;
  writer: { write: ReturnType<typeof mock> };
  isStreamFinished: ReturnType<typeof mock>;
}

function buildStubDeps(currentThreadTitle: string = "New chat"): {
  deps: TitleInterceptorDeps;
  stubs: StubDeps;
} {
  const writerWrite = mock(() => {});
  const isStreamFinished = mock(() => false);
  const persistTitle = mock(async (_id: string, _title: string) => {});
  const onTitleUpdated = mock(async (_title: string) => {});

  const deps: TitleInterceptorDeps = {
    ctx: {} as never,
    processLocal: {
      isStreamFinished,
      onUsageAggregated: () => {},
      writer: writerWrite as never,
      toolOutputMap: new Map(),
      pendingImages: [],
      threadId: "thread-1",
      currentThreadTitle,
      registrySignal: new AbortController().signal,
      runRegistry: null,
      htmlPageBuffer: null,
    } as never,
    currentThreadTitle,
    threadId: "thread-1",
    writer: { write: writerWrite } as never,
    onTitleUpdated,
    persistTitle: persistTitle as never,
  };

  return {
    deps,
    stubs: {
      persistTitle,
      onTitleUpdated,
      writer: { write: writerWrite },
      isStreamFinished,
    },
  };
}

async function* toAsync(
  chunks: UIMessageChunk[],
): AsyncIterable<UIMessageChunk> {
  for (const c of chunks) yield c;
}

async function collect(
  it: AsyncIterable<UIMessageChunk>,
): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("interceptTitleChunks", () => {
  test("passes non-title chunks through unchanged in 1-to-1 order", async () => {
    const { deps } = buildStubDeps();
    const input: UIMessageChunk[] = [
      { type: "start" } as UIMessageChunk,
      { type: "text-delta", id: "1", delta: "hi" } as UIMessageChunk,
      { type: "finish" } as UIMessageChunk,
    ];
    const out = await collect(interceptTitleChunks(toAsync(input), deps));
    expect(out).toEqual(input);
  });

  test("swallows deprecated data-title-input chunks", async () => {
    const { deps, stubs } = buildStubDeps();
    const warn = mock(() => {});
    const origWarn = console.warn;
    console.warn = warn as never;
    try {
      const input: UIMessageChunk[] = [
        { type: "start" } as UIMessageChunk,
        makeTitleInputChunk("first user turn") as unknown as UIMessageChunk,
        { type: "text-delta", id: "1", delta: "x" } as UIMessageChunk,
      ];
      const out = await collect(interceptTitleChunks(toAsync(input), deps));

      expect(out.length).toBe(2);
      expect(out.some((c) => c.type === "data-title-input")).toBe(false);
      expect(stubs.persistTitle).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    } finally {
      console.warn = origWarn;
    }
  });

  test("persists title results and writes a data-thread-title chunk", async () => {
    const { deps, stubs } = buildStubDeps();
    const input: UIMessageChunk[] = [
      { type: "start" } as UIMessageChunk,
      makeTitleResultChunk("Resolved Title") as unknown as UIMessageChunk,
      { type: "text-delta", id: "1", delta: "x" } as UIMessageChunk,
    ];
    const out = await collect(interceptTitleChunks(toAsync(input), deps));

    expect(out.length).toBe(2);
    expect(stubs.persistTitle).toHaveBeenCalledWith(
      "thread-1",
      "Resolved Title",
    );
    expect(stubs.onTitleUpdated).toHaveBeenCalledWith("Resolved Title");
    expect(stubs.writer.write).toHaveBeenCalledWith({
      type: "data-thread-title",
      data: { title: "Resolved Title" },
      transient: true,
    });
  });

  test("a second data-title-result chunk is swallowed and warns", async () => {
    const { deps, stubs } = buildStubDeps();
    const warn = mock(() => {});
    const origWarn = console.warn;
    console.warn = warn as never;
    try {
      const input: UIMessageChunk[] = [
        makeTitleResultChunk("one") as unknown as UIMessageChunk,
        makeTitleResultChunk("two") as unknown as UIMessageChunk,
        { type: "finish" } as UIMessageChunk,
      ];
      const out = await collect(interceptTitleChunks(toAsync(input), deps));
      expect(out.length).toBe(1); // only "finish" survives
      expect(stubs.persistTitle).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      console.warn = origWarn;
    }
  });

  test("skips persist when currentThreadTitle is not the default", async () => {
    const { deps, stubs } = buildStubDeps("User Renamed Me");
    const input: UIMessageChunk[] = [
      makeTitleResultChunk("hello") as unknown as UIMessageChunk,
      { type: "finish" } as UIMessageChunk,
    ];
    const out = await collect(interceptTitleChunks(toAsync(input), deps));
    expect(out.length).toBe(1);
    expect(stubs.persistTitle).not.toHaveBeenCalled();
    expect(stubs.writer.write).not.toHaveBeenCalled();
  });

  test("empty title result skips persist + writer.write", async () => {
    const { deps, stubs } = buildStubDeps();
    const input: UIMessageChunk[] = [
      makeTitleResultChunk("") as unknown as UIMessageChunk,
      { type: "finish" } as UIMessageChunk,
    ];
    await collect(interceptTitleChunks(toAsync(input), deps));
    expect(stubs.persistTitle).not.toHaveBeenCalled();
    expect(stubs.onTitleUpdated).not.toHaveBeenCalled();
    expect(stubs.writer.write).not.toHaveBeenCalled();
  });

  test("persist failure is logged but does not throw", async () => {
    const { deps, stubs } = buildStubDeps();
    (stubs.persistTitle as ReturnType<typeof mock>).mockImplementation(
      async () => {
        throw new Error("DB offline");
      },
    );
    const error = mock(() => {});
    const origError = console.error;
    console.error = error as never;
    try {
      const input: UIMessageChunk[] = [
        makeTitleResultChunk("hello") as unknown as UIMessageChunk,
      ];
      await collect(interceptTitleChunks(toAsync(input), deps));
      expect(error).toHaveBeenCalled();
    } finally {
      console.error = origError;
    }
  });

  test("skips writer.write when isStreamFinished returns true", async () => {
    const { deps, stubs } = buildStubDeps();
    (stubs.isStreamFinished as ReturnType<typeof mock>).mockImplementation(
      () => true,
    );
    const input: UIMessageChunk[] = [
      makeTitleResultChunk("hello") as unknown as UIMessageChunk,
    ];
    await collect(interceptTitleChunks(toAsync(input), deps));
    expect(stubs.persistTitle).toHaveBeenCalledTimes(1);
    expect(stubs.writer.write).not.toHaveBeenCalled();
  });
});
