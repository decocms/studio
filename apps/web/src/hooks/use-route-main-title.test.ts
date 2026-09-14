import { describe, expect, test } from "bun:test";
import {
  resolveRouteMainBreadcrumbParentKey,
  resolveRouteMainTitleKey,
  resolveRouteMainTitleParam,
} from "./use-route-main-title";

describe("resolveRouteMainTitleKey", () => {
  test("inherits a Site Editor parent title through its nested leaf", () => {
    expect(
      resolveRouteMainTitleKey([
        { staticData: {} },
        {
          staticData: {
            mainTitleKey: "sidebar.projectNav.siteEditor",
          },
        },
        { staticData: {} },
      ]),
    ).toBe("sidebar.projectNav.siteEditor");
  });

  test("uses the deepest fixed title and leaves dynamic routes unnamed", () => {
    expect(
      resolveRouteMainTitleKey([
        { staticData: { mainTitleKey: "sidebar.navDestinations.home" } },
        { staticData: { mainTitleKey: "sidebar.navDestinations.settings" } },
      ]),
    ).toBe("sidebar.navDestinations.settings");
    expect(resolveRouteMainTitleKey([{ staticData: {} }])).toBeUndefined();
  });
});

describe("resolveRouteMainBreadcrumbParentKey", () => {
  test("uses only the deepest nested route that contributes a parent", () => {
    expect(
      resolveRouteMainBreadcrumbParentKey([
        { staticData: {} },
        {
          staticData: {
            mainBreadcrumbParentKey: "settings.nav.connections",
          },
        },
      ]),
    ).toBe("settings.nav.connections");
    expect(
      resolveRouteMainBreadcrumbParentKey([{ staticData: {} }]),
    ).toBeUndefined();
  });
});

describe("resolveRouteMainTitleParam", () => {
  test("uses the deepest declared dynamic title parameter", () => {
    expect(
      resolveRouteMainTitleParam([
        { staticData: { mainTitleParam: "appSlug" }, params: {} },
        {
          staticData: { mainTitleParam: "itemId" },
          params: { itemId: "run report" },
        },
      ]),
    ).toBe("run report");
  });

  test("ignores blank values and preserves already-decoded router params", () => {
    expect(
      resolveRouteMainTitleParam([
        {
          staticData: { mainTitleParam: "itemId" },
          params: { itemId: "   " },
        },
      ]),
    ).toBeUndefined();
    expect(
      resolveRouteMainTitleParam([
        {
          staticData: { mainTitleParam: "itemId" },
          params: { itemId: " run%20report " },
        },
      ]),
    ).toBe(" run%20report ");
    expect(
      resolveRouteMainTitleParam([
        {
          staticData: { mainTitleParam: "itemId" },
          params: { itemId: "100% done" },
        },
      ]),
    ).toBe("100% done");
  });
});
