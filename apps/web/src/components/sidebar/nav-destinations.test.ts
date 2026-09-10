import { describe, expect, test } from "bun:test";
import {
  NAV_DESTINATION_KEYS,
  scopedProjectDestinationEnabled,
  scopedProjectLacksSource,
  SETTINGS_DESTINATION,
} from "./nav-destinations";

/** The sidebar spine, pinned. `useNavDestinations` maps over
 *  `NAV_DESTINATION_KEYS`, so this constant IS the render order rather than a
 *  second copy of it, and its exhaustive record makes a key without a row (or a
 *  row without a key) a compile error. Each row's `trackAs` is
 *  `nav_destination_clicked`'s `destination`, which PostHog keys on; it equals
 *  the key everywhere today, so decouple the two deliberately if ever. This is
 *  the ORG spine: `files` (Library) lists the organization's files, so a
 *  project-scoped sidebar drops that one row rather than show it unfiltered
 *  beside rows that honour the scope. */
describe("nav destinations", () => {
  test("the spine is these four, in this order", () => {
    expect(NAV_DESTINATION_KEYS).toEqual([
      "overview",
      "reports",
      "board",
      "files",
    ]);
  });

  /** Discover has no row for now, but its page is still routable and is listed
   *  in the command palette — withdrawn from the spine, not from the product. */
  test("Discover is not a row", () => {
    expect(NAV_DESTINATION_KEYS).not.toContain("discover");
  });
});

/** Settings left the spine when it became one scope-aware row rendered last,
 *  but its analytics value did not change — PostHog dashboards key on it, and
 *  merging two controls is no reason to break their series. */
describe("SETTINGS_DESTINATION", () => {
  test("keeps the value the dashboards already filter on", () => {
    expect(SETTINGS_DESTINATION).toBe("settings");
  });

  test("is not in the spine any more", () => {
    expect(NAV_DESTINATION_KEYS).not.toContain(SETTINGS_DESTINATION);
  });
});

/** Home, Reports and Tasks are about work on a codebase, so a project with no
 *  repo drops them. The rule has to fail OPEN, because the caller reads the
 *  agent list non-blocking and cannot tell "still loading" from "not scoped"
 *  by the project alone. */
describe("scopedProjectLacksSource", () => {
  const WITH_REPO = {
    metadata: { githubRepo: { url: "https://github.com/acme/app" } },
  };
  const WITHOUT_REPO = { metadata: {} };

  test("an unscoped org keeps its rows", () => {
    expect(scopedProjectLacksSource(null, null)).toBe(false);
    expect(scopedProjectLacksSource(null, WITHOUT_REPO)).toBe(false);
  });

  /** The cold-load case: scoped, but the agent list has not resolved yet. Rows
   *  must stay up rather than blank and pop back once it lands. */
  test("a scope whose project has not resolved yet keeps its rows", () => {
    expect(scopedProjectLacksSource("vir_1", null)).toBe(false);
  });

  test("a scoped project with a repo keeps its rows", () => {
    expect(scopedProjectLacksSource("vir_1", WITH_REPO)).toBe(false);
  });

  test("a scoped project with no repo drops them", () => {
    expect(scopedProjectLacksSource("vir_1", WITHOUT_REPO)).toBe(true);
  });

  /** Same shapes `agentHasClonableSource` rejects: an attachment with no URL is
   *  not a clonable source. */
  test("an empty or urlless repo attachment counts as no source", () => {
    expect(scopedProjectLacksSource("vir_1", { metadata: null })).toBe(true);
    expect(
      scopedProjectLacksSource("vir_1", { metadata: { githubRepo: {} } }),
    ).toBe(true);
    expect(
      scopedProjectLacksSource("vir_1", {
        metadata: { githubRepo: { url: "" } },
      }),
    ).toBe(true);
  });
});

describe("scopedProjectDestinationEnabled", () => {
  test("keeps org rows and unresolved project rows on the first frame", () => {
    expect(scopedProjectDestinationEnabled(null, null, "overview")).toBe(true);
    expect(scopedProjectDestinationEnabled("vir_1", null, "overview")).toBe(
      true,
    );
  });

  test("defaults existing projects to Home, Reports, and Tasks", () => {
    const project = { metadata: {} };
    expect(scopedProjectDestinationEnabled("vir_1", project, "overview")).toBe(
      true,
    );
    expect(scopedProjectDestinationEnabled("vir_1", project, "reports")).toBe(
      true,
    );
    expect(scopedProjectDestinationEnabled("vir_1", project, "board")).toBe(
      true,
    );
  });

  test("honors an explicit per-project selection", () => {
    const project = {
      metadata: {
        sidebarViews: ["board"] as const,
        sidebarViewsVersion: 1 as const,
      },
    };
    expect(scopedProjectDestinationEnabled("vir_1", project, "overview")).toBe(
      false,
    );
    expect(scopedProjectDestinationEnabled("vir_1", project, "reports")).toBe(
      false,
    );
    expect(scopedProjectDestinationEnabled("vir_1", project, "board")).toBe(
      true,
    );
  });

  test("prefers an optimistic selection while a save is pending", () => {
    const project = {
      metadata: {
        sidebarViews: ["overview"] as const,
        sidebarViewsVersion: 1 as const,
      },
    };
    expect(
      scopedProjectDestinationEnabled("vir_1", project, "overview", ["board"]),
    ).toBe(false);
    expect(
      scopedProjectDestinationEnabled("vir_1", project, "board", ["board"]),
    ).toBe(true);
  });

  test("migrates native-only selections without dropping legacy core rows", () => {
    const project = { metadata: { sidebarViews: ["assets"] as const } };
    expect(scopedProjectDestinationEnabled("vir_1", project, "overview")).toBe(
      true,
    );
    expect(scopedProjectDestinationEnabled("vir_1", project, "board")).toBe(
      true,
    );
  });
});
