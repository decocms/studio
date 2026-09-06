import { describe, expect, test } from "bun:test";
import {
  isSurfaceTab,
  resolveSurfaceTabs,
  shouldDeepLinkSourceTab,
} from "./source-system-tabs";

describe("resolveSurfaceTabs", () => {
  test("a sandbox session gets Preview, Content and Code", () => {
    expect(
      resolveSurfaceTabs({
        hasSource: true,
        runtime: "sandbox",
        cmsMode: "on",
      }),
    ).toEqual(["site-editor", "content", "code"]);
  });

  /** The whole point of the runtime branch: a CMS session has no sandbox, so
   *  nothing here mentions a dev server and Content still resolves. */
  test("a CMS session resolves Content with no dev server, and no Code", () => {
    expect(
      resolveSurfaceTabs({ hasSource: true, runtime: "cms", cmsMode: "on" }),
    ).toEqual(["site-editor", "content"]);
  });

  /** INVERTED: Content used to drop out when a decofile read came back with
   *  nothing editable, which made the tab depend on a fetch. The agent's own
   *  CMS mode is the only thing that takes it away now. */
  test("Content is offered whenever the agent's CMS is on, read or no read", () => {
    for (const runtime of ["cms", "sandbox"] as const) {
      expect(
        resolveSurfaceTabs({ hasSource: true, runtime, cmsMode: "on" }),
      ).toContain("content");
    }
  });

  test("off is the one thing that takes Content off the surface", () => {
    for (const runtime of ["cms", "sandbox"] as const) {
      expect(
        resolveSurfaceTabs({ hasSource: true, runtime, cmsMode: "off" }),
      ).toEqual(runtime === "cms" ? ["site-editor"] : ["site-editor", "code"]);
    }
  });

  test("returns no surface tabs without a clonable source", () => {
    for (const runtime of ["cms", "sandbox"] as const) {
      expect(
        resolveSurfaceTabs({ hasSource: false, runtime, cmsMode: "on" }),
      ).toEqual([]);
    }
  });
});

describe("isSurfaceTab", () => {
  test("the three views, including Code with a file open", () => {
    for (const tabId of [
      "site-editor",
      "content",
      "code",
      "code:src%2Fapp.tsx",
    ]) {
      expect(isSurfaceTab(tabId)).toBe(true);
    }
  });

  test("everything else is off the surface", () => {
    for (const tabId of [
      "settings",
      "automations",
      "assets",
      "git",
      "overview",
      "app:conn_1:get_orders",
    ]) {
      expect(isSurfaceTab(tabId)).toBe(false);
    }
  });
});

describe("shouldDeepLinkSourceTab", () => {
  /** INVERTED: Content and an open file (`code:<path>`) used to fall through to
   *  an in-place toggle on the source-less agent. Every view of the surface
   *  travels now. */
  test("deep-links every surface view from off the Report Agent on reports-only", () => {
    for (const tabId of [
      "site-editor",
      "content",
      "code",
      "code:src%2Fapp.tsx",
    ]) {
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
        tabId: "site-editor",
      }),
    ).toBe(false);
  });

  test("does not deep-link for non-reports-only orgs", () => {
    expect(
      shouldDeepLinkSourceTab({
        reportsOnly: false,
        onReportAgent: false,
        tabId: "site-editor",
      }),
    ).toBe(false);
  });

  test("only deep-links the surface tabs, not other tabs", () => {
    for (const tabId of ["settings", "automations", "overview", "assets"]) {
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
