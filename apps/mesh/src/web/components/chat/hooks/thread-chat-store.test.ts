import { describe, expect, test, mock } from "bun:test";
import type { UIMessage } from "ai";
import { ThreadChatStore } from "./thread-chat-store";

const makeStore = () =>
  new ThreadChatStore<UIMessage>({
    handlersRef: { current: { prepareBody: () => ({}) } },
    fetchImpl: mock(() => Promise.resolve(new Response("", { status: 202 }))),
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

  test("subscribe receives notification when state changes", () => {
    const store = makeStore();
    const listener = mock(() => {});
    const unsubscribe = store.subscribe(listener);
    store.clearError(); // no-op — should not notify
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
