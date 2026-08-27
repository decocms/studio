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
    mainParamPresent: false,
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
        mainParamPresent: false,
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
        mainParamPresent: false,
        sidePanelParamPresent: true,
        sidePanelParamValue: false,
      }),
    ).toEqual({ sidePanelOpen: false, mainOpen: true });
  });

  /**
   * INVERTED: a destination route used to open its main view AND the chat
   * beside it. Going to Tasks now shows Tasks alone — a route that names its
   * own `defaultMain` collapses the side panel, and `/$org/chat` gets its open
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
        mainParamPresent: false,
        sidePanelParamPresent: true,
        sidePanelParamValue: true,
        routeDefaultMain: "board",
      }),
    ).toEqual({ sidePanelOpen: true, mainOpen: true });
  });

  test("main=0 on a route default leaves the chat as the last open panel", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        mainParamPresent: true,
        mainParamValue: 0,
        sidePanelParamPresent: false,
        routeDefaultMain: "board",
      }),
      /** The route default would collapse the chat, but the "at least one panel
       *  open" fallback keeps it showing once `main=0` closes the other. */
    ).toEqual({ sidePanelOpen: true, mainOpen: false });
  });

  test("main=<tab> opens Main alongside a Chat default", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        mainParamPresent: true,
        mainParamValue: "settings",
        sidePanelParamPresent: false,
      }),
    ).toEqual({ sidePanelOpen: true, mainOpen: true });
  });

  test("an all-closed state falls back to Chat", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "settings" } },
        mainParamPresent: true,
        mainParamValue: 0,
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

  test("opens and closes Main with the final-panel guard", () => {
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleMain", openMainValue: "preview" },
        { sidePanelOpen: true, mainOpen: false },
      ),
    ).toEqual({ main: "preview" });
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleMain", openMainValue: "preview" },
        { sidePanelOpen: true, mainOpen: true },
      ),
    ).toEqual({ main: 0 });
    expect(
      resolveWorkspacePanelAction(
        { type: "toggleMain", openMainValue: "preview" },
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
    expect(mobileSurfaceSearch("chat", "preview")).toEqual({
      sidepanel: true,
      main: 0,
    });
    expect(mobileSurfaceSearch("main", "preview")).toEqual({
      sidepanel: false,
      main: "preview",
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
