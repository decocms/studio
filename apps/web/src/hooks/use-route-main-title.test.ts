import { describe, expect, test } from "bun:test";
import { resolveRouteMainTitleKey } from "./use-route-main-title";

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
