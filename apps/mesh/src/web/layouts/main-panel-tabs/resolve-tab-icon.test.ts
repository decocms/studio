import { describe, expect, test } from "bun:test";
import { LayoutAlt04, Lightning01 } from "@untitledui/icons";
import { resolveTabIcon, SYSTEM_TAB_ICONS } from "./resolve-tab-icon";

type TestConn = { id: string; icon: string | null };

describe("SYSTEM_TAB_ICONS", () => {
  test("covers every fixed system tab", () => {
    expect(SYSTEM_TAB_ICONS.settings).toBe(LayoutAlt04);
    expect(SYSTEM_TAB_ICONS.automations).toBe(Lightning01);
    expect(SYSTEM_TAB_ICONS.env).toBeDefined();
    expect(SYSTEM_TAB_ICONS.preview).toBeDefined();
    expect(SYSTEM_TAB_ICONS.git).toBeDefined();
  });
});

describe("resolveTabIcon", () => {
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
