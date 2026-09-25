import { describe, expect, test } from "bun:test";
import {
  File02,
  Globe01,
  Heart,
  LayoutAlt04,
  Lightning01,
} from "@untitledui/icons";
import { resolveTabIcon, SYSTEM_TAB_ICONS } from "./resolve-tab-icon";

type TestConn = { id: string; icon: string | null };

describe("SYSTEM_TAB_ICONS", () => {
  test("covers every fixed system tab", () => {
    expect(SYSTEM_TAB_ICONS.settings).toBe(LayoutAlt04);
    expect(SYSTEM_TAB_ICONS.automations).toBe(Lightning01);
    expect(SYSTEM_TAB_ICONS["site-editor"]).toBeDefined();
    expect(SYSTEM_TAB_ICONS.git).toBeDefined();
    expect(SYSTEM_TAB_ICONS.code).toBeDefined();
  });
});

describe("code system icon", () => {
  test("resolve to component icons", () => {
    const code = resolveTabIcon({
      kind: "system",
      tabId: "code",
      connections: [],
    });
    expect(code.kind).toBe("component");
  });
});

describe("resolveTabIcon", () => {
  test.each(["icon://Heart", "icon://Heart?color=emerald"])(
    "resolves a pinned app's %s to a component without a connection lookup",
    (iconUrl) => {
      expect(
        resolveTabIcon({
          tabId: "app:connection:WISHLIST_DASHBOARD",
          kind: "expanded",
          iconUrl,
          connections: [],
        }),
      ).toEqual({ kind: "component", Component: Heart });
    },
  );

  test.each([null, undefined, "", "icon://", "icon://UnknownIcon"])(
    "falls back for an absent or unknown pinned app icon: %s",
    (iconUrl) => {
      expect(
        resolveTabIcon({
          tabId: "app:connection:APP_DASHBOARD",
          kind: "expanded",
          iconUrl,
          connections: [],
        }),
      ).toEqual({ kind: "fallback" });
    },
  );

  test("preserves a pinned app's image URL without a connection lookup", () => {
    expect(
      resolveTabIcon({
        tabId: "app:connection:APP_DASHBOARD",
        kind: "expanded",
        iconUrl: "https://example.com/icon.png",
        connections: [],
      }),
    ).toEqual({ kind: "url", src: "https://example.com/icon.png" });
  });

  const conns: TestConn[] = [
    { id: "app-a", icon: "https://example.com/a.png" },
    { id: "app-b", icon: null },
  ];

  test("system tab → component icon from SYSTEM_TAB_ICONS", () => {
    expect(
      resolveTabIcon({
        tabId: "settings",
        kind: "system",
        connections: conns,
      }),
    ).toEqual({ kind: "component", Component: LayoutAlt04 });
  });

  test("site-editor (Preview) resolves to the globe icon", () => {
    expect(
      resolveTabIcon({
        tabId: "site-editor",
        kind: "system",
        connections: conns,
      }),
    ).toEqual({ kind: "component", Component: Globe01 });
  });

  test("content resolves to the document icon", () => {
    expect(
      resolveTabIcon({
        tabId: "content",
        kind: "system",
        connections: conns,
      }),
    ).toEqual({ kind: "component", Component: File02 });
  });

  test("system tab with an id absent from SYSTEM_TAB_ICONS → fallback", () => {
    expect(
      resolveTabIcon({
        tabId: "not-a-real-system-tab",
        kind: "system",
        connections: conns,
      }),
    ).toEqual({ kind: "fallback" });
  });

  test("agent ext-app with connection icon URL → url kind", () => {
    expect(
      resolveTabIcon({
        tabId: "my-tab",
        kind: "agent",
        appId: "app-a",
        connections: conns,
      }),
    ).toEqual({ kind: "url", src: "https://example.com/a.png" });
  });

  test("agent ext-app with connection.icon === null → fallback", () => {
    expect(
      resolveTabIcon({
        tabId: "my-tab",
        kind: "agent",
        appId: "app-b",
        connections: conns,
      }),
    ).toEqual({ kind: "fallback" });
  });

  test("agent ext-app whose appId matches no connection → fallback", () => {
    expect(
      resolveTabIcon({
        tabId: "my-tab",
        kind: "agent",
        appId: "missing",
        connections: conns,
      }),
    ).toEqual({ kind: "fallback" });
  });

  test("expanded tab behaves like agent for icon resolution", () => {
    expect(
      resolveTabIcon({
        tabId: "SOME_TOOL",
        kind: "expanded",
        appId: "app-a",
        connections: conns,
      }),
    ).toEqual({ kind: "url", src: "https://example.com/a.png" });
  });

  test("agent tab with no appId → fallback", () => {
    expect(
      resolveTabIcon({
        tabId: "my-tab",
        kind: "agent",
        connections: conns,
      }),
    ).toEqual({ kind: "fallback" });
  });
});
