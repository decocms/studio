import { setupComponentTest } from "../../test/setup";
setupComponentTest();

import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

const mainRef: { current: "v8" | "v7" | "loading" | "error" } = {
  current: "v7",
};
mock.module("@/hooks/use-main-schema-v8", () => ({
  useMainSchemaV8: () => mainRef.current,
}));

const { localTunnelState, useLocalPreviewUrl } = await import(
  "./use-local-preview-url"
);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const TUNNEL = "https://my-tunnel.example.com/";

describe("useLocalPreviewUrl (the v7 Local tunnel)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      LOCALSTORAGE_KEYS.localPreviewUrl("vmcp"),
      JSON.stringify(TUNNEL),
    );
  });

  it("v7: a saved tunnel is in use, as on main", () => {
    mainRef.current = "v7";
    const { result } = renderHook(() => useLocalPreviewUrl("vmcp"), {
      wrapper,
    });
    expect(result.current).toMatchObject({ url: TUNNEL, undecided: false });
  });

  it("while main's answer loads or is retried: undecided, the tunnel not in use yet", () => {
    for (const main of ["loading", "error"] as const) {
      mainRef.current = main;
      const { result } = renderHook(() => useLocalPreviewUrl("vmcp"), {
        wrapper,
      });
      expect(result.current).toMatchObject({ url: null, undecided: true });
    }
  });

  it("Blocks v8 (main's schema): a tunnel saved earlier is ignored (preview and editor)", () => {
    mainRef.current = "v8";
    const { result } = renderHook(() => useLocalPreviewUrl("vmcp"), {
      wrapper,
    });
    expect(result.current).toMatchObject({ url: null, undecided: false });
  });

  it("no saved tunnel: nothing to wait for", () => {
    localStorage.clear();
    mainRef.current = "loading";
    const { result } = renderHook(() => useLocalPreviewUrl("vmcp"), {
      wrapper,
    });
    expect(result.current).toMatchObject({ url: null, undecided: false });
  });
});

describe("localTunnelState: the tunnel never shows first and switches", () => {
  const states = (mains: Array<"v8" | "v7" | "loading" | "error">) =>
    mains.map((main) => localTunnelState({ saved: TUNNEL, main }));

  it("loading, then v8: never shows the tunnel", () => {
    const seen = states(["loading", "error", "v8"]);
    expect(seen.every((s) => s.url === null)).toBe(true);
    expect(seen.at(-1)).toEqual({ url: null, undecided: false });
  });

  it("loading, then v7: waits (nothing else in its place), then shows it", () => {
    const seen = states(["loading", "v7"]);
    expect(seen).toEqual([
      { url: null, undecided: true },
      { url: TUNNEL, undecided: false },
    ]);
  });
});
