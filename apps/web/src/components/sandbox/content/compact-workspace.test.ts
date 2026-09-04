import { describe, expect, test } from "bun:test";
import {
  collectionStartStage,
  COMPACT_CONTENT_WORKSPACE_WIDTH,
  isCompactContentWorkspace,
} from "./compact-workspace";

describe("compact content workspace", () => {
  test("uses the measured container width and treats an unmeasured width as wide", () => {
    expect(isCompactContentWorkspace(-1)).toBe(false);
    expect(isCompactContentWorkspace(0)).toBe(true);
    expect(isCompactContentWorkspace(COMPACT_CONTENT_WORKSPACE_WIDTH - 1)).toBe(
      true,
    );
    expect(isCompactContentWorkspace(COMPACT_CONTENT_WORKSPACE_WIDTH)).toBe(
      false,
    );
  });

  test("routes collections with their own workspace directly to detail", () => {
    for (const collection of [
      "site",
      "seo",
      "calendar",
      "post-schedule",
      "loaders",
      "actions",
    ] as const) {
      expect(collectionStartStage(collection)).toBe("detail");
    }
  });

  test("routes item-backed collections through their item list", () => {
    for (const collection of [
      "pages",
      "sections",
      "apps",
      "redirects",
      "posts",
      "authors",
      "categories",
    ] as const) {
      expect(collectionStartStage(collection)).toBe("items");
    }
  });
});
