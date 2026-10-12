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

const { useLocalPreviewUrl } = await import("./use-local-preview-url");

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
    // Also while main's answer loads or can't be read: never a sandbox boot
    // a v7 site didn't have on main.
    for (const main of ["v7", "loading", "error"] as const) {
      mainRef.current = main;
      const { result } = renderHook(() => useLocalPreviewUrl("vmcp"), {
        wrapper,
      });
      expect(result.current.url).toBe(TUNNEL);
    }
  });

  it("Blocks v8 (main's schema): a tunnel saved earlier is ignored (preview and editor)", () => {
    mainRef.current = "v8";
    const { result } = renderHook(() => useLocalPreviewUrl("vmcp"), {
      wrapper,
    });
    expect(result.current.url).toBeNull();
  });
});
