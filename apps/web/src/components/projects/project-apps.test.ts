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
});
