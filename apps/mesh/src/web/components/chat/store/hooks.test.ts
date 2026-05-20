/**
 * Store-level smoke test for the hook layer.
 *
 * No `@testing-library/react` is available, so we exercise the manager
 * directly and assert the same Store<T> slots the hooks read from.
 * `useThreads` is a one-line wrapper around `manager.threads` /
 * `manager.threadsStatus`; the unit of behavior is the store.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { SSESubscription } from "@/web/hooks/create-sse-subscription";
import { __resetRegistry } from "./thread-connection";
import {
  __resetManagerRegistry,
  ThreadManagerStore,
} from "./thread-manager-store";

const noopSse: SSESubscription = {
  subscribe: () => () => {},
};

afterEach(() => {
  __resetRegistry();
  __resetManagerRegistry();
});

describe("hooks: useThreads source (manager.threads)", () => {
  it("starts empty and flips to ready after loadInitialPage", async () => {
    const callTool = mock(async (args: { name: string }) => {
      if (args.name === "COLLECTION_THREADS_LIST") {
        return {
          structuredContent: {
            items: [
              { id: "t-1", title: "A", updated_at: "2026-01-01T00:00:00Z" },
            ],
            hasMore: false,
          },
        };
      }
      return {};
    });
    const store = new ThreadManagerStore("acme", "loc-1", {
      client: { callTool } as unknown as MCPClient,
      sse: noopSse,
    });
    expect(store.threads.get()).toEqual([]);
    expect(store.threadsStatus.get()).toEqual({ kind: "loading" });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.threadsStatus.get()).toEqual({ kind: "ready" });
    expect(store.threads.get().map((t) => t.id)).toEqual(["t-1"]);
    store.dispose();
  });
});
