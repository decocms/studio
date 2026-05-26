import { describe, expect, test } from "bun:test";
import {
  computeChatMainSizes,
  resolveDefaultPanelState,
} from "./use-layout-state";

describe("resolveDefaultPanelState", () => {
  test("no metadata → main closed, chat open", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: null,
        mainParamPresent: false,
      }),
    ).toEqual({ mainOpen: false, chatOpen: true });
  });

  test("defaultMainView.type='chat' → main closed, chat open", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        mainParamPresent: false,
      }),
    ).toEqual({ mainOpen: false, chatOpen: true });
  });

  test("defaultMainView.type non-chat → main open, chat closed", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "ext-app", id: "x" } },
        mainParamPresent: false,
      }),
    ).toEqual({ mainOpen: true, chatOpen: false });
  });

  test("chatDefaultOpen=true with non-chat default → main open, chat open", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "ext-app", id: "x" },
          chatDefaultOpen: true,
        },
        mainParamPresent: false,
      }),
    ).toEqual({ mainOpen: true, chatOpen: true });
  });

  test("chatDefaultOpen=false is the default behavior (chat closed)", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "layout" },
          chatDefaultOpen: false,
        },
        mainParamPresent: false,
      }),
    ).toEqual({ mainOpen: true, chatOpen: false });
  });

  test("chatDefaultOpen ignored when default is chat (chat still open)", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: {
          defaultMainView: { type: "chat" },
          chatDefaultOpen: false,
        },
        mainParamPresent: false,
      }),
    ).toEqual({ mainOpen: false, chatOpen: true });
  });

  test("?main=0 overrides default → main closed", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "settings" } },
        mainParamPresent: true,
        mainParamValue: "0",
      }),
    ).toEqual({ mainOpen: false, chatOpen: false });
  });

  test("?main=<tabId> opens main even when default is chat", () => {
    expect(
      resolveDefaultPanelState({
        entityMetadata: { defaultMainView: { type: "chat" } },
        mainParamPresent: true,
        mainParamValue: "layout",
      }),
    ).toEqual({ mainOpen: true, chatOpen: true });
  });
});

describe("computeChatMainSizes", () => {
  test("both open → 45/55", () => {
    expect(computeChatMainSizes(true, true)).toEqual({ chat: 45, main: 55 });
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
