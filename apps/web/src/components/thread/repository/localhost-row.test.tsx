import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { fireEvent, render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, expect, it, mock } from "bun:test";
import { LocalhostRow } from "./localhost-row";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

describe("LocalhostRow", () => {
  const renderRow = (props: { selected: boolean; connected: boolean }) => {
    const onSelect = mock(() => {});
    const view = render(<LocalhostRow {...props} onSelect={onSelect} />);
    return { ...view, onSelect };
  };

  it("just a dot and its name; choosing it calls onSelect", () => {
    const { getByRole, queryByText, onSelect } = renderRow({
      selected: false,
      connected: false,
    });
    const button = getByRole("button", { pressed: false });
    expect(button).toHaveTextContent(/^Localhost$/);
    expect(queryByText(/serve/)).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("chosen and waiting: no command, guide or spinner (the Preview has them)", () => {
    const { getByRole, container } = renderRow({
      selected: true,
      connected: false,
    });
    expect(getByRole("button", { pressed: true })).toHaveTextContent(
      /^Localhost$/,
    );
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("connected: one short word", () => {
    const { getByRole } = renderRow({ selected: true, connected: true });
    expect(getByRole("button", { pressed: true })).toHaveTextContent(
      "LocalhostConnected",
    );
  });

  it("the dot is always black, whatever the state", () => {
    for (const props of [
      { selected: false, connected: false },
      { selected: true, connected: false },
      { selected: true, connected: true },
    ]) {
      const view = renderRow(props);
      const dot = view.getByTestId("localhost-dot");
      expect(dot).toHaveClass("bg-foreground");
      expect(dot.className).not.toMatch(
        /animate-|bg-(special|success|warning|destructive)/,
      );
      view.unmount();
    }
  });
});
