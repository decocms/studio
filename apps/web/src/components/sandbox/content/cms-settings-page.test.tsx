import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { afterAll, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as realBackend from "@/components/sections-editor/use-content-backend";
import * as realSaveBlock from "@/components/sections-editor/use-save-block";

const saves: Array<[string, unknown]> = [];
const backendModule = { ...realBackend };
const saveBlockModule = { ...realSaveBlock };
afterAll(() => {
  mock.module(
    "@/components/sections-editor/use-content-backend",
    () => backendModule,
  );
  mock.module(
    "@/components/sections-editor/use-save-block",
    () => saveBlockModule,
  );
});
mock.module("@/components/sections-editor/use-save-block", () => ({
  ...realSaveBlock,
  useDebouncedSaveBlock: () => ({
    save: (key: string, data: unknown) => saves.push([key, data]),
    flush: () => {},
    hold: () => {},
    isPending: false,
  }),
}));
mock.module("@/components/sections-editor/use-content-backend", () => ({
  ...realBackend,
  useContentBackend: () => ({ kind: "legacy" }),
}));

const { CmsSettingsPage } = await import("./cms-settings-page");

function renderPage(block: Record<string, unknown>) {
  saves.length = 0;
  const onOpenForm = mock();
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <CmsSettingsPage
        orgSlug="acme"
        virtualMcpId="vm"
        branch="draft"
        block={block}
        saveGuard={{ ifMatch: () => undefined }}
        onOpenForm={onOpenForm}
      />
    </QueryClientProvider>,
  );
  return { view, onOpenForm };
}

// Typing into the inputs isn't covered here: this test DOM never fires
// React's onChange for a typed value. What typing saves is tested in
// cms-settings.test.ts (percentToRate, isCollectorUrl, applyCmsSettingsEdits).
describe("CmsSettingsPage", () => {
  test("shows the defaults as percentages, and saves nothing by opening", () => {
    const { view } = renderPage({ __resolveType: "cms-settings" });
    expect(
      (view.getByLabelText("Error sampling") as HTMLInputElement).value,
    ).toBe("5");
    expect(
      (view.getByLabelText("Trace sampling") as HTMLInputElement).value,
    ).toBe("0");
    expect(
      view
        .getByRole("switch", { name: "Send telemetry" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(saves).toEqual([]);
    cleanup();
  });

  test("shows saved values: a rate as its percentage, the collector", () => {
    const { view } = renderPage({
      __resolveType: "cms-settings",
      telemetry: { errorSampleRate: 0.125, traceSampleRate: 0.001 },
      analytics: { collector: "https://c.example.com" },
    });
    expect(
      (view.getByLabelText("Error sampling") as HTMLInputElement).value,
    ).toBe("12.5");
    expect(
      (view.getByLabelText("Trace sampling") as HTMLInputElement).value,
    ).toBe("0.1");
    expect((view.getByLabelText("Collector") as HTMLInputElement).value).toBe(
      "https://c.example.com",
    );
    cleanup();
  });

  test("telemetry off turns off its fields; analytics off, the collector", () => {
    const { view } = renderPage({
      __resolveType: "cms-settings",
      analytics: { enabled: false },
    });
    expect(
      (view.getByLabelText("Collector") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (view.getByLabelText("Error sampling") as HTMLInputElement).disabled,
    ).toBe(false);
    fireEvent.click(view.getByRole("switch", { name: "Send telemetry" }));
    expect(saves.at(-1)?.[1]).toEqual({
      __resolveType: "cms-settings",
      analytics: { enabled: false },
      telemetry: { enabled: false },
    });
    expect(
      (view.getByLabelText("Error sampling") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      view.getByRole("switch", { name: "Metrics" }).hasAttribute("disabled"),
    ).toBe(true);
    cleanup();
  });

  test("a field set with variants is read-only, with the way to the block form", () => {
    const variants = {
      __resolveType: "multivariate",
      variants: [{ rule: { __resolveType: "always" }, value: {} }],
    };
    const { view, onOpenForm } = renderPage({
      __resolveType: "cms-settings",
      telemetry: variants,
    });
    expect(view.queryByLabelText("Error sampling")).toBeNull();
    expect(
      view.getAllByText("Set with variants; edit it in the block form.").length,
    ).toBe(4);
    fireEvent.click(
      view.getAllByRole("button", { name: "Open block form" })[0]!,
    );
    expect(onOpenForm).toHaveBeenCalledTimes(1);
    // Analytics still edits, the telemetry variants untouched.
    fireEvent.click(view.getByRole("switch", { name: "Collect analytics" }));
    expect(saves.at(-1)?.[1]).toEqual({
      __resolveType: "cms-settings",
      telemetry: variants,
      analytics: { enabled: false },
    });
    cleanup();
  });
});
