import { describe, expect, test } from "bun:test";
import {
  computeChatLayoutPanelSizes,
  mobileSurfaceSearch,
  resolveDefaultPanelState,
  resolveMobileSurface,
} from "./use-chat-layout-state";

describe("resolveDefaultPanelState", () => {
  const base = {
    entityMetadata: null,
    panelNamed: false,
    contentFullscreen: false,
  };

  test("defaults to the chat alone when no view is named", () => {
    expect(resolveDefaultPanelState(base)).toEqual({
      threadOpen: true,
      contentOpen: false,
    });
    expect(
      resolveDefaultPanelState({
        ...base,
        entityMetadata: { defaultMainView: { type: "chat" } },
      }),
    ).toEqual({ threadOpen: true, contentOpen: false });
  });

  test.each([
    ["a path segment", { panelNamed: true }],
    ["a route default", { routeDefaultMain: "board" }],
    [
      "an agent default",
      { entityMetadata: { defaultMainView: { type: "preview" } } },
    ],
  ])("keeps the chat beside a view named by %s", (_, named) => {
    expect(resolveDefaultPanelState({ ...base, ...named })).toEqual({
      threadOpen: true,
      contentOpen: true,
    });
  });

  test("a project that opens with the chat closed starts full screen", () => {
    const closed = {
      ...base,
      entityMetadata: {
        defaultMainView: { type: "preview" },
        chatDefaultOpen: false,
      },
    };
    expect(resolveDefaultPanelState(closed)).toEqual({
      threadOpen: false,
      contentOpen: true,
    });
    // ?sidepanel=true still brings the chat back there.
    expect(
      resolveDefaultPanelState({ ...closed, sidePanelParam: true }),
    ).toEqual({ threadOpen: true, contentOpen: true });
  });

  test("an unset setting opens the chat", () => {
    expect(
      resolveDefaultPanelState({
        ...base,
        entityMetadata: {
          defaultMainView: { type: "preview" },
          chatDefaultOpen: null,
        },
      }),
    ).toEqual({ threadOpen: true, contentOpen: true });
  });

  test("the full-screen preference hides the chat beside an open view", () => {
    expect(
      resolveDefaultPanelState({
        ...base,
        panelNamed: true,
        contentFullscreen: true,
      }),
    ).toEqual({ threadOpen: false, contentOpen: true });
  });

  test("an explicit ?sidepanel=true shows the chat over full screen", () => {
    expect(
      resolveDefaultPanelState({
        ...base,
        panelNamed: true,
        contentFullscreen: true,
        sidePanelParam: true,
      }),
    ).toEqual({ threadOpen: true, contentOpen: true });
  });

  test("?sidepanel=false does not close the chat on desktop", () => {
    expect(
      resolveDefaultPanelState({
        ...base,
        panelNamed: true,
        sidePanelParam: false,
      }),
    ).toEqual({ threadOpen: true, contentOpen: true });
  });

  test("full screen with no main panel still shows the chat", () => {
    expect(
      resolveDefaultPanelState({
        ...base,
        mainPanelParam: false,
        panelNamed: true,
        contentFullscreen: true,
      }),
    ).toEqual({ threadOpen: true, contentOpen: false });
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
      resolveMobileSurface({ contentOpen: true, sidePanelParam: true }),
    ).toBe("chat");
  });

  test("an open main view wins when ?sidepanel is absent or false", () => {
    expect(resolveMobileSurface({ contentOpen: true })).toBe("main");
    expect(
      resolveMobileSurface({ contentOpen: true, sidePanelParam: false }),
    ).toBe("main");
  });

  test("shows the chat when there is no main panel", () => {
    expect(
      resolveMobileSurface({ contentOpen: false, sidePanelParam: false }),
    ).toBe("chat");
  });
});
