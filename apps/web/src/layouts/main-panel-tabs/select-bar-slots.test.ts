import { describe, expect, test } from "bun:test";
import { selectBarSlots } from "./select-bar-slots";

type Item = { id: string; active: boolean };
const item = (id: string, active = false): Item => ({ id, active });
const ids = (xs: Item[]) => xs.map((x) => x.id);

describe("selectBarSlots — code agents", () => {
  test("only Preview visible when nothing else is active", () => {
    const items = [
      item("preview"),
      item("code"),
      item("content"),
      item("files"),
    ];
    const { visible, overflow } = selectBarSlots({
      items,
      persisted: [],
      maxVisible: 3,
      isCodeAgent: true,
    });
    expect(ids(visible)).toEqual(["preview"]);
    // default order: preview, content, files lead; code (unranked) trails.
    expect(ids(overflow)).toEqual(["content", "files", "code"]);
  });

  test("active view shows beside the pinned Preview", () => {
    const items = [item("preview"), item("code"), item("content", true)];
    const { visible, overflow } = selectBarSlots({
      items,
      persisted: [],
      maxVisible: 3,
      isCodeAgent: true,
    });
    expect(ids(visible)).toEqual(["preview", "content"]);
    expect(ids(overflow)).toEqual(["code"]);
  });

  test("Preview active → single pinned Preview (no duplicate)", () => {
    const items = [item("preview", true), item("code"), item("content")];
    const { visible } = selectBarSlots({
      items,
      persisted: [],
      maxVisible: 3,
      isCodeAgent: true,
    });
    expect(ids(visible)).toEqual(["preview"]);
  });

  test("no Preview tab → just the active item", () => {
    const items = [item("code", true), item("content")];
    const { visible, overflow } = selectBarSlots({
      items,
      persisted: [],
      maxVisible: 3,
      isCodeAgent: true,
    });
    expect(ids(visible)).toEqual(["code"]);
    expect(ids(overflow)).toEqual(["content"]);
  });

  test("persisted promotions are ignored for code agents (Preview stays pinned)", () => {
    const items = [item("preview"), item("code"), item("content")];
    const { visible } = selectBarSlots({
      items,
      persisted: ["code"],
      maxVisible: 3,
      isCodeAgent: true,
    });
    expect(ids(visible)).toEqual(["preview"]);
  });
});

describe("selectBarSlots — non-code agents", () => {
  test("delegates to selectTabSlots within the cap", () => {
    const items = [item("a"), item("b"), item("c"), item("d")];
    const { visible, overflow } = selectBarSlots({
      items,
      persisted: [],
      maxVisible: 3,
      isCodeAgent: false,
    });
    expect(ids(visible)).toEqual(["a", "b", "c"]);
    expect(ids(overflow)).toEqual(["d"]);
  });

  test("default lead order pulls Preview/Content/Library forward", () => {
    const items = [
      item("code"),
      item("files"),
      item("content"),
      item("preview"),
    ];
    const { visible } = selectBarSlots({
      items,
      persisted: [],
      maxVisible: 3,
      isCodeAgent: false,
    });
    expect(ids(visible)).toEqual(["preview", "content", "files"]);
  });

  test("persisted ids lead the row", () => {
    const items = [
      item("preview"),
      item("content"),
      item("files"),
      item("code"),
    ];
    const { visible, overflow } = selectBarSlots({
      items,
      persisted: ["code"],
      maxVisible: 3,
      isCodeAgent: false,
    });
    expect(ids(visible)).toEqual(["code", "preview", "content"]);
    expect(ids(overflow)).toEqual(["files"]);
  });

  test("stale persisted ids are dropped", () => {
    const items = [item("preview"), item("content")];
    const { visible, overflow } = selectBarSlots({
      items,
      persisted: ["ghost", "content"],
      maxVisible: 3,
      isCodeAgent: false,
    });
    // "ghost" no longer exists → ignored; "content" leads.
    expect(ids(visible)).toEqual(["content", "preview"]);
    expect(overflow).toEqual([]);
  });

  test("active item is kept visible even past the cap", () => {
    const items = [item("a"), item("b"), item("c"), item("d", true)];
    const { visible } = selectBarSlots({
      items,
      persisted: [],
      maxVisible: 3,
      isCodeAgent: false,
    });
    expect(ids(visible)).toContain("d");
  });

  test("maxVisible is clamped to [1, MAX_VISIBLE]", () => {
    const items = [item("a"), item("b"), item("c"), item("d")];
    const wide = selectBarSlots({
      items,
      persisted: [],
      maxVisible: 99,
      isCodeAgent: false,
    });
    expect(wide.visible.length).toBe(3); // clamped to MAX_VISIBLE
    const narrow = selectBarSlots({
      items,
      persisted: [],
      maxVisible: 0,
      isCodeAgent: false,
    });
    expect(narrow.visible.length).toBe(1); // clamped up to 1
  });
});
