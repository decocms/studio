import { expect, test } from "bun:test";
import { pruneOrphanedUiRefs } from "./prune-orphaned-ui-refs";

test("drops a pinned view for the removed connection", () => {
  const { ui, changed } = pruneOrphanedUiRefs(
    {
      pinnedViews: [
        { connectionId: "conn_a", toolName: "foo" },
        { connectionId: "conn_b", toolName: "bar" },
      ],
    },
    "conn_a",
  );
  expect(changed).toBe(true);
  expect(ui.pinnedViews).toEqual([{ connectionId: "conn_b", toolName: "bar" }]);
});

test("nulls pinnedViews once every entry is dropped", () => {
  const { ui, changed } = pruneOrphanedUiRefs(
    { pinnedViews: [{ connectionId: "conn_a", toolName: "foo" }] },
    "conn_a",
  );
  expect(changed).toBe(true);
  expect(ui.pinnedViews).toBeNull();
});

test("nulls the legacy single homeTile when it points at the removed connection", () => {
  const { ui, changed } = pruneOrphanedUiRefs(
    { homeTile: { connectionId: "conn_a", resourceUri: "ui://x" } },
    "conn_a",
  );
  expect(changed).toBe(true);
  expect(ui.homeTile).toBeNull();
});

test("drops a homeTiles entry for the removed connection", () => {
  const { ui, changed } = pruneOrphanedUiRefs(
    {
      homeTiles: [
        { connectionId: "conn_a", resourceUri: "ui://a" },
        { connectionId: "conn_b", resourceUri: "ui://b" },
      ],
    },
    "conn_a",
  );
  expect(changed).toBe(true);
  expect(ui.homeTiles).toEqual([
    { connectionId: "conn_b", resourceUri: "ui://b" },
  ]);
});

test("is a no-op when nothing references the removed connection", () => {
  const original = {
    pinnedViews: [{ connectionId: "conn_b", toolName: "bar" }],
    homeTile: { connectionId: "conn_b", resourceUri: "ui://b" },
  };
  const { ui, changed } = pruneOrphanedUiRefs(original, "conn_a");
  expect(changed).toBe(false);
  expect(ui).toEqual(original);
});

test("leaves a homeTile with no connectionId untouched", () => {
  const { ui, changed } = pruneOrphanedUiRefs(
    { homeTile: { resourceUri: "ui://x" } },
    "conn_a",
  );
  expect(changed).toBe(false);
  expect(ui.homeTile).toEqual({ resourceUri: "ui://x" });
});
