import { describe, expect, test } from "bun:test";
import {
  FIXED_SYSTEM_TABS,
  formatCodeTabId,
  formatDeckTabId,
  formatFileTabId,
  formatLibraryFileTabId,
  parseCodeTabId,
  isLegacySettingsTab,
  isPerThreadTab,
  parseAutomationTabId,
  parseDeckTabId,
  parseFileTabId,
  parseLibraryFileTabId,
  resolveDefaultTabId,
  resolveActiveTabAndOpen,
  resolveTabClickTarget,
  isAutomationsPillActive,
  resolveAutomationsPillClickTarget,
} from "./tab-id";

describe("parseAutomationTabId", () => {
  test("automation:<uuid> → { id }", () => {
    expect(parseAutomationTabId("automation:abc-123")).toEqual({
      id: "abc-123",
    });
  });

  test("non-automation tab → null", () => {
    expect(parseAutomationTabId("settings")).toBeNull();
    expect(parseAutomationTabId("preview")).toBeNull();
    expect(parseAutomationTabId(undefined)).toBeNull();
    expect(parseAutomationTabId("0")).toBeNull();
  });

  test("automation: with empty id → null", () => {
    expect(parseAutomationTabId("automation:")).toBeNull();
  });
});

describe("file tab id", () => {
  test("round-trips S3 and org-fs keys (slashes, colons, spaces)", () => {
    for (const key of [
      "model-outputs/thread-1/report final.pdf",
      "org-fs:outputs/thread-1/nested/dir/data.csv",
      "model-outputs/t/weird?#&name.txt",
    ]) {
      expect(parseFileTabId(formatFileTabId(key))).toEqual({ key });
    }
  });

  test("non-file tab → null", () => {
    expect(parseFileTabId("settings")).toBeNull();
    expect(parseFileTabId("web-page:home")).toBeNull();
    expect(parseFileTabId(undefined)).toBeNull();
    expect(parseFileTabId("file:")).toBeNull();
  });

  test("malformed percent-encoding → null, not a throw", () => {
    expect(parseFileTabId("file:%E0%A4%A")).toBeNull();
  });

  test("file tabs are per-thread", () => {
    expect(isPerThreadTab(formatFileTabId("model-outputs/t/a.pdf"))).toBe(true);
    expect(isPerThreadTab("settings")).toBe(false);
  });
});

describe("deck tab id", () => {
  test("round-trips home-volume deck paths", () => {
    for (const path of ["decks/q3-launch.html", "decks/My.Deck_2.html"]) {
      expect(parseDeckTabId(formatDeckTabId(path))).toEqual({ path });
    }
  });

  test("non-deck tab → null", () => {
    expect(parseDeckTabId("settings")).toBeNull();
    expect(parseDeckTabId("file:decks%2Fa.html")).toBeNull();
    expect(parseDeckTabId(undefined)).toBeNull();
    expect(parseDeckTabId("deck:")).toBeNull();
  });

  test("malformed percent-encoding → null, not a throw", () => {
    expect(parseDeckTabId("deck:%E0%A4%A")).toBeNull();
  });

  test("deck tabs are per-thread", () => {
    expect(isPerThreadTab(formatDeckTabId("decks/a.html"))).toBe(true);
  });
});

describe("library file tab id", () => {
  test("round-trips Library browse paths (home + public sets)", () => {
    for (const path of [
      "home/docs/spec final.md",
      "public/core/skills/a.ts",
      "uploads/My.File_2.csv",
    ]) {
      expect(parseLibraryFileTabId(formatLibraryFileTabId(path))).toEqual({
        path,
      });
    }
  });

  test("non-library-file tab → null", () => {
    expect(parseLibraryFileTabId("settings")).toBeNull();
    expect(parseLibraryFileTabId("file:home%2Fa.md")).toBeNull();
    expect(parseLibraryFileTabId("deck:decks%2Fa.html")).toBeNull();
    expect(parseLibraryFileTabId(undefined)).toBeNull();
    expect(parseLibraryFileTabId("library-file:")).toBeNull();
  });

  test("malformed percent-encoding → null, not a throw", () => {
    expect(parseLibraryFileTabId("library-file:%E0%A4%A")).toBeNull();
  });

  test("library file tabs are per-thread", () => {
    expect(isPerThreadTab(formatLibraryFileTabId("home/a.md"))).toBe(true);
  });
});

describe("isLegacySettingsTab", () => {
  test("legacy tab ids → true", () => {
    expect(isLegacySettingsTab("instructions")).toBe(true);
    expect(isLegacySettingsTab("connections")).toBe(true);
    expect(isLegacySettingsTab("layout")).toBe(true);
    expect(isLegacySettingsTab("settings")).toBe(true);
  });

  test("non-legacy tab ids → false", () => {
    expect(isLegacySettingsTab("automations")).toBe(false);
    expect(isLegacySettingsTab("preview")).toBe(false);
    expect(isLegacySettingsTab("git")).toBe(false);
    expect(isLegacySettingsTab(undefined)).toBe(false);
  });
});

describe("resolveDefaultTabId", () => {
  test("null metadata → 'settings'", () => {
    expect(resolveDefaultTabId(null)).toBe("settings");
  });

  test("defaultMainView null → 'settings'", () => {
    expect(resolveDefaultTabId({ defaultMainView: null })).toBe("settings");
  });

  test("ext-app with id → id", () => {
    expect(
      resolveDefaultTabId({
        defaultMainView: { type: "ext-app", id: "analytics" },
        tabs: [{ id: "analytics" }],
      }),
    ).toBe("analytics");
  });

  test("ext-app no id → first declared tab id", () => {
    expect(
      resolveDefaultTabId({
        defaultMainView: { type: "ext-app" },
        tabs: [{ id: "t1" }, { id: "t2" }],
      }),
    ).toBe("t1");
  });

  test("ext-app id not in declared tabs → first declared tab id", () => {
    expect(
      resolveDefaultTabId({
        defaultMainView: { type: "ext-app", id: "stale" },
        tabs: [{ id: "t1" }, { id: "t2" }],
      }),
    ).toBe("t1");
  });

  test("ext-app id not in declared tabs and no tabs → 'settings'", () => {
    expect(
      resolveDefaultTabId({
        defaultMainView: { type: "ext-app", id: "stale" },
        tabs: [],
      }),
    ).toBe("settings");
  });

  test("ext-apps with id + toolName → pinned-view tab id", () => {
    expect(
      resolveDefaultTabId({
        defaultMainView: {
          type: "ext-apps",
          id: "conn-abc",
          toolName: "hello_world",
        },
        tabs: [],
      }),
    ).toBe("app:conn-abc:hello_world");
  });

  test("legacy instructions → 'settings'", () => {
    expect(
      resolveDefaultTabId({ defaultMainView: { type: "instructions" } }),
    ).toBe("settings");
  });

  test("legacy connections → 'settings'", () => {
    expect(
      resolveDefaultTabId({ defaultMainView: { type: "connections" } }),
    ).toBe("settings");
  });

  test("legacy layout → 'settings'", () => {
    expect(resolveDefaultTabId({ defaultMainView: { type: "layout" } })).toBe(
      "settings",
    );
  });

  test("preview → 'preview'", () => {
    expect(resolveDefaultTabId({ defaultMainView: { type: "preview" } })).toBe(
      "preview",
    );
  });

  test("git → 'git'", () => {
    expect(resolveDefaultTabId({ defaultMainView: { type: "git" } })).toBe(
      "git",
    );
  });

  test("content → 'content'", () => {
    expect(resolveDefaultTabId({ defaultMainView: { type: "content" } })).toBe(
      "content",
    );
  });

  test("unknown type falls back to 'settings'", () => {
    expect(
      resolveDefaultTabId({ defaultMainView: { type: "automation" } }),
    ).toBe("settings");
  });
});

describe("resolveActiveTabAndOpen", () => {
  const meta = {
    defaultMainView: { type: "ext-app", id: "analytics" },
    tabs: [{ id: "analytics" }],
  };

  test("?main absent + defaultMainView set → open, tab = default", () => {
    expect(
      resolveActiveTabAndOpen({ mainParam: undefined, metadata: meta }),
    ).toEqual({ mainOpen: true, activeTab: "analytics" });
  });

  test("?main absent + no defaultMainView → closed, tab = 'settings'", () => {
    expect(
      resolveActiveTabAndOpen({ mainParam: undefined, metadata: null }),
    ).toEqual({ mainOpen: false, activeTab: "settings" });
  });

  test("?main absent + defaultMainView.type === 'chat' → closed (aligns with resolveDefaultPanelState)", () => {
    expect(
      resolveActiveTabAndOpen({
        mainParam: undefined,
        metadata: { defaultMainView: { type: "chat" } },
      }),
    ).toEqual({ mainOpen: false, activeTab: "settings" });
  });

  test("?main=0 → closed, tab = default", () => {
    expect(resolveActiveTabAndOpen({ mainParam: 0, metadata: meta })).toEqual({
      mainOpen: false,
      activeTab: "analytics",
    });
  });

  test("?main=settings → open, tab = 'settings'", () => {
    expect(
      resolveActiveTabAndOpen({ mainParam: "settings", metadata: meta }),
    ).toEqual({ mainOpen: true, activeTab: "settings" });
  });

  test("?main=instructions (legacy) → open, tab = 'settings'", () => {
    expect(
      resolveActiveTabAndOpen({ mainParam: "instructions", metadata: meta }),
    ).toEqual({ mainOpen: true, activeTab: "settings" });
  });

  test("?main=connections (legacy) → open, tab = 'settings'", () => {
    expect(
      resolveActiveTabAndOpen({ mainParam: "connections", metadata: meta }),
    ).toEqual({ mainOpen: true, activeTab: "settings" });
  });

  test("?main=layout (legacy) → open, tab = 'settings'", () => {
    expect(
      resolveActiveTabAndOpen({ mainParam: "layout", metadata: meta }),
    ).toEqual({ mainOpen: true, activeTab: "settings" });
  });

  test("?main=automation:abc → open, tab = 'automation:abc'", () => {
    expect(
      resolveActiveTabAndOpen({
        mainParam: "automation:abc",
        metadata: meta,
      }),
    ).toEqual({ mainOpen: true, activeTab: "automation:abc" });
  });

  test("?main=git → open, tab = 'git'", () => {
    expect(
      resolveActiveTabAndOpen({ mainParam: "git", metadata: meta }),
    ).toEqual({ mainOpen: true, activeTab: "git" });
  });
});

describe("resolveTabClickTarget", () => {
  test("clicking active tab while panel open → close (0)", () => {
    expect(
      resolveTabClickTarget({
        clickedId: "settings",
        activeTab: "settings",
        mainOpen: true,
      }),
    ).toBe(0);
  });

  test("clicking non-active tab while panel open → clicked id", () => {
    expect(
      resolveTabClickTarget({
        clickedId: "preview",
        activeTab: "settings",
        mainOpen: true,
      }),
    ).toBe("preview");
  });

  test("clicking any tab while panel closed → clicked id (open it)", () => {
    expect(
      resolveTabClickTarget({
        clickedId: "settings",
        activeTab: "settings",
        mainOpen: false,
      }),
    ).toBe("settings");
    expect(
      resolveTabClickTarget({
        clickedId: "preview",
        activeTab: "settings",
        mainOpen: false,
      }),
    ).toBe("preview");
  });
});

describe("isAutomationsPillActive", () => {
  test("activeTab='automations' and panel open → true", () => {
    expect(
      isAutomationsPillActive({ activeTab: "automations", mainOpen: true }),
    ).toBe(true);
  });

  test("activeTab='automation:abc' and panel open → true", () => {
    expect(
      isAutomationsPillActive({ activeTab: "automation:abc", mainOpen: true }),
    ).toBe(true);
  });

  test("activeTab='automation:new' and panel open → true", () => {
    expect(
      isAutomationsPillActive({ activeTab: "automation:new", mainOpen: true }),
    ).toBe(true);
  });

  test("panel closed → false even when activeTab matches", () => {
    expect(
      isAutomationsPillActive({ activeTab: "automations", mainOpen: false }),
    ).toBe(false);
    expect(
      isAutomationsPillActive({ activeTab: "automation:abc", mainOpen: false }),
    ).toBe(false);
  });

  test("non-automation tab → false", () => {
    expect(
      isAutomationsPillActive({ activeTab: "settings", mainOpen: true }),
    ).toBe(false);
    expect(
      isAutomationsPillActive({ activeTab: "preview", mainOpen: true }),
    ).toBe(false);
  });
});

describe("resolveAutomationsPillClickTarget", () => {
  test("panel closed → open the list", () => {
    expect(
      resolveAutomationsPillClickTarget({
        activeTab: "automations",
        mainOpen: false,
      }),
    ).toBe("automations");
  });

  test("on detail (automation:<id>) → navigate up to list", () => {
    expect(
      resolveAutomationsPillClickTarget({
        activeTab: "automation:abc",
        mainOpen: true,
      }),
    ).toBe("automations");
  });

  test("on detail (automation:new) → navigate up to list", () => {
    expect(
      resolveAutomationsPillClickTarget({
        activeTab: "automation:new",
        mainOpen: true,
      }),
    ).toBe("automations");
  });

  test("on list while panel open → close (0)", () => {
    expect(
      resolveAutomationsPillClickTarget({
        activeTab: "automations",
        mainOpen: true,
      }),
    ).toBe(0);
  });

  test("on unrelated tab → open list", () => {
    expect(
      resolveAutomationsPillClickTarget({
        activeTab: "settings",
        mainOpen: true,
      }),
    ).toBe("automations");
  });
});

describe("code tab id", () => {
  test("keeps Blocks out of the fixed system tabs", () => {
    expect(FIXED_SYSTEM_TABS).not.toContain("blocks");
    expect(FIXED_SYSTEM_TABS).toContain("code");
  });

  test("parses the bare code id as a null path", () => {
    expect(parseCodeTabId("code")).toEqual({ path: null });
  });

  test("round-trips a code path with slashes", () => {
    const id = formatCodeTabId(".deco/blocks/pages-Home.json");
    expect(id).toBe("code:.deco%2Fblocks%2Fpages-Home.json");
    expect(parseCodeTabId(id)).toEqual({
      path: ".deco/blocks/pages-Home.json",
    });
  });

  test("returns null for non-code ids", () => {
    expect(parseCodeTabId("preview")).toBeNull();
    expect(parseCodeTabId(undefined)).toBeNull();
    expect(parseCodeTabId("codex")).toBeNull();
  });

  test("an open code path is per-thread (scoped to the task's sandbox/branch), but the bare tab is not", () => {
    expect(isPerThreadTab(formatCodeTabId("src/index.ts"))).toBe(true);
    expect(isPerThreadTab("code")).toBe(false);
  });
});
