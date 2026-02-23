import { beforeEach, describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  buildCollectionQueryKey,
  EMPTY_COLLECTION_LIST_RESULT,
} from "@decocms/mesh-sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Test the core prefilling logic directly
describe("Collection Cache Prefill Logic", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
  });

  it("should build correct query key for THREAD_MESSAGES", () => {
    const mockClient = {} as Client;
    const queryKey = buildCollectionQueryKey(
      mockClient,
      "THREAD_MESSAGES",
      "org-123",
      {
        filters: [{ column: "thread_id", value: "test-thread" }],
        pageSize: 100,
      },
    );

    expect(queryKey).not.toBeNull();
    if (queryKey) {
      expect(queryKey[1]).toBe("org-123");
      expect(queryKey[3]).toBe("collection");
      expect(queryKey[4]).toBe("THREAD_MESSAGES");
    }
  });

  it("should return query key with null client", () => {
    const queryKey = buildCollectionQueryKey(
      null,
      "THREAD_MESSAGES",
      "org-123",
      {},
    );

    expect(queryKey).toEqual([
      null,
      "org-123",
      "",
      "collection",
      "THREAD_MESSAGES",
      "list",
      JSON.stringify({
        orderBy: [{ field: ["updated_at"], direction: "asc" }],
        limit: 100,
        offset: 0,
      }),
    ]);
  });

  it("should return query key with undefined client", () => {
    const queryKey = buildCollectionQueryKey(
      undefined,
      "THREAD_MESSAGES",
      "org-123",
      {},
    );

    expect(queryKey).toEqual([
      undefined,
      "org-123",
      "",
      "collection",
      "THREAD_MESSAGES",
      "list",
      JSON.stringify({
        orderBy: [{ field: ["updated_at"], direction: "asc" }],
        limit: 100,
        offset: 0,
      }),
    ]);
  });

  it("should prefill cache with empty result structure", () => {
    const mockClient = {} as Client;
    const queryKey = buildCollectionQueryKey(
      mockClient,
      "THREAD_MESSAGES",
      "org-123",
      {
        filters: [{ column: "thread_id", value: "test-thread" }],
      },
    );

    if (!queryKey) {
      throw new Error("Query key should not be null");
    }

    // Simulate the prefilling logic
    const existingData = queryClient.getQueryData(queryKey);
    expect(existingData).toBeUndefined();

    // Prefill with empty result
    const emptyResult = {
      structuredContent: {
        items: [],
      },
      isError: false,
    };

    queryClient.setQueryData(queryKey, emptyResult);

    const cachedData = queryClient.getQueryData(queryKey);
    expect(cachedData).toEqual(emptyResult);
    expect(cachedData).toEqual(EMPTY_COLLECTION_LIST_RESULT);
  });

  it("should not overwrite existing cache data", () => {
    const mockClient = {} as Client;
    const queryKey = buildCollectionQueryKey(
      mockClient,
      "THREAD_MESSAGES",
      "org-123",
      {
        filters: [{ column: "thread_id", value: "test-thread" }],
      },
    );

    if (!queryKey) {
      throw new Error("Query key should not be null");
    }

    // Pre-populate cache with existing data
    const existingData = {
      structuredContent: {
        items: [{ id: "existing-item" }],
      },
      isError: false,
    };

    queryClient.setQueryData(queryKey, existingData);

    // Simulate checking for existing data (should skip prefilling)
    const cachedBeforePrefill = queryClient.getQueryData(queryKey);
    expect(cachedBeforePrefill).toEqual(existingData);

    // Even if we try to prefill, the logic should check first
    const shouldSkip = queryClient.getQueryData(queryKey) !== undefined;
    expect(shouldSkip).toBe(true);
  });

  it("should handle different collection names", () => {
    const mockClient = {} as Client;

    const threadsKey = buildCollectionQueryKey(
      mockClient,
      "THREADS",
      "org-123",
      {},
    );
    const messagesKey = buildCollectionQueryKey(
      mockClient,
      "THREAD_MESSAGES",
      "org-123",
      {},
    );

    expect(threadsKey).not.toBeNull();
    expect(messagesKey).not.toBeNull();

    if (threadsKey && messagesKey) {
      expect(threadsKey[4]).toBe("THREADS");
      expect(messagesKey[4]).toBe("THREAD_MESSAGES");
    }
  });
});
