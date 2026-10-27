import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { afterAll, describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as realBackend from "@/components/sections-editor/use-content-backend.ts";

/** How many times a render asked for the content backend. */
const asked = { count: 0 };
const backendModule = { ...realBackend };
afterAll(() => {
  mock.module(
    "@/components/sections-editor/use-content-backend.ts",
    () => backendModule,
  );
});
mock.module("@/components/sections-editor/use-content-backend.ts", () => ({
  ...realBackend,
  useContentBackend: () => {
    asked.count++;
    return { kind: "protocol", source: "github" };
  },
}));

const { PublishDialog } = await import("./publish-dialog");

describe("PublishDialog while closed", () => {
  test("asks nothing about the site's content (no backend probes from a closed dialog)", () => {
    asked.count = 0;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PublishDialog
          {...({
            open: false,
            mode: "publish",
            onOpenChange: () => {},
            orgSlug: "acme",
            virtualMcpId: "vm",
            branch: "draft",
          } as unknown as Parameters<typeof PublishDialog>[0])}
        />
      </QueryClientProvider>,
    );
    expect(asked.count).toBe(0);
  });
});
