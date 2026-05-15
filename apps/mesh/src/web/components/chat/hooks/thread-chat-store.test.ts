import { describe, expect, test, mock } from "bun:test";
import type { UIMessage } from "ai";
import { ThreadChatStore } from "./thread-chat-store";

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
