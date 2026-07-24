import { describe, expect, test } from "bun:test";
import { selectTabSlots } from "./select-tab-slots";

type T = { id: string };
const tab = (id: string): T => ({ id });

describe("selectTabSlots", () => {
  test("empty list → empty visible and overflow", () => {
    expect(selectTabSlots([], null, 6)).toEqual({
      visible: [],
      overflow: [],
    });
  });

  test("3 tabs, cap 6 → all visible, no overflow", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    expect(selectTabSlots(tabs, null, 6)).toEqual({
      visible: tabs,
      overflow: [],
    });
  });

  test("6 tabs, cap 6 → all visible, no overflow", () => {
    const tabs = [tab("a"), tab("b"), tab("c"), tab("d"), tab("e"), tab("f")];
    expect(selectTabSlots(tabs, null, 6)).toEqual({
      visible: tabs,
      overflow: [],
    });
  });

  test("10 tabs, cap 6, active is 3rd → no shuffle", () => {
    const tabs = [
      tab("a"),
      tab("b"),
      tab("c"),
      tab("d"),
      tab("e"),
      tab("f"),
      tab("g"),
      tab("h"),
      tab("i"),
      tab("j"),
    ];
    expect(selectTabSlots(tabs, "c", 6)).toEqual({
      visible: tabs.slice(0, 6),
      overflow: tabs.slice(6),
    });
  });

  test("10 tabs, cap 6, active is 8th → promote; displaced tab heads overflow", () => {
    const tabs = [
      tab("a"),
      tab("b"),
      tab("c"),
      tab("d"),
      tab("e"),
      tab("f"),
      tab("g"),
      tab("h"),
      tab("i"),
      tab("j"),
    ];
    const result = selectTabSlots(tabs, "h", 6);
    expect(result.visible.map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "h",
    ]);
    expect(result.overflow.map((t) => t.id)).toEqual(["f", "g", "i", "j"]);
  });

  test("10 tabs, cap 6, activeId=null → first 6 visible", () => {
    const tabs = Array.from({ length: 10 }, (_, i) => tab(String(i)));
    expect(selectTabSlots(tabs, null, 6)).toEqual({
      visible: tabs.slice(0, 6),
      overflow: tabs.slice(6),
    });
  });

  test("10 tabs, cap 6, activeId not in list → treated as null", () => {
    const tabs = Array.from({ length: 10 }, (_, i) => tab(String(i)));
    expect(selectTabSlots(tabs, "not-a-tab", 6)).toEqual({
      visible: tabs.slice(0, 6),
      overflow: tabs.slice(6),
    });
  });
});
