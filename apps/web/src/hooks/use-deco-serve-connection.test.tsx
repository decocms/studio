import { setupComponentTest } from "../../test/setup";
setupComponentTest();

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

const sessionRef: { current: { user: { id: string } } | null } = {
  current: null,
};
/** The project's "Blocks v8 site" switch (`useBlocksV8Project`). */
const v8Ref = { current: true };

mock.module("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: sessionRef.current }) },
}));
// The module's other exports stay real: the mock outlives this file.
const realSwitch = await import("./use-blocks-v8-project");
mock.module("./use-blocks-v8-project", () => ({
  ...realSwitch,
  useBlocksV8Project: () => v8Ref.current,
}));

const { useDecoServeConnection } = await import("./use-deco-serve-connection");

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const ENDPOINT = "http://localhost:4546/rpc";

describe("useDecoServeConnection (the Localhost choice)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionRef.current = { user: { id: "u1" } };
    v8Ref.current = true;
  });

  it("is remembered per user and project", async () => {
    expect(LOCALSTORAGE_KEYS.decoServeConnection("u1", "vmcp")).not.toBe(
      LOCALSTORAGE_KEYS.decoServeConnection("u2", "vmcp"),
    );
    const first = renderHook(() => useDecoServeConnection("vmcp"), {
      wrapper,
    });
    act(() => first.result.current.set({ endpoint: ENDPOINT }));
    await waitFor(() =>
      expect(first.result.current.connection?.endpoint).toBe(ENDPOINT),
    );
    first.unmount();

    sessionRef.current = { user: { id: "u2" } };
    const other = renderHook(() => useDecoServeConnection("vmcp"), {
      wrapper,
    });
    expect(other.result.current.connection).toBeNull();
  });

  it("keeps the endpoint after Localhost is turned off, for the next choice", async () => {
    const { result } = renderHook(() => useDecoServeConnection("vmcp"), {
      wrapper,
    });
    expect(result.current.lastEndpoint).toBeNull();
    act(() => result.current.set({ endpoint: ENDPOINT }));
    await waitFor(() =>
      expect(result.current.connection?.endpoint).toBe(ENDPOINT),
    );
    act(() => result.current.clear());
    await waitFor(() => expect(result.current.connection).toBeNull());
    expect(result.current.lastEndpoint).toBe(ENDPOINT);
  });

  it("the switch off (v7) reads a stored choice as none, as on main", () => {
    localStorage.setItem(
      LOCALSTORAGE_KEYS.decoServeConnection("u1", "vmcp"),
      JSON.stringify({ endpoint: ENDPOINT }),
    );
    localStorage.setItem(
      LOCALSTORAGE_KEYS.decoServeEndpoint("u1", "vmcp"),
      JSON.stringify(ENDPOINT),
    );
    v8Ref.current = false;
    const off = renderHook(() => useDecoServeConnection("vmcp"), { wrapper });
    expect(off.result.current.connection).toBeNull();
    expect(off.result.current.lastEndpoint).toBeNull();
    off.unmount();

    // The switch on (v8): the same stored choice applies at once, no wait.
    v8Ref.current = true;
    const on = renderHook(() => useDecoServeConnection("vmcp"), { wrapper });
    expect(on.result.current.connection?.endpoint).toBe(ENDPOINT);
    expect(on.result.current.lastEndpoint).toBe(ENDPOINT);
  });

  it("writes nothing before the session loads", async () => {
    sessionRef.current = null;
    const { result } = renderHook(() => useDecoServeConnection("vmcp"), {
      wrapper,
    });
    act(() => result.current.set({ endpoint: ENDPOINT }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.connection).toBeNull();
    expect(Object.keys(localStorage)).toEqual([]);
  });

  it("never writes a key without a project id", async () => {
    for (const id of [null, undefined, ""]) {
      const { result, unmount } = renderHook(() => useDecoServeConnection(id), {
        wrapper,
      });
      act(() => result.current.set({ endpoint: ENDPOINT }));
      act(() => result.current.clear());
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(result.current.connection).toBeNull();
      unmount();
    }
    expect(Object.keys(localStorage)).toEqual([]);
  });

  it("reading stores nothing; only a choice is stored, under both ids", async () => {
    const { result } = renderHook(() => useDecoServeConnection("vmcp"), {
      wrapper,
    });
    expect(Object.keys(localStorage)).toEqual([]);
    act(() => result.current.set({ endpoint: ENDPOINT }));
    await waitFor(() =>
      expect(result.current.connection?.endpoint).toBe(ENDPOINT),
    );
    expect(Object.keys(localStorage).sort()).toEqual(
      [
        LOCALSTORAGE_KEYS.decoServeConnection("u1", "vmcp"),
        LOCALSTORAGE_KEYS.decoServeEndpoint("u1", "vmcp"),
      ].sort(),
    );
    for (const key of Object.keys(localStorage)) {
      expect(key.endsWith(":")).toBe(false);
      expect(key).toContain(":u1:vmcp");
    }
  });
});
