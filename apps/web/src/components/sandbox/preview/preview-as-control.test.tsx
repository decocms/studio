import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@decocms/ui/components/tooltip.tsx";
import type { PreviewOptions } from "@/components/sections-editor/preview-link";
import { PreviewAsControl } from "./preview-as-control";

function open(
  options: PreviewOptions,
  tests = ["hero-test", "cta-test"],
  available = true,
) {
  const onChange = mock((_next: PreviewOptions) => {});
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <PreviewAsControl
          tests={tests}
          options={options}
          onChange={onChange}
          available={available}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(within(document.body).getByTestId("preview-as-trigger"));
  return { onChange, panel: within(document.body).getByTestId("preview-as") };
}

describe("PreviewAsControl", () => {
  test("lists each test with Off and On, none chosen until forced", () => {
    const { panel } = open({});
    const rows = within(panel).getAllByTestId("preview-as-test");
    expect(rows.map((row) => row.textContent)).toEqual([
      "hero-testOffOn",
      "cta-testOffOn",
    ]);
    for (const item of within(panel).getAllByRole("radio")) {
      expect(item.getAttribute("aria-checked")).toBe("false");
    }
    expect(within(panel).queryByText("Show as it is now")).toBeNull();
  });

  test("forces a test on, keeping the moment", () => {
    const { panel, onChange } = open({ at: "2026-11-27T00:00:00-03:00" });
    const row = within(panel).getAllByTestId("preview-as-test")[0]!;
    fireEvent.click(within(row).getByText("On"));
    expect(onChange).toHaveBeenCalledWith({
      at: "2026-11-27T00:00:00-03:00",
      tests: { "hero-test": true },
    });
  });

  test("clicking the forced side again lets the visit decide", () => {
    const { panel, onChange } = open({ tests: { "hero-test": false } });
    const row = within(panel).getAllByTestId("preview-as-test")[0]!;
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
    fireEvent.click(within(panel).getByText("Now"));
    expect(onChange).toHaveBeenLastCalledWith({ tests: { "cta-test": true } });
    fireEvent.click(within(panel).getByText("Show as it is now"));
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  test("guides when the site has no tests, or nothing to preview yet", () => {
    const { panel } = open({}, [], false);
    expect(within(panel).getByText("No A/B tests yet.")).toBeTruthy();
    expect(
      within(panel).getByText(/Make a change or publish your site first/),
    ).toBeTruthy();
  });
});
