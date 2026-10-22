import { describe, expect, test } from "bun:test";
import { launchableApps } from "./project-apps";

/**
 * The tiles come from the same resolver the scoped sidebar uses, so the two
 * shapes of a project can never disagree about what it has. A tile that opens a
 * view the project lacks is a dead end; a missing tile hides a whole surface.
 */
describe("launchableApps", () => {
  test("a project with no saved preferences offers its defaults", () => {
    expect(launchableApps({ metadata: null })).toEqual([
      "reports",
      "site-editor",
      "experiments",
      "calendar",
    ]);
  });

  test("Experiments and Calendar are default tiles only where the site has them", () => {
    const native = (v8: boolean) => ({
      assets: false,
      hosting: false,
      e2e: false,
      analytics: false,
      cdn: false,
      experiments: v8,
      calendar: v8,
      releases: false,
    });
    expect(launchableApps({ metadata: null }, native(true))).toEqual([
      "reports",
      "site-editor",
      "experiments",
      "calendar",
    ]);
    expect(launchableApps({ metadata: null }, native(false))).toEqual([
      "reports",
      "site-editor",
    ]);
  });

  /** Overview and board are never tiles: the screen the tiles sit on IS those
   *  two, and a door to the room you are in is not a door. Reports used to be
   *  excluded alongside them, which was wrong — it is its own destination, and
   *  dropping it left a project with a diagnostic no way to open it. */
  test("the screen's own views are never tiles", () => {
    const apps = launchableApps({
      metadata: {
        sidebarViews: ["overview", "board", "analytics"],
        sidebarViewsVersion: 1,
      },
    });
    expect(apps).toEqual(["analytics"]);
  });

  test("reports IS a tile — it is a separate destination", () => {
    const apps = launchableApps({
      metadata: {
        sidebarViews: ["overview", "board", "reports", "analytics"],
        sidebarViewsVersion: 1,
      },
    });
    expect(apps).toEqual(["reports", "analytics"]);
  });

  test("an explicit selection is the whole list", () => {
    expect(
      launchableApps({
        metadata: {
          sidebarViews: ["hosting", "site-editor", "experiments"],
          sidebarViewsVersion: 1,
        },
      }),
    ).toEqual(["site-editor", "hosting", "experiments"]);
  });

  /** Version 1 with an empty list means "this project turned everything off",
   *  which is a real answer and not a reason to fall back to the defaults. */
  test("an empty versioned selection offers nothing", () => {
    expect(
      launchableApps({
        metadata: { sidebarViews: [], sidebarViewsVersion: 1 },
      }),
    ).toEqual([]);
  });

  test("reads the deprecated ui.layout location while agents migrate", () => {
    expect(
      launchableApps({
        metadata: {
          ui: { layout: { sidebarViews: ["automations"] } },
          sidebarViewsVersion: 1,
        },
      }),
    ).toEqual(["automations"]);
  });

  test("a native panel without its resource is not a tile", () => {
    const native = {
      assets: false,
      hosting: true,
      e2e: false,
      analytics: false,
      cdn: false,
      experiments: false,
      calendar: false,
      releases: false,
    };
    expect(
      launchableApps(
        {
          metadata: {
            sidebarViews: ["assets", "hosting", "automations"],
            sidebarViewsVersion: 1,
          },
        },
        native,
      ),
    ).toEqual(["hosting", "automations"]);
  });

  test("a Blocks site's saved list gets Experiments and Calendar once", () => {
    const native = (v8: boolean) => ({
      assets: false,
      hosting: false,
      e2e: false,
      analytics: false,
      cdn: false,
      experiments: v8,
      calendar: v8,
      releases: false,
    });
    const metadata = {
      sidebarViews: ["site-editor"] as const,
      sidebarViewsVersion: 1 as const,
    };
    expect(launchableApps({ metadata: { ...metadata } }, native(true))).toEqual(
      ["site-editor", "experiments", "calendar"],
    );
    // Never on a v7 site.
    expect(
      launchableApps({ metadata: { ...metadata } }, native(false)),
    ).toEqual(["site-editor"]);
    // Seen: the saved list decides (Calendar was hidden).
    expect(
      launchableApps(
        {
          metadata: {
            sidebarViews: ["site-editor", "experiments"],
            sidebarViewsVersion: 1,
            sidebarViewsSeen: ["experiments", "calendar"],
          },
        },
        native(true),
      ),
    ).toEqual(["site-editor", "experiments"]);
  });
});
