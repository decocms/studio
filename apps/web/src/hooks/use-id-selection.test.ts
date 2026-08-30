import { setupComponentTest } from "../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useIdSelection } from "./use-id-selection";

describe("useIdSelection", () => {
  it("resolves the selected item by id and reports it open", () => {
    const items = [{ id: "a" }, { id: "b" }];
    const { result } = renderHook(() => useIdSelection(items));

    act(() => result.current.select("b"));

    expect(result.current.selected).toEqual({ id: "b" });
    expect(result.current.index).toBe(1);
    expect(result.current.isOpen).toBe(true);
  });

  it("closes instead of staying open on a stale id when the item drops out of the list", () => {
    const items = [{ id: "a" }, { id: "b" }];
    const { result, rerender } = renderHook(
      ({ items }) => useIdSelection(items),
      { initialProps: { items } },
    );

    act(() => result.current.select("b"));
    expect(result.current.isOpen).toBe(true);

    // "b" is filtered out from underneath the open sheet.
    rerender({ items: [items[0]!] });

    expect(result.current.selected).toBeNull();
    expect(result.current.isOpen).toBe(false);
  });

  it("prev/next follow the current list order and clamp at the ends", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const { result } = renderHook(() => useIdSelection(items));

    act(() => result.current.select("a"));
    act(() => result.current.prev());
    expect(result.current.selected?.id).toBe("a"); // clamped, no item before the first

    act(() => result.current.next());
    expect(result.current.selected?.id).toBe("b");

    act(() => result.current.select("c"));
    act(() => result.current.next());
    expect(result.current.selected?.id).toBe("c"); // clamped, no item after the last
  });
});
