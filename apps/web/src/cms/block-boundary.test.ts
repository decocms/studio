import { expect, test } from "bun:test";
import { nextEditorView } from "./block-boundary";

test("returning through an unready destination cannot reuse an old readiness latch", () => {
  const first = { key: "draft-a", opened: true };
  const loading = nextEditorView(first, "draft-b", false);
  expect(loading).toEqual({ key: "draft-b", opened: false });
  const returned = nextEditorView(loading, "draft-a", false);
  expect(returned).toEqual({ key: "draft-a", opened: false });
  expect(nextEditorView(returned, "draft-a", true)).toEqual(first);
});

test("background refresh cannot close an already opened form in the same destination", () => {
  const opened = { key: "draft-a", opened: true };
  expect(nextEditorView(opened, "draft-a", false)).toBe(opened);
  expect(nextEditorView(opened, "draft-a", true)).toBe(opened);
});

test("a different destination can open only from its own complete snapshot", () => {
  const opened = { key: "draft-a", opened: true };
  expect(nextEditorView(opened, "draft-b", false).opened).toBe(false);
  expect(nextEditorView(opened, "draft-b", true)).toEqual({
    key: "draft-b",
    opened: true,
  });
});
