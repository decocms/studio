import { describe, expect, test } from "bun:test";
import {
  getSourceSystemTabs,
  shouldDeepLinkSourceTab,
} from "./source-system-tabs";

describe("getSourceSystemTabs", () => {
  test("returns Preview and Code for clonable source", () => {
    expect(getSourceSystemTabs(true)).toEqual([
      { id: "preview", title: "Preview" },
      { id: "code", title: "Code" },
    ]);
  });

  test("returns no source tabs without clonable source", () => {
    expect(getSourceSystemTabs(false)).toEqual([]);
  });
});

describe("shouldDeepLinkSourceTab", () => {
  test("deep-links Preview/Code from off the Report Agent on reports-only", () => {
    for (const tabId of ["preview", "code"]) {
      expect(
        shouldDeepLinkSourceTab({
          reportsOnly: true,
          onReportAgent: false,
          tabId,
        }),
      ).toBe(true);
    }
  });

  test("does not deep-link when already on the Report Agent", () => {
    expect(
      shouldDeepLinkSourceTab({
        reportsOnly: true,
        onReportAgent: true,
        tabId: "preview",
      }),
    ).toBe(false);
  });

  test("does not deep-link for non-reports-only orgs", () => {
    expect(
      shouldDeepLinkSourceTab({
        reportsOnly: false,
        onReportAgent: false,
        tabId: "preview",
      }),
    ).toBe(false);
  });

  test("only deep-links the source tabs, not other tabs", () => {
    for (const tabId of ["settings", "automations", "overview", "content"]) {
      expect(
        shouldDeepLinkSourceTab({
          reportsOnly: true,
          onReportAgent: false,
          tabId,
        }),
      ).toBe(false);
    }
  });
});
