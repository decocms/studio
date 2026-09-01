import { describe, expect, test } from "bun:test";
import {
  isKnownPanelSegment,
  PANEL_PAYLOAD_KEYS,
  panelLocationForTab,
  resolveChatSegments,
  tabIdForPanel,
} from "./panel-route";
import {
  FIXED_SYSTEM_TABS,
  GATED_CONTROL_PLANE_TABS,
  formatCodeTabId,
  formatDeckTabId,
  formatFileTabId,
  formatLibraryFileTabId,
  formatPinnedViewTabId,
} from "./tab-id";

/** Every tab id the app can write, one per kind of the grammar. */
const EVERY_TAB_ID = [
  ...FIXED_SYSTEM_TABS,
  "board",
  "files",
  "reports",
  "connect-sources",
  "analytics",
  "automations",
  "automation:auto-1",
  "automation:new",
  formatPinnedViewTabId("conn_1", "get_orders"),
  formatFileTabId("org-fs:outputs/thread-1/report final.pdf"),
  formatDeckTabId("decks/q3 launch.html"),
  formatLibraryFileTabId("home/docs/spec final.md"),
  formatCodeTabId(".deco/blocks/pages-Home.json"),
];

describe("panel round trip", () => {
  test("every segment the app writes reads back as the same tab", () => {
    for (const tabId of EVERY_TAB_ID) {
      const { panel, payload } = panelLocationForTab(tabId);
      expect(tabIdForPanel(panel, payload)).toBe(tabId);
    }
  });

  test("a segment never carries a slash or a colon", () => {
    for (const tabId of EVERY_TAB_ID) {
      const { panel } = panelLocationForTab(tabId);
      expect(panel).toBeString();
      expect(panel).not.toInclude("/");
      expect(panel).not.toInclude(":");
    }
  });

  test("a payload names only its own kind's keys, clearing the rest", () => {
    for (const tabId of EVERY_TAB_ID) {
      const { payload } = panelLocationForTab(tabId);
      expect(Object.keys(payload).sort()).toEqual(
        [...PANEL_PAYLOAD_KEYS].sort(),
      );
    }
  });

  test("the three merged settings tabs share one address", () => {
    for (const legacy of ["instructions", "connections", "layout"]) {
      expect(panelLocationForTab(legacy).panel).toBe("settings");
    }
  });

  test("payload-carrying kinds put the kind in the path", () => {
    expect(
      panelLocationForTab(formatPinnedViewTabId("conn_1", "get_orders")),
    ).toMatchObject({
      panel: "app",
      payload: { connection: "conn_1", tool: "get_orders" },
    });
    expect(panelLocationForTab("automation:auto-1")).toMatchObject({
      panel: "automations",
      payload: { automation: "auto-1" },
    });
    expect(panelLocationForTab(formatCodeTabId("src/app.tsx"))).toMatchObject({
      panel: "code",
      payload: { file: "src/app.tsx" },
    });
  });

  test("no panel → no view named", () => {
    expect(tabIdForPanel(undefined, {})).toBeUndefined();
  });

  test("a kind with no payload names no view, except code and automations", () => {
    expect(tabIdForPanel("app", {})).toBeUndefined();
    expect(tabIdForPanel("file", {})).toBeUndefined();
    expect(tabIdForPanel("deck", {})).toBeUndefined();
    expect(tabIdForPanel("library-file", {})).toBeUndefined();
    expect(tabIdForPanel("code", {})).toBe("code");
    expect(tabIdForPanel("automations", {})).toBe("automations");
  });

  test("an agent-declared tab id passes through unchanged", () => {
    expect(panelLocationForTab("analytics").panel).toBe("analytics");
    expect(tabIdForPanel("analytics", {})).toBe("analytics");
  });
});

describe("resolveChatSegments", () => {
  /**
   * The coupling that makes a lone `/agents/<view>` readable at all: every
   * segment `panelLocationForTab` can write for the fixed vocabulary must be in
   * the known-segment set, or `resolveChatSegments` hands that view's name to
   * the agent lookup as a project id. Agent-declared ids are excluded on
   * purpose — they come from a project's metadata, so their URL names the
   * project too.
   */
  test("every fixed segment the app writes is recoverable as a lone one", () => {
    for (const tabId of EVERY_TAB_ID) {
      // Gated per-site tabs (hosting/e2e/analytics/cdn) are deliberately NOT
      // lone-recoverable — they always carry a project — so they are excluded
      // from the known-segment set. See the gated-tab test below.
      if (GATED_CONTROL_PLANE_TABS.has(tabId)) continue;
      const { panel } = panelLocationForTab(tabId);
      expect({ tabId, known: isKnownPanelSegment(panel) }).toEqual({
        tabId,
        known: true,
      });
    }
  });

  test("a lone panel word is the panel, not the project", () => {
    expect(resolveChatSegments({ project: "preview" })).toEqual({
      project: undefined,
      panel: "preview",
    });
    expect(resolveChatSegments({ project: "library-file" })).toEqual({
      project: undefined,
      panel: "library-file",
    });
  });

  test("a lone project id stays the project", () => {
    expect(resolveChatSegments({ project: "vir_1" })).toEqual({
      project: "vir_1",
      panel: undefined,
    });
    expect(resolveChatSegments({ project: "decopilot_org_1" })).toEqual({
      project: "decopilot_org_1",
      panel: undefined,
    });
  });

  test("both segments present are taken as written", () => {
    expect(resolveChatSegments({ project: "vir_1", panel: "preview" })).toEqual(
      {
        project: "vir_1",
        panel: "preview",
      },
    );
  });

  test("neither segment → all projects, no view", () => {
    expect(resolveChatSegments({})).toEqual({
      project: undefined,
      panel: undefined,
    });
  });

  test("an agent-declared tab id is not a lone panel word", () => {
    // A custom, project-declared view id is never a lone panel word — it always
    // names the project too, so a bare segment resolves to a project.
    expect(isKnownPanelSegment("my-custom-view")).toBe(false);
    expect(resolveChatSegments({ project: "my-custom-view" })).toEqual({
      project: "my-custom-view",
      panel: undefined,
    });
  });

  test("GATED_CONTROL_PLANE_TABS is a subset of FIXED_SYSTEM_TABS", () => {
    // The two must stay in sync: KNOWN_PANEL_SEGMENTS excludes the gated set from
    // the fixed set, so a gated id that isn't actually a fixed system tab (or a
    // new fixed tab that should be gated but isn't added here) would silently
    // regress the lone-segment project-resolution fix.
    const fixed = new Set<string>(FIXED_SYSTEM_TABS);
    for (const tab of GATED_CONTROL_PLANE_TABS) {
      expect({ tab, inFixed: fixed.has(tab) }).toEqual({ tab, inFixed: true });
    }
  });

  test("a gated control-plane tab id is not a lone panel word", () => {
    // Hosting/E2E/Analytics/Monitor are per-site, org-gated tabs that only ever
    // appear with a project — they must stay OUT of the known-panel-segment set
    // so a project whose slug is one of these words is still navigable.
    for (const tab of ["hosting", "e2e", "analytics", "cdn"]) {
      expect(isKnownPanelSegment(tab)).toBe(false);
      expect(resolveChatSegments({ project: tab })).toEqual({
        project: tab,
        panel: undefined,
      });
    }
  });
});
