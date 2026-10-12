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
/** Main's schema answer (`useMainSchemaV8`), never the project's marker. */
const mainRef: { current: "v8" | "v7" | "loading" | "error" } = {
  current: "v8",
};

mock.module("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: sessionRef.current }) },
}));
mock.module("./use-main-schema-v8", () => ({
  useMainSchemaV8: () => mainRef.current,
}));

const { storedConnectionApplies, useDecoServeConnection } = await import(
  "./use-deco-serve-connection"
);

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
    mainRef.current = "v8";
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

  it("a v7 project reads as none, as on main", () => {
    localStorage.setItem(
      LOCALSTORAGE_KEYS.decoServeConnection("u1", "vmcp"),
      JSON.stringify({ endpoint: ENDPOINT }),
    );
    mainRef.current = "v7";
    const { result } = renderHook(() => useDecoServeConnection("vmcp"), {
      wrapper,
    });
    expect(result.current.connection).toBeNull();
    expect(result.current.undecided).toBe(false);
    expect(result.current.lastEndpoint).toBeNull();
  });

  it("a stored choice waits for main's answer instead of reading as none", () => {
    localStorage.setItem(
      LOCALSTORAGE_KEYS.decoServeConnection("u1", "vmcp"),
      JSON.stringify({ endpoint: ENDPOINT }),
    );
    mainRef.current = "loading";
    const { result } = renderHook(() => useDecoServeConnection("vmcp"), {
      wrapper,
    });
    expect(result.current.connection).toBeNull();
    expect(result.current.undecided).toBe(true);
  });

  it("storedConnectionApplies: v8 uses it, v7 never, loading waits", () => {
    expect(storedConnectionApplies("v8", true)).toEqual({
      applies: true,
      undecided: false,
    });
    expect(storedConnectionApplies("v7", true)).toEqual({
      applies: false,
      undecided: false,
    });
    expect(storedConnectionApplies("loading", true)).toEqual({
      applies: false,
      undecided: true,
    });
    // Main unreadable: the choice stands; deco serve's own schema decides.
    expect(storedConnectionApplies("error", true)).toEqual({
      applies: true,
      undecided: false,
    });
    for (const main of ["v8", "v7", "loading", "error"] as const) {
      expect(storedConnectionApplies(main, false)).toEqual({
        applies: false,
        undecided: false,
      });
    }
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
