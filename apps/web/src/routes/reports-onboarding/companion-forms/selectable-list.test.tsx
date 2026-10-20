import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SelectableList } from "./selectable-list";

// SelectableList resolves its search placeholder/aria-label via useT(), which
// reads the language preference through TanStack Query — renders need a
// QueryClientProvider.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
];

describe("SelectableList", () => {
  it("calls onChange when an option is clicked", () => {
    const onChange = mock(() => {});
    const { getByRole } = render(
      <SelectableList
        options={OPTIONS}
        value="a"
        onChange={onChange}
        ariaLabel="Options"
      />,
    );
    fireEvent.click(getByRole("radio", { name: "Beta" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("wraps to the first option on ArrowDown from the last", () => {
    const onChange = mock(() => {});
    const { getByRole } = render(
      <SelectableList
        options={OPTIONS}
        value="c"
        onChange={onChange}
        ariaLabel="Options"
      />,
    );
    fireEvent.keyDown(getByRole("radio", { name: "Gamma" }), {
      key: "ArrowDown",
    });
    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("wraps to the last option on ArrowUp from the first", () => {
    const onChange = mock(() => {});
    const { getByRole } = render(
      <SelectableList
        options={OPTIONS}
        value="a"
        onChange={onChange}
        ariaLabel="Options"
      />,
    );
    fireEvent.keyDown(getByRole("radio", { name: "Alpha" }), {
      key: "ArrowUp",
    });
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("jumps to the last option on End", () => {
    const onChange = mock(() => {});
    const { getByRole } = render(
      <SelectableList
        options={OPTIONS}
        value="a"
        onChange={onChange}
        ariaLabel="Options"
      />,
    );
    fireEvent.keyDown(getByRole("radio", { name: "Alpha" }), { key: "End" });
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("ignores arrow keys when disabled", () => {
    const onChange = mock(() => {});
    const { getByRole } = render(
      <SelectableList
        options={OPTIONS}
        value="a"
        onChange={onChange}
        disabled
        ariaLabel="Options"
      />,
    );
    fireEvent.keyDown(getByRole("radio", { name: "Alpha" }), {
      key: "ArrowDown",
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});
