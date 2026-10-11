import { setupComponentTest } from "../../test/setup";
setupComponentTest();

import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

const projectRef: { current: { metadata: Record<string, unknown> } | null } = {
  current: null,
};
mock.module("@/sdk", () => ({
  useVirtualMCP: () => projectRef.current,
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
    projectRef.current = { metadata: {} };
    const { result } = renderHook(() => useLocalPreviewUrl("vmcp"), {
      wrapper,
    });
    expect(result.current.url).toBe(TUNNEL);
  });

  it("Blocks v8: a tunnel saved earlier is ignored (preview and editor)", () => {
    projectRef.current = { metadata: { blocksMajor: 8 } };
    const { result } = renderHook(() => useLocalPreviewUrl("vmcp"), {
      wrapper,
    });
    expect(result.current.url).toBeNull();
  });
});
