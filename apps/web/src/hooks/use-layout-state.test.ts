import { describe, expect, test } from "bun:test";
import {
  canCloseWorkspacePanel,
  computeWorkspacePanelSizes,
  mobileSurfaceSearch,
  resolveDefaultPanelState,
  resolveMobileSurface,
  resolveWorkspacePanelAction,
} from "./use-layout-state";

describe("resolveDefaultPanelState", () => {
  const absentSearch = {
    mainParamPresent: false,
    sidePanelParamPresent: false,
  };

  test("defaults to Chat when no layout metadata exists", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: null,
        ...absentSearch,
      }),
    ).toEqual({ sidePanel: "chat", mainOpen: false });
  });

  describe("CMS projects", () => {
    const cms = { defaultSidePanelKind: "cms" } as const;

    test("a chat default resolves to the CMS panel — there is no chat here", () => {
      expect(
        resolveDefaultPanelState({
          entityMetadata: { defaultMainView: { type: "chat" } },
          ...absentSearch,
          ...cms,
        }),
      ).toEqual({ sidePanel: "cms", mainOpen: false });
    });

    test("chatDefaultOpen alongside a non-chat view opens CMS, not chat", () => {
      expect(
        resolveDefaultPanelState({
          entityMetadata: {
            defaultMainView: { type: "preview" },
            chatDefaultOpen: true,
          },
          ...absentSearch,
          ...cms,
        }),
      ).toEqual({ sidePanel: "cms", mainOpen: true });
    });

    test("closing everything falls back to CMS, never to an absent chat", () => {
      expect(
        resolveDefaultPanelState({
          entityMetadata: { defaultMainView: { type: "settings" } },
          mainParamPresent: true,
          mainParamValue: 0,
          sidePanelParamPresent: true,
          sidePanelParamValue: 0,
          ...cms,
        }),
      ).toEqual({ sidePanel: "cms", mainOpen: false });
    });

    test("?sidepanel=cms is honoured", () => {
      expect(
        resolveDefaultPanelState({
          entityMetadata: null,
          mainParamPresent: false,
          sidePanelParamPresent: true,
          sidePanelParamValue: "cms",
          ...cms,
        }),
      ).toEqual({ sidePanel: "cms", mainOpen: false });
    });

    test("an unknown ?sidepanel degrades to the project default", () => {
      expect(
        resolveDefaultPanelState({
          entityMetadata: null,
          mainParamPresent: false,
          sidePanelParamPresent: true,
          sidePanelParamValue: "junk" as unknown as Parameters<
            typeof resolveDefaultPanelState
          >[0]["sidePanelParamValue"],
          ...cms,
        }),
      ).toEqual({ sidePanel: "cms", mainOpen: false });
    });
  });

  test("a Chat default opens Chat and closes Main", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        ...absentSearch,
      }),
    ).toEqual({ sidePanel: "chat", mainOpen: false });
  });

  test("a non-Chat default opens Main without a side panel", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "settings" } },
        ...absentSearch,
      }),
    ).toEqual({ sidePanel: null, mainOpen: true });
  });

  test("a Content default with chatDefaultOpen:false keeps the chat closed", () => {
    // The reported bug: an agent whose main view is Content and that opted out
    // of the chat panel must land Main-only when no `sidepanel` param is present
    // (the switch/new-chat paths now omit it — see resolve-task-switch-search).
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "content" },
          chatDefaultOpen: false,
        },
        ...absentSearch,
      }),
    ).toEqual({ sidePanel: null, mainOpen: true });
  });

  test("chatDefaultOpen maps to the Chat side panel", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "overview" },
          chatDefaultOpen: true,
        },
        ...absentSearch,
      }),
    ).toEqual({ sidePanel: "chat", mainOpen: true });
  });

  test("an explicit side panel overrides the configured side-panel default", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "overview" },
          chatDefaultOpen: false,
        },
        mainParamPresent: false,
        sidePanelParamPresent: true,
        sidePanelParamValue: "chat",
      }),
    ).toEqual({ sidePanel: "chat", mainOpen: true });
  });

  test("sidepanel=0 keeps a non-Chat default Main-only", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "settings" },
          chatDefaultOpen: true,
        },
        mainParamPresent: false,
        sidePanelParamPresent: true,
        sidePanelParamValue: 0,
      }),
    ).toEqual({ sidePanel: null, mainOpen: true });
  });

  test("main=<tab> opens Main alongside a Chat default", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        mainParamPresent: true,
        mainParamValue: "settings",
        sidePanelParamPresent: false,
      }),
    ).toEqual({ sidePanel: "chat", mainOpen: true });
  });

  test("an all-closed state falls back to Chat", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "settings" } },
        mainParamPresent: true,
        mainParamValue: 0,
        sidePanelParamPresent: true,
        sidePanelParamValue: 0,
      }),
    ).toEqual({ sidePanel: "chat", mainOpen: false });
  });
});

describe("canCloseWorkspacePanel", () => {
  test("allows closing either panel when both are open", () => {
    const visibility = { sidePanel: "chat" as const, mainOpen: true };
    expect(canCloseWorkspacePanel("side", visibility)).toBe(true);
    expect(canCloseWorkspacePanel("main", visibility)).toBe(true);
  });

  test("does not allow closing the final open panel", () => {
    expect(
      canCloseWorkspacePanel("side", {
        sidePanel: "chat",
        mainOpen: false,
      }),
    ).toBe(false);
    expect(
      canCloseWorkspacePanel("main", { sidePanel: null, mainOpen: true }),
    ).toBe(false);
  });
});

describe("resolveWorkspacePanelAction", () => {
  test("opens Chat when only Main is visible", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleSidePanel", sidePanel: "chat" },
        { sidePanel: null, mainOpen: true },
      ),
    ).toEqual({ sidepanel: "chat" });
  });

  test("closes the active side panel when Main remains open", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleSidePanel", sidePanel: "chat" },
        { sidePanel: "chat", mainOpen: true },
      ),
    ).toEqual({ sidepanel: 0 });
  });

  test("refuses to close the active side panel when it is the final panel", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleSidePanel", sidePanel: "chat" },
        { sidePanel: "chat", mainOpen: false },
      ),
    ).toBeNull();
  });

  test("opens and closes Main with the final-panel guard", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleMain", openMainValue: "preview" },
        { sidePanel: "chat", mainOpen: false },
      ),
    ).toEqual({ main: "preview" });
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleMain", openMainValue: "preview" },
        { sidePanel: "chat", mainOpen: true },
      ),
    ).toEqual({ main: 0 });
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleMain", openMainValue: "preview" },
        { sidePanel: null, mainOpen: true },
      ),
    ).toBeNull();
  });

  test("openSidePanel is idempotent and opens Chat when it is closed", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "openSidePanel", sidePanel: "chat" },
        { sidePanel: "chat", mainOpen: true },
      ),
    ).toBeNull();
    expect(
      resolveWorkspacePanelAction(
        { type: "openSidePanel", sidePanel: "chat" },
        { sidePanel: null, mainOpen: true },
      ),
    ).toEqual({ sidepanel: "chat" });
  });
});

describe("computeWorkspacePanelSizes", () => {
  test.each([
    [
      { sidePanel: "chat" as const, mainOpen: false },
      { side: 100, main: 0 },
    ],
    [
      { sidePanel: "chat" as const, mainOpen: true },
      { side: 33, main: 67 },
    ],
    [
      { sidePanel: null, mainOpen: true },
      { side: 0, main: 100 },
    ],
  ])("computes the two-panel workspace sizes", (visibility, expected) => {
    expect(computeWorkspacePanelSizes(visibility)).toEqual(expected);
  });
});

describe("mobileSurfaceSearch", () => {
  test("selects exactly one mobile surface", () => {
    expect(mobileSurfaceSearch("chat", "preview")).toEqual({
      sidepanel: "chat",
      main: 0,
    });
    expect(mobileSurfaceSearch("main", "preview")).toEqual({
      sidepanel: 0,
      main: "preview",
    });
  });
});

describe("resolveMobileSurface", () => {
  test("an explicit ?sidepanel=chat wins over an open main panel", () => {
    expect(
      resolveMobileSurface({
        visibility: { sidePanel: "chat", mainOpen: true },
        sidePanelParamPresent: true,
      }),
    ).toBe("chat");
  });

  test("the default main view still wins when ?sidepanel is absent", () => {
    expect(
      resolveMobileSurface({
        visibility: { sidePanel: "chat", mainOpen: true },
        sidePanelParamPresent: false,
      }),
    ).toBe("main");
  });

  test("falls back to main / chat when only one panel is open", () => {
    expect(
      resolveMobileSurface({
        visibility: { sidePanel: null, mainOpen: true },
        sidePanelParamPresent: true,
      }),
    ).toBe("main");
    expect(
      resolveMobileSurface({
        visibility: { sidePanel: "chat", mainOpen: false },
        sidePanelParamPresent: false,
      }),
    ).toBe("chat");
  });
});
