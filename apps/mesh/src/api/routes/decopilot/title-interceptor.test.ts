/**
 * Unit tests for the title interceptor — pure logic, no MeshContext, no
 * provider, no storage. Injected `genTitle`/`persistTitle` deps keep
 * this at the unit tier per TESTING.md.
 *
 * Each test drives an async generator of UIMessageChunk into the
 * interceptor and asserts:
 *  - chunk pass-through preserves order
 *  - data-title-input chunks are swallowed (never yielded)
 *  - genTitle is called exactly once per stream
 *  - the title is persisted + the data-thread-title chunk is written
 */
import { describe, expect, mock, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import { makeTitleInputChunk } from "../../../harnesses/title-chunk";
import {
  interceptTitleChunks,
  type TitleInterceptorDeps,
} from "./title-interceptor";

type TitleGenHandle = {
  promise: Promise<string | null>;
  finish: () => void;
};

interface StubDeps {
  genTitle: ReturnType<typeof mock>;
  persistTitle: ReturnType<typeof mock>;
  onTitleUpdated: ReturnType<typeof mock>;
  writer: { write: ReturnType<typeof mock> };
  registerPendingOp: ReturnType<typeof mock>;
  isStreamFinished: ReturnType<typeof mock>;
}

function buildStubDeps(
  titleResolution: string | null,
  currentThreadTitle: string = "New chat",
): { deps: TitleInterceptorDeps; stubs: StubDeps } {
  const writerWrite = mock(() => {});
  const isStreamFinished = mock(() => false);
  const persistTitle = mock(async (_id: string, _title: string) => {});
  const onTitleUpdated = mock(async (_title: string) => {});
  const pendingOps: Promise<unknown>[] = [];
  const registerPendingOp = mock((op: Promise<unknown>) => {
    pendingOps.push(op);
  });
  const genTitle = mock(
    (_args: unknown): TitleGenHandle => ({
      promise: Promise.resolve(titleResolution),
      finish: () => {},
    }),
  );

  const deps: TitleInterceptorDeps = {
    ctx: {} as never,
    processLocal: {
      provider: {} as never,
      isStreamFinished,
      onUsageAggregated: () => {},
      registerPendingOp,
      writer: writerWrite as never,
      toolOutputMap: new Map(),
      pendingImages: [],
      threadId: "thread-1",
      currentThreadTitle,
      registrySignal: new AbortController().signal,
      runRegistry: null,
      htmlPageBuffer: null,
    } as never,
    models: {
      credentialId: "cred",
      thinking: { id: "m-thinking" },
      fast: { id: "m-fast" },
    } as never,
    currentThreadTitle,
    threadId: "thread-1",
    writer: { write: writerWrite } as never,
    registerPendingOp,
    registrySignal: new AbortController().signal,
    onTitleUpdated,
    genTitle: genTitle as never,
    persistTitle: persistTitle as never,
    createLanguageModel: ((_p: unknown, _m: unknown) => ({}) as never) as never,
  };

  return {
    deps,
    stubs: {
      genTitle,
      persistTitle,
      onTitleUpdated,
      writer: { write: writerWrite },
      registerPendingOp,
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
    const { deps } = buildStubDeps("My Title");
    const input: UIMessageChunk[] = [
      { type: "start" } as UIMessageChunk,
      { type: "text-delta", id: "1", delta: "hi" } as UIMessageChunk,
      { type: "finish" } as UIMessageChunk,
    ];
    const out = await collect(interceptTitleChunks(toAsync(input), deps));
    expect(out).toEqual(input);
  });

  test("swallows the data-title-input chunk and calls genTitle once", async () => {
    const { deps, stubs } = buildStubDeps("Generated Title");
    const input: UIMessageChunk[] = [
      { type: "start" } as UIMessageChunk,
      makeTitleInputChunk("first user turn") as unknown as UIMessageChunk,
      { type: "text-delta", id: "1", delta: "x" } as UIMessageChunk,
    ];
    const out = await collect(interceptTitleChunks(toAsync(input), deps));

    // data-title-input is dropped; the other 2 chunks pass through.
    expect(out.length).toBe(2);
    expect(out.some((c) => c.type === "data-title-input")).toBe(false);
    expect(stubs.genTitle).toHaveBeenCalledTimes(1);
    const callArg = stubs.genTitle.mock.calls[0]![0] as {
      userMessage: string;
    };
    expect(callArg.userMessage).toBe("first user turn");
  });

  test("persists the title and writes a data-thread-title chunk on resolution", async () => {
    const { deps, stubs } = buildStubDeps("Resolved Title");
    const input: UIMessageChunk[] = [
      makeTitleInputChunk("hello") as unknown as UIMessageChunk,
      { type: "finish" } as UIMessageChunk,
    ];

    await collect(interceptTitleChunks(toAsync(input), deps));

    // genTitle resolves synchronously in this stub; await the registered op.
    expect(stubs.registerPendingOp).toHaveBeenCalledTimes(1);
    const op = stubs.registerPendingOp.mock.calls[0]![0] as Promise<void>;
    await op;

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

  test("a second data-title-input chunk is swallowed and warns", async () => {
    const { deps, stubs } = buildStubDeps("first title");
    const warn = mock(() => {});
    const origWarn = console.warn;
    console.warn = warn as never;
    try {
      const input: UIMessageChunk[] = [
        makeTitleInputChunk("one") as unknown as UIMessageChunk,
        makeTitleInputChunk("two") as unknown as UIMessageChunk,
        { type: "finish" } as UIMessageChunk,
      ];
      const out = await collect(interceptTitleChunks(toAsync(input), deps));
      expect(out.length).toBe(1); // only "finish" survives
      expect(stubs.genTitle).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      console.warn = origWarn;
    }
  });

  test("skips genTitle when currentThreadTitle is not the default", async () => {
    const { deps, stubs } = buildStubDeps("would-not-run", "User Renamed Me");
    const input: UIMessageChunk[] = [
      makeTitleInputChunk("hello") as unknown as UIMessageChunk,
      { type: "finish" } as UIMessageChunk,
    ];
    const out = await collect(interceptTitleChunks(toAsync(input), deps));
    expect(out.length).toBe(1);
    expect(stubs.genTitle).not.toHaveBeenCalled();
    expect(stubs.persistTitle).not.toHaveBeenCalled();
    expect(stubs.writer.write).not.toHaveBeenCalled();
  });

  test("null title resolution skips persist + writer.write", async () => {
    const { deps, stubs } = buildStubDeps(null);
    const input: UIMessageChunk[] = [
      makeTitleInputChunk("hello") as unknown as UIMessageChunk,
      { type: "finish" } as UIMessageChunk,
    ];
    await collect(interceptTitleChunks(toAsync(input), deps));
    const op = stubs.registerPendingOp.mock.calls[0]![0] as Promise<void>;
    await op;
    expect(stubs.persistTitle).not.toHaveBeenCalled();
    expect(stubs.onTitleUpdated).not.toHaveBeenCalled();
    expect(stubs.writer.write).not.toHaveBeenCalled();
  });

  test("persist failure is logged but does not throw", async () => {
    const { deps, stubs } = buildStubDeps("title");
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
        makeTitleInputChunk("hello") as unknown as UIMessageChunk,
      ];
      await collect(interceptTitleChunks(toAsync(input), deps));
      const op = stubs.registerPendingOp.mock.calls[0]![0] as Promise<void>;
      await op; // must not reject
      expect(error).toHaveBeenCalled();
    } finally {
      console.error = origError;
    }
  });

  test("skips writer.write when isStreamFinished returns true", async () => {
    const { deps, stubs } = buildStubDeps("title");
    (stubs.isStreamFinished as ReturnType<typeof mock>).mockImplementation(
      () => true,
    );
    const input: UIMessageChunk[] = [
      makeTitleInputChunk("hello") as unknown as UIMessageChunk,
    ];
    await collect(interceptTitleChunks(toAsync(input), deps));
    const op = stubs.registerPendingOp.mock.calls[0]![0] as Promise<void>;
    await op;
    expect(stubs.persistTitle).toHaveBeenCalledTimes(1);
    expect(stubs.writer.write).not.toHaveBeenCalled();
  });
});
