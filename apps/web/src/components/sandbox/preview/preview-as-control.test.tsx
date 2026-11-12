import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@decocms/ui/components/tooltip.tsx";
import type { HostedBlocksLoad } from "@/cms/hosted-content";
import type { PreviewOptions } from "@/components/sections-editor/preview-link";
import { PreviewAsControl } from "./preview-as-control";

function open(
  options: PreviewOptions,
  tests = ["hero-test", "cta-test"],
  available = true,
  load?: HostedBlocksLoad,
) {
  const onChange = mock((_next: PreviewOptions) => {});
  const onOpen = mock(() => {});
  const ui = (next?: HostedBlocksLoad) => (
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <PreviewAsControl
          tests={tests}
          load={next}
          onOpen={onOpen}
          options={options}
          onChange={onChange}
          available={available}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = render(ui(load));
  fireEvent.click(within(document.body).getByTestId("preview-as-trigger"));
  return {
    onChange,
    onOpen,
    rerender: (next: HostedBlocksLoad) => view.rerender(ui(next)),
    panel: () => within(within(document.body).getByTestId("preview-as")),
  };
}

describe("PreviewAsControl", () => {
  test("lists each test with Off and On, none chosen until forced", () => {
    const { panel } = open({});
    const rows = panel().getAllByTestId("preview-as-test");
    expect(rows.map((row) => row.textContent)).toEqual([
      "hero-testOffOn",
      "cta-testOffOn",
    ]);
    for (const item of panel().getAllByRole("radio")) {
      expect(item.getAttribute("aria-checked")).toBe("false");
    }
    expect(panel().queryByText("Show as it is now")).toBeNull();
  });

  test("forces a test on, keeping the moment", () => {
    const { panel, onChange } = open({ at: "2026-11-27T00:00:00-03:00" });
    const row = panel().getAllByTestId("preview-as-test")[0]!;
    fireEvent.click(within(row).getByText("On"));
    expect(onChange).toHaveBeenCalledWith({
      at: "2026-11-27T00:00:00-03:00",
      tests: { "hero-test": true },
    });
  });

  test("clicking the forced side again lets the visit decide", () => {
    const { panel, onChange } = open({ tests: { "hero-test": false } });
    const row = panel().getAllByTestId("preview-as-test")[0]!;
    const off = within(row).getByText("Off");
    expect(off.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(off);
    expect(onChange).toHaveBeenCalledWith({});
  });

  test("Now drops the moment and the reset drops everything", () => {
    const { panel, onChange } = open({
      at: "2026-11-27T00:00:00-03:00",
      tests: { "cta-test": true },
    });
    fireEvent.click(panel().getByText("Now"));
    expect(onChange).toHaveBeenLastCalledWith({ tests: { "cta-test": true } });
    fireEvent.click(panel().getByText("Show as it is now"));
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  test("loads the tests when it opens: a spinner, then the tests, never 'No A/B tests yet' first", () => {
    const retry = mock(() => {});
    const { panel, onOpen, rerender } = open({}, [], true, {
      ready: false,
      failed: false,
      retry,
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(panel().getByTestId("preview-as-tests-loading")).toBeTruthy();
    expect(panel().queryByText("No A/B tests yet.")).toBeNull();

    rerender({ ready: false, failed: true, retry });
    expect(panel().getByText("Couldn't load your tests.")).toBeTruthy();
    fireEvent.click(panel().getByText("Try again"));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(panel().queryByText("No A/B tests yet.")).toBeNull();
  });

  test("once loaded it lists them", () => {
    const { panel } = open({}, ["hero-test"], true, {
      ready: true,
      failed: false,
      retry: () => {},
    });
    expect(panel().getAllByTestId("preview-as-test")).toHaveLength(1);
    expect(panel().queryByTestId("preview-as-tests-loading")).toBeNull();
  });

  test("guides when the site has no tests, or nothing to preview yet", () => {
    const { panel } = open({}, [], false);
    expect(panel().getByText("No A/B tests yet.")).toBeTruthy();
    expect(
      panel().getByText(/Make a change or publish your site first/),
    ).toBeTruthy();
  });
});
