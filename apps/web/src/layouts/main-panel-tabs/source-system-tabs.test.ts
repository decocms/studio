import { describe, expect, test } from "bun:test";
import {
  getSourceSystemTabs,
  getViewerSafeFallbackTab,
  resolveViewerActiveTab,
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

  test("keeps Preview but hides owner-only Code for a teammate", () => {
    expect(getSourceSystemTabs(true, false)).toEqual([
      { id: "preview", title: "Preview" },
    ]);
  });
});

describe("getViewerSafeFallbackTab", () => {
  test("uses Preview when a read-only source is available", () => {
    expect(getViewerSafeFallbackTab(true)).toBe("preview");
  });

  test("uses Settings instead of an owner-only configured default without source", () => {
    expect(getViewerSafeFallbackTab(false)).toBe("settings");
  });
});

describe("resolveViewerActiveTab", () => {
  const base = {
    hasClonableSource: false,
    configuredLayoutTabIds: [] as string[],
    gitTabVisible: false,
    gitQueryPending: false,
  };

  test("replaces a configured Code default with a safe viewer tab", () => {
    expect(resolveViewerActiveTab({ ...base, rawActiveTab: "code" })).toBe(
      "settings",
    );
  });

  test("falls back to read-only Preview when source is available", () => {
    expect(
      resolveViewerActiveTab({
        ...base,
        rawActiveTab: "code:src%2Findex.ts",
        hasClonableSource: true,
      }),
    ).toBe("preview");
  });

  test("rejects app, content, and configured layout tabs", () => {
    for (const rawActiveTab of ["app:conn:tool", "content", "custom-view"]) {
      expect(
        resolveViewerActiveTab({
          ...base,
          rawActiveTab,
          configuredLayoutTabIds: ["custom-view"],
        }),
      ).toBe("settings");
    }
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
