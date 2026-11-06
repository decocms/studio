import { setupComponentTest } from "../../test/setup";
setupComponentTest();

import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

/** The project's "Blocks v8 site" switch (`useBlocksV8Project`). */
const v8Ref = { current: false };
// The module's other exports stay real: the mock outlives this file.
const realSwitch = await import("@/hooks/use-blocks-v8-project");
mock.module("@/hooks/use-blocks-v8-project", () => ({
  ...realSwitch,
  useBlocksV8Project: () => v8Ref.current,
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

  it("the switch off (v7): a saved tunnel is in use, as on main", () => {
    v8Ref.current = false;
    const { result } = renderHook(() => useLocalPreviewUrl("vmcp"), {
      wrapper,
    });
    expect(result.current.url).toBe(TUNNEL);
  });

  it("the switch on (v8): a tunnel saved earlier is ignored (preview and editor)", () => {
    v8Ref.current = true;
    const { result } = renderHook(() => useLocalPreviewUrl("vmcp"), {
      wrapper,
    });
    expect(result.current.url).toBeNull();
  });

  it("no saved tunnel, or no project: off", () => {
    v8Ref.current = false;
    const none = renderHook(() => useLocalPreviewUrl(null), { wrapper });
    expect(none.result.current.url).toBeNull();
    localStorage.clear();
    const { result } = renderHook(() => useLocalPreviewUrl("vmcp"), {
      wrapper,
    });
    expect(result.current.url).toBeNull();
  });
});
