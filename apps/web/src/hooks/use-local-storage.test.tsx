import { setupComponentTest } from "../../test/setup";
setupComponentTest();

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { useLocalStorage } from "./use-local-storage.ts";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useLocalStorage", () => {
  it("keeps both updates when the setter is called twice in the same tick", async () => {
    const { result } = renderHook(
      () =>
        useLocalStorage<{ a: number; b: number }>("test-key", { a: 0, b: 0 }),
      { wrapper },
    );

    act(() => {
      const [, setValue] = result.current;
      setValue((prev) => ({ ...prev, a: 1 }));
      setValue((prev) => ({ ...prev, b: 1 }));
    });

    await waitFor(() => expect(result.current[0]).toEqual({ a: 1, b: 1 }));
    expect(JSON.parse(localStorage.getItem("test-key") ?? "{}")).toEqual({
      a: 1,
      b: 1,
    });
  });

  it("updates the value and does not throw when storage rejects the write", async () => {
    const { result } = renderHook(
      () => useLocalStorage<number>("full-storage-key", 0),
      { wrapper },
    );

    // happy-dom's Storage is a proxy: assigning `setItem` on it stores an item
    // instead of replacing the method, so swap the whole global.
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        setItem: () => {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        },
      },
    });
    try {
      act(() => {
        const [, setValue] = result.current;
        expect(() => setValue(1)).not.toThrow();
      });
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: original,
      });
    }

    await waitFor(() => expect(result.current[0]).toBe(1));
  });
});
