import { describe, expect, test } from "bun:test";
import {
  canCloseWorkspacePanel,
  computeWorkspacePanelSizes,
  mobileSurfaceSearch,
  resolveDefaultPanelState,
  resolveMobileSurface,
  resolveWorkspacePanelAction,
  resolveWorkspaceThread,
} from "./use-layout-state";

describe("resolveDefaultPanelState", () => {
  const absentSearch = {
    panelNamed: false,
    sidePanelParamPresent: false,
  };

  test("defaults to Chat when no layout metadata exists", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: null,
        ...absentSearch,
      }),
    ).toEqual({ sidePanelOpen: true, mainOpen: false });
  });

  test("a Chat default opens Chat and closes Main", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        ...absentSearch,
      }),
    ).toEqual({ sidePanelOpen: true, mainOpen: false });
  });

  test("a non-Chat default opens Main without a side panel", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "settings" } },
        ...absentSearch,
      }),
    ).toEqual({ sidePanelOpen: false, mainOpen: true });
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
    ).toEqual({ sidePanelOpen: false, mainOpen: true });
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
    ).toEqual({ sidePanelOpen: true, mainOpen: true });
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
    ).toEqual({ sidePanelOpen: false, mainOpen: true });
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
        sidePanelParamPresent: true,
        sidePanelParamValue: false,
        threadHasMessages: true,
      }),
    ).toEqual({ sidePanelOpen: false, mainOpen: true });
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
    ).toEqual({ sidePanelOpen: true, mainOpen: true });
  });

  test("an explicit side panel overrides the configured side-panel default", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "overview" },
          chatDefaultOpen: false,
        },
        panelNamed: false,
        sidePanelParamPresent: true,
        sidePanelParamValue: true,
      }),
    ).toEqual({ sidePanelOpen: true, mainOpen: true });
  });

  test("sidepanel=false keeps a non-Chat default Main-only", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "settings" },
          chatDefaultOpen: true,
        },
        panelNamed: false,
        sidePanelParamPresent: true,
        sidePanelParamValue: false,
      }),
    ).toEqual({ sidePanelOpen: false, mainOpen: true });
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
    ).toEqual({ sidePanelOpen: false, mainOpen: true });
  });

  test("an explicit sidepanel=true reopens the chat on a route default", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        panelNamed: false,
        sidePanelParamPresent: true,
        sidePanelParamValue: true,
        routeDefaultMain: "board",
      }),
    ).toEqual({ sidePanelOpen: true, mainOpen: true });
  });

  test("?mainpanel=false on a route default leaves the chat as the last open panel", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        mainPanelParam: false,
        panelNamed: false,
        sidePanelParamPresent: false,
        routeDefaultMain: "board",
      }),
      /** The route default would collapse the chat, but the "at least one panel
       *  open" fallback keeps it showing once the main panel closes. */
    ).toEqual({ sidePanelOpen: true, mainOpen: false });
  });

  /** INVERTED: this was `?main=<tab>`. The view is a path segment now, so what
   *  opens the panel is the segment naming one — `panelNamed`. */
  test("a named view opens Main alongside a Chat default", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        panelNamed: true,
        sidePanelParamPresent: false,
      }),
    ).toEqual({ sidePanelOpen: true, mainOpen: true });
  });

  /** The split's payoff: the view stays in the path while the panel is shut, so
   *  `?mainpanel=false` closes it without forgetting where it was. */
  test("?mainpanel=false closes the panel even when the path names a view", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        panelNamed: true,
        mainPanelParam: false,
        sidePanelParamPresent: false,
      }),
    ).toEqual({ sidePanelOpen: true, mainOpen: false });
  });

  test("?mainpanel=true opens a panel the agent default would leave closed", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        panelNamed: false,
        mainPanelParam: true,
        sidePanelParamPresent: false,
      }),
    ).toEqual({ sidePanelOpen: true, mainOpen: true });
  });

  test("an all-closed state falls back to Chat", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "settings" } },
        mainPanelParam: false,
        panelNamed: false,
        sidePanelParamPresent: true,
        sidePanelParamValue: false,
      }),
    ).toEqual({ sidePanelOpen: true, mainOpen: false });
  });
});

describe("canCloseWorkspacePanel", () => {
  test("allows closing either panel when both are open", () => {
    const visibility = { sidePanelOpen: true, mainOpen: true };
    expect(canCloseWorkspacePanel("side", visibility)).toBe(true);
    expect(canCloseWorkspacePanel("main", visibility)).toBe(true);
  });

  test("does not allow closing the final open panel", () => {
    expect(
      canCloseWorkspacePanel("side", {
        sidePanelOpen: true,
        mainOpen: false,
      }),
    ).toBe(false);
    expect(
      canCloseWorkspacePanel("main", { sidePanelOpen: false, mainOpen: true }),
    ).toBe(false);
  });
});

describe("resolveWorkspacePanelAction", () => {
  test("opens Chat when only Main is visible", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleSidePanel" },
        { sidePanelOpen: false, mainOpen: true },
      ),
    ).toEqual({ sidepanel: true });
  });

  test("closes the active side panel when Main remains open", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleSidePanel" },
        { sidePanelOpen: true, mainOpen: true },
      ),
    ).toEqual({ sidepanel: false });
  });

  test("refuses to close the active side panel when it is the final panel", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleSidePanel" },
        { sidePanelOpen: true, mainOpen: false },
      ),
    ).toBeNull();
  });

  /** INVERTED: opening Main used to have to NAME a view (`main=<tabId>`), which
   *  is why closing it erased one. Both directions are the boolean now. */
  test("opens and closes Main with the final-panel guard", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleMain" },
        { sidePanelOpen: true, mainOpen: false },
      ),
    ).toEqual({ mainpanel: true });
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleMain" },
        { sidePanelOpen: true, mainOpen: true },
      ),
    ).toEqual({ mainpanel: false });
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleMain" },
        { sidePanelOpen: false, mainOpen: true },
      ),
    ).toBeNull();
  });

  test("openSidePanel is idempotent and opens Chat when it is closed", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "openSidePanel" },
        { sidePanelOpen: true, mainOpen: true },
      ),
    ).toBeNull();
    expect(
      resolveWorkspacePanelAction(
        { type: "openSidePanel" },
        { sidePanelOpen: false, mainOpen: true },
      ),
    ).toEqual({ sidepanel: true });
  });
});

describe("computeWorkspacePanelSizes", () => {
  test.each([
    [
      { sidePanelOpen: true, mainOpen: false },
      { side: 100, main: 0 },
    ],
    [
      { sidePanelOpen: true, mainOpen: true },
      { side: 33, main: 67 },
    ],
    [
      { sidePanelOpen: false, mainOpen: true },
      { side: 0, main: 100 },
    ],
  ])("computes the two-panel workspace sizes", (visibility, expected) => {
    expect(computeWorkspacePanelSizes(visibility)).toEqual(expected);
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
        visibility: { sidePanelOpen: true, mainOpen: true },
        sidePanelParamPresent: true,
      }),
    ).toBe("chat");
  });

  test("the default main view still wins when ?sidepanel is absent", () => {
    expect(
      resolveMobileSurface({
        visibility: { sidePanelOpen: true, mainOpen: true },
        sidePanelParamPresent: false,
      }),
    ).toBe("main");
  });

  test("falls back to main / chat when only one panel is open", () => {
    expect(
      resolveMobileSurface({
        visibility: { sidePanelOpen: false, mainOpen: true },
        sidePanelParamPresent: true,
      }),
    ).toBe("main");
    expect(
      resolveMobileSurface({
        visibility: { sidePanelOpen: true, mainOpen: false },
        sidePanelParamPresent: false,
      }),
    ).toBe("chat");
  });
});

describe("resolveWorkspaceThread", () => {
  const fallbackKey = "5f0d0f3a-0000-4000-8000-000000000000";

  test("the legacy route's own thread is both the thread and the key", () => {
    expect(
      resolveWorkspaceThread({ routeThreadId: "thread-1", fallbackKey }),
    ).toEqual({ threadId: "thread-1", providerKey: "thread-1" });
  });

  test("a destination's ?thread= is both the thread and the key", () => {
    expect(
      resolveWorkspaceThread({ routeThreadId: "thread-2", fallbackKey }),
    ).toEqual({ threadId: "thread-2", providerKey: "thread-2" });
  });

  /**
   * INVERTED: a route naming no thread used to report the fallback id AS the
   * thread, so the workspace opened an SSE stream on
   * `/decopilot/threads/<fabricated-uuid>/stream` (404, one per visit) and
   * reported a `chat_opened` for a thread nobody had opened. The fallback is
   * provider identity only; the thread stays absent.
   */
  test("a route that names no thread keeps the fallback out of the thread id", () => {
    expect(
      resolveWorkspaceThread({ routeThreadId: null, fallbackKey }),
    ).toEqual({ threadId: null, providerKey: fallbackKey });
  });

  test("opening a thread changes the provider key, so the workspace remounts", () => {
    const before = resolveWorkspaceThread({ routeThreadId: null, fallbackKey });
    const after = resolveWorkspaceThread({
      routeThreadId: "thread-3",
      fallbackKey,
    });
    expect(before.providerKey).not.toBe(after.providerKey);
  });
});
