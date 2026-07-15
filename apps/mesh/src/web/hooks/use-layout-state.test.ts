import { describe, expect, test } from "bun:test";
import {
  canCollapsePanel,
  computeWorkspacePanelSizes,
  mobileSurfaceSearch,
  resolveDefaultPanelState,
  resolveMobileSurface,
  resolveSidePanel,
  resolveWorkspacePanelAction,
  resolveWorkspaceVisibility,
} from "./use-layout-state";

describe("resolveDefaultPanelState", () => {
  test("no metadata → main closed, side panel on chat", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: null,
        mainParamPresent: false,
      }),
    ).toEqual({ mainOpen: false, sidePanel: "chat" });
  });

  test("defaultMainView.type='chat' → main closed, side panel on chat", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        mainParamPresent: false,
      }),
    ).toEqual({ mainOpen: false, sidePanel: "chat" });
  });

  test("defaultMainView.type non-chat → main open, side panel collapsed", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "ext-app", id: "x" } },
        mainParamPresent: false,
      }),
    ).toEqual({ mainOpen: true, sidePanel: null });
  });

  test("chatDefaultOpen=true with non-chat default → main open, side panel on chat", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "ext-app", id: "x" },
          chatDefaultOpen: true,
        },
        mainParamPresent: false,
      }),
    ).toEqual({ mainOpen: true, sidePanel: "chat" });
  });

  test("chatDefaultOpen=false is the default behavior (side panel collapsed)", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "layout" },
          chatDefaultOpen: false,
        },
        mainParamPresent: false,
      }),
    ).toEqual({ mainOpen: true, sidePanel: null });
  });

  test("chatDefaultOpen ignored when default is chat (side panel still chat)", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "chat" },
          chatDefaultOpen: false,
        },
        mainParamPresent: false,
      }),
    ).toEqual({ mainOpen: false, sidePanel: "chat" });
  });

  test("?main=0 overrides default and falls back to chat", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "settings" } },
        mainParamPresent: true,
        mainParamValue: 0,
      }),
    ).toEqual({ mainOpen: false, sidePanel: "chat" });
  });

  test("?main=<tabId> opens main even when default is chat", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        mainParamPresent: true,
        mainParamValue: "layout",
      }),
    ).toEqual({ mainOpen: true, sidePanel: "chat" });
  });

  test("legacy ?main=blocks puts Blocks in the side panel, main closed", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: null,
        mainParamPresent: true,
        mainParamValue: "blocks",
      }),
    ).toEqual({ mainOpen: false, sidePanel: "blocks" });
  });

  test("defaultMainView.type='blocks' puts Blocks in the side panel", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "blocks" },
          chatDefaultOpen: true,
        },
        mainParamPresent: false,
      }),
    ).toEqual({ mainOpen: false, sidePanel: "blocks" });
  });
});

describe("resolveSidePanel", () => {
  test("?sidepanel wins over the entity default and over legacy params", () => {
    expect(resolveSidePanel("chat", { sidepanel: "blocks", chat: 1 })).toBe(
      "blocks",
    );
    expect(resolveSidePanel("blocks", { sidepanel: "chat", blocks: 1 })).toBe(
      "chat",
    );
  });

  test("?sidepanel=0 collapses the panel", () => {
    expect(resolveSidePanel("chat", { sidepanel: 0 })).toBeNull();
    expect(resolveSidePanel("blocks", { sidepanel: "0" })).toBeNull();
  });

  test("falls back to the entity default when no param is present", () => {
    expect(resolveSidePanel("blocks", {})).toBe("blocks");
    expect(resolveSidePanel(null, {})).toBeNull();
  });

  test("legacy ?chat=1 / ?blocks=1 select their surface", () => {
    expect(resolveSidePanel(null, { chat: 1 })).toBe("chat");
    expect(resolveSidePanel(null, { blocks: 1 })).toBe("blocks");
  });

  test("legacy ?chat=1&blocks=1 resolves to blocks — the pair is no longer a state", () => {
    expect(resolveSidePanel(null, { chat: 1, blocks: 1 })).toBe("blocks");
  });

  test("legacy ?chat=0 / ?blocks=0 collapse only their own default surface", () => {
    expect(resolveSidePanel("chat", { chat: 0 })).toBeNull();
    expect(resolveSidePanel("blocks", { blocks: 0 })).toBeNull();
    // ?blocks=0 against a chat default says nothing about chat.
    expect(resolveSidePanel("chat", { blocks: 0 })).toBe("chat");
  });
});

describe("resolveWorkspaceVisibility", () => {
  test("legacy ?main=blocks&chat=1 now swaps the side panel to chat", () => {
    const defaults = resolveDefaultPanelState({
      entityMetadata: null,
      mainParamPresent: true,
      mainParamValue: "blocks",
    });

    expect(resolveWorkspaceVisibility(defaults, { chat: 1 })).toEqual({
      sidePanel: "chat",
      mainOpen: false,
    });
  });

  test("legacy ?main=blocks&blocks=0 collapses Blocks and falls back to Chat", () => {
    const defaults = resolveDefaultPanelState({
      entityMetadata: null,
      mainParamPresent: true,
      mainParamValue: "blocks",
    });

    expect(resolveWorkspaceVisibility(defaults, { blocks: 0 })).toEqual({
      sidePanel: "chat",
      mainOpen: false,
    });
  });

  test("?blocks=0 with main open leaves the side panel collapsed", () => {
    const defaults = resolveDefaultPanelState({
      entityMetadata: {
        defaultMainView: { type: "blocks" },
        chatDefaultOpen: true,
      },
      mainParamPresent: true,
      mainParamValue: "settings",
    });

    expect(resolveWorkspaceVisibility(defaults, { blocks: 0 })).toEqual({
      sidePanel: null,
      mainOpen: true,
    });
  });

  test("?blocks=1 opens Blocks without changing the main default", () => {
    const defaults = resolveDefaultPanelState({
      entityMetadata: { defaultMainView: { type: "settings" } },
      mainParamPresent: false,
    });

    expect(resolveWorkspaceVisibility(defaults, { blocks: 1 })).toEqual({
      sidePanel: "blocks",
      mainOpen: true,
    });
  });

  test("an all-closed derived state falls back to chat", () => {
    const defaults = resolveDefaultPanelState({
      entityMetadata: { defaultMainView: { type: "blocks" } },
      mainParamPresent: true,
      mainParamValue: "0",
    });

    expect(resolveWorkspaceVisibility(defaults, { blocks: 0 })).toEqual({
      sidePanel: "chat",
      mainOpen: false,
    });
  });
});

describe("canCollapsePanel", () => {
  test("either panel may collapse while both are open", () => {
    expect(canCollapsePanel({ sidePanel: "chat", mainOpen: true })).toBe(true);
    expect(canCollapsePanel({ sidePanel: "blocks", mainOpen: true })).toBe(
      true,
    );
  });

  test("the last visible panel may not collapse", () => {
    expect(canCollapsePanel({ sidePanel: "chat", mainOpen: false })).toBe(
      false,
    );
    expect(canCollapsePanel({ sidePanel: "blocks", mainOpen: false })).toBe(
      false,
    );
    expect(canCollapsePanel({ sidePanel: null, mainOpen: true })).toBe(false);
  });
});

describe("resolveWorkspacePanelAction", () => {
  test("selecting the other surface swaps the side panel rather than adding one", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "selectSidePanel", tab: "blocks" },
        { sidePanel: "chat", mainOpen: false },
      ),
    ).toEqual({ sidepanel: "blocks", chat: undefined, blocks: undefined });
    expect(
      resolveWorkspacePanelAction(
        { type: "selectSidePanel", tab: "chat" },
        { sidePanel: "blocks", mainOpen: true },
      ),
    ).toEqual({ sidepanel: "chat", chat: undefined, blocks: undefined });
  });

  test("selecting the active surface collapses the panel when main can carry it", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "selectSidePanel", tab: "chat" },
        { sidePanel: "chat", mainOpen: true },
      ),
    ).toEqual({ sidepanel: 0, chat: undefined, blocks: undefined });
  });

  test("selecting the active surface refuses to collapse the last panel", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "selectSidePanel", tab: "chat" },
        { sidePanel: "chat", mainOpen: false },
      ),
    ).toBeNull();
    expect(
      resolveWorkspacePanelAction(
        { type: "selectSidePanel", tab: "blocks" },
        { sidePanel: "blocks", mainOpen: false },
      ),
    ).toBeNull();
  });

  test("selecting a collapsed panel's surface reopens it", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "selectSidePanel", tab: "blocks" },
        { sidePanel: null, mainOpen: true },
      ),
    ).toEqual({ sidepanel: "blocks", chat: undefined, blocks: undefined });
  });

  test("toggleMain opens and closes Main with minimal updates", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleMain", openMainValue: "preview" },
        { sidePanel: "chat", mainOpen: false },
      ),
    ).toEqual({ main: "preview" });
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleMain", openMainValue: "preview" },
        { sidePanel: "blocks", mainOpen: true },
      ),
    ).toEqual({ main: 0 });
  });

  test("toggleMain refuses to close the last visible panel", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleMain", openMainValue: "settings" },
        { sidePanel: null, mainOpen: true },
      ),
    ).toBeNull();
  });

  test("openChat is idempotent and only writes the side panel", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "openChat" },
        { sidePanel: "chat", mainOpen: true },
      ),
    ).toBeNull();
    expect(
      resolveWorkspacePanelAction(
        { type: "openChat" },
        { sidePanel: "blocks", mainOpen: false },
      ),
    ).toEqual({ sidepanel: "chat", chat: undefined, blocks: undefined });
  });
});

describe("computeWorkspacePanelSizes", () => {
  test.each([
    [
      { sidePanel: "chat", mainOpen: false } as const,
      { sidePanel: 100, main: 0 },
    ],
    [
      { sidePanel: "blocks", mainOpen: false } as const,
      { sidePanel: 100, main: 0 },
    ],
    [{ sidePanel: null, mainOpen: true } as const, { sidePanel: 0, main: 100 }],
    [
      { sidePanel: "chat", mainOpen: true } as const,
      { sidePanel: 33, main: 67 },
    ],
    // Blocks is a 240px list plus a props editor, so it takes half.
    [
      { sidePanel: "blocks", mainOpen: true } as const,
      { sidePanel: 50, main: 50 },
    ],
  ])("computes workspace sizes", (visibility, expected) => {
    expect(computeWorkspacePanelSizes(visibility)).toEqual(expected);
  });
});

describe("mobileSurfaceSearch", () => {
  test("selects exactly one mobile surface and retires legacy params", () => {
    expect(mobileSurfaceSearch("chat", "preview")).toEqual({
      sidepanel: "chat",
      main: 0,
      chat: undefined,
      blocks: undefined,
    });
    expect(mobileSurfaceSearch("blocks", "preview")).toEqual({
      sidepanel: "blocks",
      main: 0,
      chat: undefined,
      blocks: undefined,
    });
    expect(mobileSurfaceSearch("main", "preview")).toEqual({
      sidepanel: 0,
      main: "preview",
      chat: undefined,
      blocks: undefined,
    });
  });
});

describe("resolveMobileSurface", () => {
  test("shows the side surface when main is closed", () => {
    expect(resolveMobileSurface({ sidePanel: "chat", mainOpen: false })).toBe(
      "chat",
    );
    expect(resolveMobileSurface({ sidePanel: "blocks", mainOpen: false })).toBe(
      "blocks",
    );
  });

  test("blocks keeps precedence over main, matching the desktop-shaped URL", () => {
    expect(resolveMobileSurface({ sidePanel: "blocks", mainOpen: true })).toBe(
      "blocks",
    );
  });

  test("main wins over chat, and a collapsed side panel falls back to chat", () => {
    expect(resolveMobileSurface({ sidePanel: "chat", mainOpen: true })).toBe(
      "main",
    );
    expect(resolveMobileSurface({ sidePanel: null, mainOpen: true })).toBe(
      "main",
    );
    expect(resolveMobileSurface({ sidePanel: null, mainOpen: false })).toBe(
      "chat",
    );
  });
});
