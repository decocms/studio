import { describe, expect, test, mock } from "bun:test";
import type { UIMessage, UIMessageChunk } from "ai";
import { ThreadChatStore } from "./thread-chat-store";

const runChunks = async (
  store: ThreadChatStore<UIMessage>,
  chunks: UIMessageChunk[],
) => {
  for (const c of chunks) {
    // @ts-expect-error — internal
    store.handleChunk(c);
  }
  // Let readUIMessageStream's async iteration tick.
  await new Promise<void>((r) => setTimeout(r, 0));
};

const makeStore = () =>
  new ThreadChatStore<UIMessage>({
    handlersRef: { current: { prepareBody: () => ({}) } },
    fetchImpl: mock(() =>
      Promise.resolve(new Response("", { status: 202 })),
    ) as unknown as typeof fetch,
    persistentLoop: () => new Promise<void>(() => {}), // never resolves
  });

describe("ThreadChatStore — snapshot/subscribe", () => {
  test("initial snapshot is empty + ready", () => {
    const store = makeStore();
    expect(store.getSnapshot()).toEqual({
      local: [],
      streaming: null,
      status: "ready",
      error: null,
    });
  });

  test("snapshot is referentially stable when nothing changes", () => {
    const store = makeStore();
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  test("subscribe is NOT notified when clearError is a no-op", () => {
    const store = makeStore();
    const listener = mock(() => {});
    const unsubscribe = store.subscribe(listener);
    store.clearError(); // no-op — should not notify
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("ThreadChatStore.sendMessage", () => {
  test("optimistically appends the user message to local", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(new Response("", { status: 202 })),
    );
    const store = new ThreadChatStore<UIMessage>({
      handlersRef: { current: { prepareBody: () => ({}) } },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      persistentLoop: () => new Promise(() => {}),
    });
    store.connect({ orgSlug: "acme", threadId: "t-1" });
    const msg: UIMessage = { id: "u-1", role: "user", parts: [] };
    await store.sendMessage(msg);
    expect(store.getSnapshot().local).toEqual([
      expect.objectContaining({ id: "u-1", role: "user" }),
    ]);
    expect(store.getSnapshot().status).toBe("submitted");
  });

  test("posts to /api/:org/decopilot/threads/:id/messages with prepared body", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(new Response("", { status: 202 })),
    );
    const prepareBody = mock(({ messages }) => ({ messages }));
    const store = new ThreadChatStore<UIMessage>({
      handlersRef: { current: { prepareBody } },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      persistentLoop: () => new Promise(() => {}),
    });
    store.connect({ orgSlug: "ac me", threadId: "t/1" });
    await store.sendMessage({ id: "u-1", role: "user", parts: [] });
    const calls = fetchImpl.mock.calls as unknown as Array<[unknown, unknown]>;
    const call = calls[0]!;
    expect(call[0]).toBe("/api/ac%20me/decopilot/threads/t%2F1/messages");
    expect((call[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toMatchObject({
      messages: expect.any(Array),
    });
  });

  test("flips status to error on non-2xx POST", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(new Response("nope", { status: 500 })),
    );
    const onError = mock(() => {});
    const store = new ThreadChatStore<UIMessage>({
      handlersRef: { current: { prepareBody: () => ({}), onError } },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      persistentLoop: () => new Promise(() => {}),
    });
    store.connect({ orgSlug: "a", threadId: "t" });
    await store.sendMessage({ id: "u-1", role: "user", parts: [] });
    expect(store.getSnapshot().status).toBe("error");
    expect(store.getSnapshot().error?.message).toBe("nope");
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("ThreadChatStore.setMessages", () => {
  test("drops server-id entries, retags the rest as local", () => {
    const store = new ThreadChatStore<UIMessage>({
      handlersRef: { current: { prepareBody: () => ({}) } },
      fetchImpl: mock(() =>
        Promise.resolve(new Response("", { status: 202 })),
      ) as unknown as typeof fetch,
      persistentLoop: () => new Promise(() => {}),
    });
    store.connect({ orgSlug: "a", threadId: "t" });
    const server: UIMessage[] = [{ id: "s-1", role: "user", parts: [] }];
    const next: UIMessage[] = [
      { id: "s-1", role: "user", parts: [] }, // from server, should be dropped from local
      { id: "u-2", role: "user", parts: [] }, // new local entry
    ];
    store.setMessages(server, next);
    const local = store.getSnapshot().local;
    expect(local.map((m) => m.id)).toEqual(["u-2"]);
  });

  test("accepts a function updater receiving the composed view", () => {
    const store = new ThreadChatStore<UIMessage>({
      handlersRef: { current: { prepareBody: () => ({}) } },
      fetchImpl: mock(() =>
        Promise.resolve(new Response("", { status: 202 })),
      ) as unknown as typeof fetch,
      persistentLoop: () => new Promise(() => {}),
    });
    store.connect({ orgSlug: "a", threadId: "t" });
    const server: UIMessage[] = [{ id: "s-1", role: "user", parts: [] }];
    store.setMessages(server, (prev) => {
      expect(prev).toEqual(server); // local is empty, no streaming
      return [...prev, { id: "u-2", role: "user", parts: [] }];
    });
    expect(store.getSnapshot().local.map((m) => m.id)).toEqual(["u-2"]);
  });
});

describe("ThreadChatStore — chunk fan-out", () => {
  test("fires onData for data-* chunks before folding", () => {
    const onData = mock(() => {});
    const store = new ThreadChatStore<UIMessage>({
      handlersRef: { current: { prepareBody: () => ({}), onData } },
      fetchImpl: mock(() =>
        Promise.resolve(new Response("", { status: 202 })),
      ) as unknown as typeof fetch,
      persistentLoop: () => new Promise(() => {}),
    });
    store.connect({ orgSlug: "a", threadId: "t" });
    const chunk = { type: "data-thread-title", data: { title: "hi" } } as never;
    // @ts-expect-error — calling internal for unit test
    store.handleChunk(chunk);
    expect(onData).toHaveBeenCalledWith(chunk);
  });

  test("fires onToolCall for tool-input-available chunks", () => {
    const onToolCall = mock(() => {});
    const store = new ThreadChatStore<UIMessage>({
      handlersRef: { current: { prepareBody: () => ({}), onToolCall } },
      fetchImpl: mock(() =>
        Promise.resolve(new Response("", { status: 202 })),
      ) as unknown as typeof fetch,
      persistentLoop: () => new Promise(() => {}),
    });
    store.connect({ orgSlug: "a", threadId: "t" });
    // @ts-expect-error — calling internal for unit test
    store.handleChunk({
      type: "tool-input-available",
      toolCallId: "c1",
      toolName: "myTool",
      input: { a: 1 },
    });
    expect(onToolCall).toHaveBeenCalledWith({
      toolCall: { toolCallId: "c1", toolName: "myTool", input: { a: 1 } },
    });
  });
});

describe("ThreadChatStore — sub-stream demuxer", () => {
  test("opens sub-stream on first chunk, status becomes streaming", async () => {
    const store = new ThreadChatStore<UIMessage>({
      handlersRef: { current: { prepareBody: () => ({}) } },
      fetchImpl: mock(() =>
        Promise.resolve(new Response("", { status: 202 })),
      ) as unknown as typeof fetch,
      persistentLoop: () => new Promise(() => {}),
    });
    store.connect({ orgSlug: "a", threadId: "t" });
    await runChunks(store, [
      { type: "start", messageId: "m-1" },
      { type: "text-start", id: "t-1" },
      { type: "text-delta", id: "t-1", delta: "hello" },
    ] as UIMessageChunk[]);
    expect(store.getSnapshot().status).toBe("streaming");
    expect(store.getSnapshot().streaming?.id).toBe("m-1");
  });

  test("promotes streaming message to local on finish chunk", async () => {
    const onFinish = mock(() => {});
    const store = new ThreadChatStore<UIMessage>({
      handlersRef: { current: { prepareBody: () => ({}), onFinish } },
      fetchImpl: mock(() =>
        Promise.resolve(new Response("", { status: 202 })),
      ) as unknown as typeof fetch,
      persistentLoop: () => new Promise(() => {}),
    });
    store.connect({ orgSlug: "a", threadId: "t" });
    await runChunks(store, [
      { type: "start", messageId: "m-1" },
      { type: "text-start", id: "t-1" },
      { type: "text-delta", id: "t-1", delta: "hi" },
      { type: "text-end", id: "t-1" },
      { type: "finish", finishReason: "stop" },
    ] as UIMessageChunk[]);
    expect(store.getSnapshot().streaming).toBeNull();
    expect(store.getSnapshot().status).toBe("ready");
    expect(store.getSnapshot().local.map((m) => m.id)).toEqual(["m-1"]);
    expect(onFinish).toHaveBeenCalledTimes(1);
    const finishCall = (
      onFinish.mock.calls as unknown as Array<[{ finishReason?: string }]>
    )[0]!;
    expect(finishCall[0]).toMatchObject({ finishReason: "stop" });
  });
});
