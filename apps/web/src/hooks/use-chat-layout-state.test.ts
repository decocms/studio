import { describe, expect, test } from "bun:test";
import {
  computeChatLayoutPanelSizes,
  mobileSurfaceSearch,
  resolveDefaultPanelState,
  resolveMobileSurface,
  resolveChatLayoutPanelAction,
} from "./use-chat-layout-state";

describe("resolveDefaultPanelState", () => {
  const absentSearch = {
    panelNamed: false,
    threadVisibilityExplicit: false,
  };

  test("defaults to Chat when no layout metadata exists", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: null,
        ...absentSearch,
      }),
    ).toEqual({ threadOpen: true, contentOpen: false });
  });

  test("a Chat default opens Chat and closes Main", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        ...absentSearch,
      }),
    ).toEqual({ threadOpen: true, contentOpen: false });
  });

  test("a non-Chat default opens Main without a side panel", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "settings" } },
        ...absentSearch,
      }),
    ).toEqual({ threadOpen: false, contentOpen: true });
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
    ).toEqual({ threadOpen: false, contentOpen: true });
  });

  test("a thread that already has messages opens the chat despite chatDefaultOpen:false", () => {
    // Returning to a chat you've talked in reopens it even when the agent opts out of the chat panel.
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "content" },
          chatDefaultOpen: false,
        },
        ...absentSearch,
        threadHasMessages: true,
      }),
    ).toEqual({ threadOpen: true, contentOpen: true });
  });

  test("an empty thread keeps a chatDefaultOpen:false agent chat closed", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "content" },
          chatDefaultOpen: false,
        },
        ...absentSearch,
        threadHasMessages: false,
      }),
    ).toEqual({ threadOpen: false, contentOpen: true });
  });

  test("an explicit sidepanel=false still hides the chat even with messages", () => {
    // The user's URL param beats the messages-present default.
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "content" },
          chatDefaultOpen: false,
        },
        panelNamed: false,
        threadVisibilityExplicit: true,
        sidePanelParamValue: false,
        threadHasMessages: true,
      }),
    ).toEqual({ threadOpen: false, contentOpen: true });
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
    ).toEqual({ threadOpen: true, contentOpen: true });
  });

  test("an explicit side panel overrides the configured side-panel default", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "overview" },
          chatDefaultOpen: false,
        },
        panelNamed: false,
        threadVisibilityExplicit: true,
        sidePanelParamValue: true,
      }),
    ).toEqual({ threadOpen: true, contentOpen: true });
  });

  test("sidepanel=false keeps a non-Chat default Main-only", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "settings" },
          chatDefaultOpen: true,
        },
        panelNamed: false,
        threadVisibilityExplicit: true,
        sidePanelParamValue: false,
      }),
    ).toEqual({ threadOpen: false, contentOpen: true });
  });

  /**
   * INVERTED: a destination route used to open its main view AND the chat
   * beside it. Going to Tasks now shows Tasks alone — a route that names its
   * own `defaultMain` collapses the side panel, and `/$org/agents` gets its open
   * panel for free by declaring no `defaultMain` at all.
   */
  test("a route default opens Main alone, collapsing the chat", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        ...absentSearch,
        routeDefaultMain: "board",
      }),
    ).toEqual({ threadOpen: false, contentOpen: true });
  });

  test("an explicit sidepanel=true reopens the chat on a route default", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        panelNamed: false,
        threadVisibilityExplicit: true,
        sidePanelParamValue: true,
        routeDefaultMain: "board",
      }),
    ).toEqual({ threadOpen: true, contentOpen: true });
  });

  test("?mainpanel=false on a route default leaves the chat as the last open panel", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        mainPanelParam: false,
        panelNamed: false,
        threadVisibilityExplicit: false,
        routeDefaultMain: "board",
      }),
      /** The route default would collapse the chat, but the "at least one panel
       *  open" fallback keeps it showing once the main panel closes. */
    ).toEqual({ threadOpen: true, contentOpen: false });
  });

  /** INVERTED: this was `?main=<tab>`. The view is a path segment now, so what
   *  opens the panel is the segment naming one — `panelNamed`. */
  test("a named view opens Main alongside a Chat default", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        panelNamed: true,
        threadVisibilityExplicit: false,
      }),
    ).toEqual({ threadOpen: true, contentOpen: true });
  });

  /** The split's payoff: the view stays in the path while the panel is shut, so
   *  `?mainpanel=false` closes it without forgetting where it was. */
  test("?mainpanel=false closes the panel even when the path names a view", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        panelNamed: true,
        mainPanelParam: false,
        threadVisibilityExplicit: false,
      }),
    ).toEqual({ threadOpen: true, contentOpen: false });
  });

  test("?mainpanel=true opens a panel the agent default would leave closed", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        panelNamed: false,
        mainPanelParam: true,
        threadVisibilityExplicit: false,
      }),
    ).toEqual({ threadOpen: true, contentOpen: true });
  });

  test("an all-closed state falls back to Chat", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "settings" } },
        mainPanelParam: false,
        panelNamed: false,
        threadVisibilityExplicit: true,
        sidePanelParamValue: false,
      }),
    ).toEqual({ threadOpen: true, contentOpen: false });
  });
});

describe("resolveChatLayoutPanelAction", () => {
  test("opens Chat when only Main is visible", () => {
    expect(
      resolveChatLayoutPanelAction(
        { type: "toggleThread" },
        { threadOpen: false, contentOpen: true },
      ),
    ).toEqual({ sidepanel: true });
  });

  test("closes the active side panel when Main remains open", () => {
    expect(
      resolveChatLayoutPanelAction(
        { type: "toggleThread" },
        { threadOpen: true, contentOpen: true },
      ),
    ).toEqual({ sidepanel: false });
  });

  test("refuses to close the active side panel when it is the final panel", () => {
    expect(
      resolveChatLayoutPanelAction(
        { type: "toggleThread" },
        { threadOpen: true, contentOpen: false },
      ),
    ).toBeNull();
  });

  /** INVERTED: opening Main used to have to NAME a view (`main=<tabId>`), which
   *  is why closing it erased one. Both directions are the boolean now. */
  test("closing Main opens Chat even when Main was the only visible panel", () => {
    expect(
      resolveChatLayoutPanelAction(
        { type: "toggleContent" },
        { threadOpen: true, contentOpen: false },
      ),
    ).toEqual({ mainpanel: true });
    expect(
      resolveChatLayoutPanelAction(
        { type: "toggleContent" },
        { threadOpen: true, contentOpen: true },
      ),
    ).toEqual({ mainpanel: false, sidepanel: true });
    expect(
      resolveChatLayoutPanelAction(
        { type: "toggleContent" },
        { threadOpen: false, contentOpen: true },
      ),
    ).toEqual({ mainpanel: false, sidepanel: true });
  });

  test("openThread is idempotent and opens Chat when it is closed", () => {
    expect(
      resolveChatLayoutPanelAction(
        { type: "openThread" },
        { threadOpen: true, contentOpen: true },
      ),
    ).toBeNull();
    expect(
      resolveChatLayoutPanelAction(
        { type: "openThread" },
        { threadOpen: false, contentOpen: true },
      ),
    ).toEqual({ sidepanel: true });
  });
});

describe("computeChatLayoutPanelSizes", () => {
  test.each([
    [
      { threadOpen: true, contentOpen: false },
      { side: 100, main: 0 },
    ],
    [
      { threadOpen: true, contentOpen: true },
      { side: 33, main: 67 },
    ],
    [
      { threadOpen: false, contentOpen: true },
      { side: 0, main: 100 },
    ],
  ])("computes the two-panel workspace sizes", (visibility, expected) => {
    expect(computeChatLayoutPanelSizes(visibility)).toEqual(expected);
  });
});

describe("mobileSurfaceSearch", () => {
  test("selects exactly one mobile surface", () => {
    expect(mobileSurfaceSearch("chat")).toEqual({
      sidepanel: true,
      mainpanel: false,
    });
    expect(mobileSurfaceSearch("main")).toEqual({
      sidepanel: false,
      mainpanel: true,
    });
  });
});

describe("resolveMobileSurface", () => {
  test("an explicit ?sidepanel=true wins over an open main panel", () => {
    expect(
      resolveMobileSurface({
        visibility: { threadOpen: true, contentOpen: true },
        threadVisibilityExplicit: true,
      }),
    ).toBe("chat");
  });

  test("the default main view still wins when ?sidepanel is absent", () => {
    expect(
      resolveMobileSurface({
        visibility: { threadOpen: true, contentOpen: true },
        threadVisibilityExplicit: false,
      }),
    ).toBe("main");
  });

  test("falls back to main / chat when only one panel is open", () => {
    expect(
      resolveMobileSurface({
        visibility: { threadOpen: false, contentOpen: true },
        threadVisibilityExplicit: true,
      }),
    ).toBe("main");
    expect(
      resolveMobileSurface({
        visibility: { threadOpen: true, contentOpen: false },
        threadVisibilityExplicit: false,
      }),
    ).toBe("chat");
  });
});
