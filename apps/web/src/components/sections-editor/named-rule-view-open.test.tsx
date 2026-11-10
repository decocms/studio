import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { afterAll, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import * as realApply from "./use-apply-named-rule";
import * as realPublished from "./use-published-content";

const restore = { apply: { ...realApply }, published: { ...realPublished } };
afterAll(() => {
  mock.module("./use-apply-named-rule", () => restore.apply);
  mock.module("./use-published-content", () => restore.published);
});
mock.module("./use-apply-named-rule", () => ({
  ...restore.apply,
  useApplyNamedRule: () => ({
    apply: async () => ({ ok: true }),
    reread: async () => null,
    isPending: false,
    holdsCopy: false,
  }),
}));
mock.module("./use-published-content", () => ({
  ...restore.published,
  usePublishedContent: () => null,
  usePublishedRead: () => ({ state: "loading" }),
}));

const { useNamedRuleView } = await import("./named-rule-view");

const input = {
  orgSlug: "acme",
  virtualMcpId: "vm-1",
  branch: "draft-1",
  decofile: {},
  meta: null,
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

describe("useNamedRuleView's open name", () => {
  test("kept by the view when no caller keeps it", () => {
    const { result } = renderHook(
      () => useNamedRuleView("experiments", input),
      { wrapper },
    );
    expect(result.current.openName).toBeNull();
    act(() => result.current.setOpenName("hero"));
    expect(result.current.openName).toBe("hero");
  });

  test("kept by the caller (the app's ?test=) when given", () => {
    const set = mock((_name: string | null) => {});
    const { result } = renderHook(
      () =>
        useNamedRuleView("experiments", {
          ...input,
          open: { name: "hero", set },
        }),
      { wrapper },
    );
    expect(result.current.openName).toBe("hero");
    act(() => result.current.setOpenName(null));
    expect(set).toHaveBeenCalledWith(null);
    expect(result.current.openName).toBe("hero");
  });
});
