import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { useCollectionActions } from "./use-collections";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const fakeClient = (fail: boolean) =>
  ({
    callTool: async () =>
      fail
        ? { isError: true, content: [{ type: "text", text: "boom" }] }
        : { structuredContent: { item: { id: "vm" } } },
  }) as unknown as Client;

async function runUpdate(silent: boolean, fail: boolean) {
  const { result } = renderHook(
    () =>
      useCollectionActions("org", "VIRTUAL_MCP", fakeClient(fail), {
        silent,
      }),
    { wrapper },
  );
  await act(async () => {
    await result.current.update
      .mutateAsync({ id: "vm", data: {} })
      .catch(() => {});
  });
}

describe("useCollectionActions toasts", () => {
  it("toasts an update by default", async () => {
    const before = toast.getToasts().length;
    await runUpdate(false, false);
    expect(toast.getToasts().length - before).toBe(1);
  });

  it("silent: a background update says nothing, success or failure", async () => {
    const before = toast.getToasts().length;
    await runUpdate(true, false);
    await runUpdate(true, true);
    expect(toast.getToasts().length - before).toBe(0);
  });
});
