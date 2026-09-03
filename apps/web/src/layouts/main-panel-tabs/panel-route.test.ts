import { describe, expect, test } from "bun:test";
import { isKnownPanelSegment, tabIdForPanel } from "./panel-route";
import {
  formatCodeTabId,
  formatDeckTabId,
  formatFileTabId,
  formatLibraryFileTabId,
  formatPinnedViewTabId,
} from "./tab-id";

describe("legacy panel parser", () => {
  test("recognizes legacy view-first segments without claiming opaque ids", () => {
    for (const panel of [
      "site-editor",
      "preview",
      "content",
      "settings",
      "board",
      "app",
      "library-file",
    ]) {
      expect(isKnownPanelSegment(panel)).toBe(true);
    }

    for (const segment of ["vir_1", "my-custom-view", "analytics"]) {
      expect(isKnownPanelSegment(segment)).toBe(false);
    }
  });

  test("decodes every payload-carrying legacy panel", () => {
    expect(
      tabIdForPanel("app", { connection: "conn_1", tool: "get_orders" }),
    ).toBe(formatPinnedViewTabId("conn_1", "get_orders"));
    expect(tabIdForPanel("automations", { automation: "auto_1" })).toBe(
      "automation:auto_1",
    );
    expect(tabIdForPanel("file", { key: "outputs/a b.pdf" })).toBe(
      formatFileTabId("outputs/a b.pdf"),
    );
    expect(tabIdForPanel("deck", { deck: "decks/a b.html" })).toBe(
      formatDeckTabId("decks/a b.html"),
    );
    expect(tabIdForPanel("library-file", { path: "home/a b.md" })).toBe(
      formatLibraryFileTabId("home/a b.md"),
    );
    expect(tabIdForPanel("code", { file: "src/a b.tsx" })).toBe(
      formatCodeTabId("src/a b.tsx"),
    );
  });

  test("keeps meaningful bare forms and rejects truncated payloads", () => {
    expect(tabIdForPanel("automations", {})).toBe("automations");
    expect(tabIdForPanel("code", {})).toBe("code");
    expect(tabIdForPanel("app", {})).toBeUndefined();
    expect(tabIdForPanel("file", {})).toBeUndefined();
    expect(tabIdForPanel(undefined, {})).toBeUndefined();
  });

  test("normalizes retired Site Editor spellings", () => {
    expect(tabIdForPanel("preview", {})).toBe("site-editor");
    expect(tabIdForPanel("site-editor", { main: "content" })).toBe("content");
    expect(tabIdForPanel("content", {})).toBe("content");
  });
});
