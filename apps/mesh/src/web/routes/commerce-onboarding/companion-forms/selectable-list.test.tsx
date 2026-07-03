import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SelectableList } from "./selectable-list";

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
