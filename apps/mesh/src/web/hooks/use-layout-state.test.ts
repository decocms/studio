import { describe, expect, test } from "bun:test";
import {
  canCloseWorkspacePanel,
  computeChatMainSizes,
  resolveDefaultPanelState,
} from "./use-layout-state";

describe("resolveDefaultPanelState", () => {
  test("no metadata → main closed, chat open", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: null,
        mainParamPresent: false,
        blocksParamPresent: false,
      }),
    ).toEqual({ mainOpen: false, chatOpen: true, blocksOpen: false });
  });

  test("defaultMainView.type='chat' → main closed, chat open", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        mainParamPresent: false,
        blocksParamPresent: false,
      }),
    ).toEqual({ mainOpen: false, chatOpen: true, blocksOpen: false });
  });

  test("defaultMainView.type non-chat → main open, chat closed", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "ext-app", id: "x" } },
        mainParamPresent: false,
        blocksParamPresent: false,
      }),
    ).toEqual({ mainOpen: true, chatOpen: false, blocksOpen: false });
  });

  test("chatDefaultOpen=true with non-chat default → main open, chat open", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "ext-app", id: "x" },
          chatDefaultOpen: true,
        },
        mainParamPresent: false,
        blocksParamPresent: false,
      }),
    ).toEqual({ mainOpen: true, chatOpen: true, blocksOpen: false });
  });

  test("chatDefaultOpen=false is the default behavior (chat closed)", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "layout" },
          chatDefaultOpen: false,
        },
        mainParamPresent: false,
        blocksParamPresent: false,
      }),
    ).toEqual({ mainOpen: true, chatOpen: false, blocksOpen: false });
  });

  test("chatDefaultOpen ignored when default is chat (chat still open)", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "chat" },
          chatDefaultOpen: false,
        },
        mainParamPresent: false,
        blocksParamPresent: false,
      }),
    ).toEqual({ mainOpen: false, chatOpen: true, blocksOpen: false });
  });

  test("?main=0 overrides default and falls back to chat", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "settings" } },
        mainParamPresent: true,
        mainParamValue: "0",
        blocksParamPresent: false,
      }),
    ).toEqual({ mainOpen: false, chatOpen: true, blocksOpen: false });
  });

  test("?main=<tabId> opens main even when default is chat", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        mainParamPresent: true,
        mainParamValue: "layout",
        blocksParamPresent: false,
      }),
    ).toEqual({ mainOpen: true, chatOpen: true, blocksOpen: false });
  });

  test("?blocks=1 opens blocks without changing main or chat defaults", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "settings" } },
        mainParamPresent: false,
        blocksParamPresent: true,
        blocksParamValue: 1,
      }),
    ).toEqual({ mainOpen: true, chatOpen: false, blocksOpen: true });
  });

  test("?blocks=0 closes blocks", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "blocks" },
          chatDefaultOpen: true,
        },
        mainParamPresent: true,
        mainParamValue: "settings",
        blocksParamPresent: true,
        blocksParamValue: 0,
      }),
    ).toEqual({ mainOpen: true, chatOpen: false, blocksOpen: false });
  });

  test("legacy ?main=blocks becomes blocks-only", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: null,
        mainParamPresent: true,
        mainParamValue: "blocks",
        blocksParamPresent: false,
      }),
    ).toEqual({ mainOpen: false, chatOpen: false, blocksOpen: true });
  });

  test("defaultMainView.type='blocks' becomes blocks-only", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "blocks" },
          chatDefaultOpen: true,
        },
        mainParamPresent: false,
        blocksParamPresent: false,
      }),
    ).toEqual({ mainOpen: false, chatOpen: false, blocksOpen: true });
  });

  test("an all-closed derived state falls back to chat", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "blocks" } },
        mainParamPresent: true,
        mainParamValue: "0",
        blocksParamPresent: true,
        blocksParamValue: 0,
      }),
    ).toEqual({ mainOpen: false, chatOpen: true, blocksOpen: false });
  });
});

describe("canCloseWorkspacePanel", () => {
  test("allows closing each open panel when another panel is open", () => {
    const visibility = { chatOpen: true, blocksOpen: true, mainOpen: true };

    expect(canCloseWorkspacePanel("chat", visibility)).toBe(true);
    expect(canCloseWorkspacePanel("blocks", visibility)).toBe(true);
    expect(canCloseWorkspacePanel("main", visibility)).toBe(true);
  });

  test("does not allow closing the final open panel", () => {
    expect(
      canCloseWorkspacePanel("chat", {
        chatOpen: true,
        blocksOpen: false,
        mainOpen: false,
      }),
    ).toBe(false);
    expect(
      canCloseWorkspacePanel("blocks", {
        chatOpen: false,
        blocksOpen: true,
        mainOpen: false,
      }),
    ).toBe(false);
    expect(
      canCloseWorkspacePanel("main", {
        chatOpen: false,
        blocksOpen: false,
        mainOpen: true,
      }),
    ).toBe(false);
  });

  test("does not allow closing a panel that is already closed", () => {
    const visibility = { chatOpen: true, blocksOpen: false, mainOpen: true };

    expect(canCloseWorkspacePanel("blocks", visibility)).toBe(false);
  });
});

describe("computeChatMainSizes", () => {
  test("both open → 45/55", () => {
    expect(computeChatMainSizes(true, true)).toEqual({ chat: 33, main: 67 });
  });

  test("only chat → 100/0", () => {
    expect(computeChatMainSizes(true, false)).toEqual({ chat: 100, main: 0 });
  });

  test("only main → 0/100", () => {
    expect(computeChatMainSizes(false, true)).toEqual({ chat: 0, main: 100 });
  });

  test("neither → 0/0 (chat panel is collapsible to 0)", () => {
    expect(computeChatMainSizes(false, false)).toEqual({ chat: 0, main: 0 });
  });
});
