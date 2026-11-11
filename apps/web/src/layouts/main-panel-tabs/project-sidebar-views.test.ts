import { describe, expect, test } from "bun:test";
import { VirtualMcpSidebarViewSchema } from "@decocms/shared/sdk/types";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import {
  DEFAULT_PROJECT_SIDEBAR_VIEWS,
  PROJECT_NAV_VIEW_IDS,
  PROJECT_SIDEBAR_VIEW_IDS,
  availableProjectSidebarViews,
  defaultMainViewAfterSidebarToggle,
  effectiveProjectSidebarViews,
  isProjectNativeViewId,
  isProjectSidebarViewId,
  offeredProjectSidebarViews,
  seenProjectSidebarViewsAfterSave,
  projectMainViewPresence,
  projectDefaultViewUnavailable,
  projectSidebarViewPresence,
  projectSidebarViewUnavailable,
  resolveProjectMainViewContext,
  resolveProjectSidebarViews,
  selectedProjectNavViews,
  selectedProjectSidebarViews,
  toggleProjectSidebarView,
  type ProjectNativeViewPresence,
} from "./project-sidebar-views";

const nativePresence = (
  present: Array<keyof ProjectNativeViewPresence>,
): ProjectNativeViewPresence => ({
  assets: present.includes("assets"),
  releases: present.includes("releases"),
  hosting: present.includes("hosting"),
  e2e: present.includes("e2e"),
  calendar: present.includes("calendar"),
  experiments: present.includes("experiments"),
});

/** The Blocks site views a project that already saw the top rows is offered. */
const blocksOffers = (seen: Array<"calendar" | "experiments"> = []) =>
  offeredProjectSidebarViews([...PROJECT_NAV_VIEW_IDS, ...seen], true);

describe("project sidebar views", () => {
  test("covers every persisted sidebar id but the retired apps, once", () => {
    // Retired apps, moved into Monitor; saved layouts may still name them.
    const retired = new Set(["analytics", "cdn"]);
    expect<string[]>([...PROJECT_SIDEBAR_VIEW_IDS]).toEqual(
      VirtualMcpSidebarViewSchema.options.filter((v) => !retired.has(v)),
    );
    expect(new Set(PROJECT_SIDEBAR_VIEW_IDS).size).toBe(
      PROJECT_SIDEBAR_VIEW_IDS.length,
    );
  });

  test("recognizes configurable and native view ids separately", () => {
    expect(isProjectSidebarViewId("overview")).toBe(true);
    expect(isProjectSidebarViewId("automations")).toBe(true);
    expect(isProjectSidebarViewId("git")).toBe(false);
    expect(isProjectNativeViewId("hosting")).toBe(true);
    expect(isProjectNativeViewId("site-editor")).toBe(false);
    expect(isProjectNativeViewId(undefined)).toBe(false);
  });

  test("combines source and native presence in sidebar order", () => {
    const presence = projectSidebarViewPresence(
      true,
      nativePresence(["e2e", "assets", "hosting"]),
    );

    expect(availableProjectSidebarViews(presence)).toEqual([
      "overview",
      "context",
      "monitor",
      "plan",
      "reports",
      "board",
      "site-editor",
      "assets",
      "hosting",
      "e2e",
      "automations",
    ]);
  });

  test("keeps the sourceless top rows and automations when a project has no source or native views", () => {
    expect(
      availableProjectSidebarViews(
        projectSidebarViewPresence(false, nativePresence([])),
      ),
    ).toEqual(["context", "monitor", "plan", "automations"]);
  });

  test("keeps org destinations present while gating their project-scoped form", () => {
    const native = nativePresence([]);
    expect(
      availableProjectSidebarViews(
        projectMainViewPresence(null, false, native),
      ),
    ).toEqual([
      "overview",
      "context",
      "monitor",
      "plan",
      "reports",
      "board",
      "automations",
    ]);
    expect(
      availableProjectSidebarViews(
        projectMainViewPresence("vir_1", false, native),
      ),
    ).toEqual(["context", "monitor", "plan", "automations"]);
  });

  test("uses the scoped project instead of the org shell for destination main views", () => {
    const shell = { id: "decopilot", metadata: {} };
    const project = {
      id: "vir_project",
      metadata: { repository: { url: "https://github.com/deco/site" } },
    };

    const context = resolveProjectMainViewContext(project.id, project, shell);
    expect(context).toEqual({
      project,
      resolvedScopeId: project.id,
    });
    expect(
      availableProjectSidebarViews(
        projectMainViewPresence(
          context.resolvedScopeId,
          agentHasClonableSource(context.project?.metadata),
          nativePresence([]),
        ),
      ),
    ).toEqual([
      "overview",
      "context",
      "monitor",
      "plan",
      "reports",
      "board",
      "site-editor",
      "automations",
    ]);
  });

  test("reuses an agent-route shell and fails open while a destination scope resolves", () => {
    const project = { id: "vir_project" };

    expect(resolveProjectMainViewContext(project.id, null, project)).toEqual({
      project,
      resolvedScopeId: project.id,
    });
    expect(
      resolveProjectMainViewContext(project.id, null, { id: "decopilot" }),
    ).toEqual({ project: null, resolvedScopeId: null });
  });

  test("uses the initial selection for unversioned projects", () => {
    expect(effectiveProjectSidebarViews(undefined)).toEqual(
      DEFAULT_PROJECT_SIDEBAR_VIEWS,
    );
    expect(effectiveProjectSidebarViews(["assets"])).toEqual([
      "overview",
      "reports",
      "board",
      "site-editor",
      "assets",
    ]);
    expect(effectiveProjectSidebarViews(null)).toEqual(
      DEFAULT_PROJECT_SIDEBAR_VIEWS,
    );
    expect(effectiveProjectSidebarViews([])).toEqual(
      DEFAULT_PROJECT_SIDEBAR_VIEWS,
    );
  });

  test("v8: an unversioned project also shows Calendar", () => {
    const presence = projectSidebarViewPresence(
      true,
      nativePresence(["calendar"]),
    );
    expect(
      selectedProjectSidebarViews(
        undefined,
        presence,
        undefined,
        offeredProjectSidebarViews(undefined, true),
      ),
    ).toEqual([
      "overview",
      "context",
      "monitor",
      "plan",
      "reports",
      "board",
      "site-editor",
      "calendar",
    ]);
  });

  test("treats versioned null and empty selections as an explicit all-off", () => {
    expect(effectiveProjectSidebarViews(null, 1)).toEqual([]);
    expect(effectiveProjectSidebarViews([], 1)).toEqual([]);
  });

  test("requires both presence and selection", () => {
    const presence = projectSidebarViewPresence(
      true,
      nativePresence(["assets", "e2e"]),
    );
    expect(
      selectedProjectSidebarViews(
        ["board", "e2e", "assets", "hosting", "automations"],
        presence,
        1,
      ),
    ).toEqual(["board", "assets", "e2e", "automations"]);
    expect(selectedProjectSidebarViews(undefined, presence)).toEqual([
      "overview",
      "reports",
      "board",
      "site-editor",
    ]);
  });

  test("falls back to Settings when the disabled sidebar view owns the main view", () => {
    expect(
      defaultMainViewAfterSidebarToggle({ type: "assets" }, "assets", false),
    ).toEqual({ type: "settings" });

    for (const type of ["site-editor", "preview", "content", "code"]) {
      expect(
        defaultMainViewAfterSidebarToggle({ type }, "site-editor", false),
      ).toEqual({ type: "settings" });
    }
  });

  test("preserves the main view when enabling a row or disabling another row", () => {
    const defaultMainView = { type: "ext-apps", id: "assets" };

    expect(
      defaultMainViewAfterSidebarToggle(defaultMainView, "assets", false),
    ).toBe(defaultMainView);
    expect(
      defaultMainViewAfterSidebarToggle({ type: "reports" }, "reports", true),
    ).toEqual({ type: "reports" });
    expect(
      defaultMainViewAfterSidebarToggle(null, "reports", false),
    ).toBeNull();
  });

  test("prefers canonical sidebar views, including explicit null and empty", () => {
    const legacy = { ui: { layout: { sidebarViews: ["hosting"] as const } } };

    expect(
      resolveProjectSidebarViews({
        ...legacy,
        sidebarViews: ["cdn", "assets"],
      }),
    ).toEqual(["cdn", "assets"]);
    expect(
      resolveProjectSidebarViews({ ...legacy, sidebarViews: null }),
    ).toBeNull();
    expect(resolveProjectSidebarViews({ ...legacy, sidebarViews: [] })).toEqual(
      [],
    );
  });

  test("falls back to deprecated layout values only when canonical is absent", () => {
    expect(
      resolveProjectSidebarViews({
        ui: { layout: { sidebarViews: ["cdn", "assets", "cdn"] } },
      }),
    ).toEqual(["cdn", "assets", "cdn"]);
    expect(
      resolveProjectSidebarViews({ ui: { layout: null } }),
    ).toBeUndefined();
    expect(resolveProjectSidebarViews(null)).toBeUndefined();
  });

  test("toggle normalizes every view and starts from compatibility defaults", () => {
    expect(toggleProjectSidebarView(undefined, "assets", true)).toEqual([
      "overview",
      "reports",
      "board",
      "site-editor",
      "assets",
    ]);
    expect(
      toggleProjectSidebarView(
        ["e2e", "overview", "e2e", "automations"],
        "overview",
        false,
        1,
      ),
    ).toEqual(["e2e", "automations"]);
  });

  test("drops the retired Analytics, CDN and Experiments rows from a saved list", () => {
    expect(
      selectedProjectSidebarViews(
        ["analytics", "cdn", "experiments", "board"],
        projectSidebarViewPresence(true, nativePresence([])),
        1,
      ),
    ).toEqual(["board"]);
  });

  test("keeps native routes while presence discovery is pending", () => {
    const none = projectSidebarViewPresence(false, nativePresence([]));

    expect(
      projectSidebarViewUnavailable("assets", none, {
        assets: true,
        siteAccess: false,
      }),
    ).toBe(false);
    expect(
      projectSidebarViewUnavailable("hosting", none, {
        assets: false,
        siteAccess: true,
      }),
    ).toBe(false);
    expect(
      projectSidebarViewUnavailable("assets", none, {
        assets: false,
        siteAccess: false,
      }),
    ).toBe(true);
    expect(
      projectSidebarViewUnavailable("git", none, {
        assets: false,
        siteAccess: false,
      }),
    ).toBe(false);
  });

  test("Releases, Calendar and Experiments deep links follow the v8 switch at once", () => {
    const none = projectSidebarViewPresence(true, nativePresence([]));
    const pending = { assets: true, siteAccess: true };
    for (const viewId of ["releases", "calendar", "experiments"] as const) {
      // The switch off (v7): unavailable, nothing to wait for.
      expect(projectSidebarViewUnavailable(viewId, none, pending)).toBe(true);
      // The switch on (v8): there.
      const v8 = projectSidebarViewPresence(true, nativePresence([viewId]));
      expect(projectSidebarViewUnavailable(viewId, v8, pending)).toBe(false);
    }
  });

  test("rejects source-backed views immediately when source is absent", () => {
    const none = projectSidebarViewPresence(false, nativePresence([]));
    const pending = { assets: true, siteAccess: true };

    for (const viewId of ["overview", "reports", "board", "site-editor"]) {
      expect(projectSidebarViewUnavailable(viewId, none, pending)).toBe(true);
    }
    expect(projectSidebarViewUnavailable("automations", none, pending)).toBe(
      false,
    );
  });

  test("rejects unavailable Site Editor and retired surface defaults", () => {
    const absent = projectSidebarViewPresence(false, nativePresence([]));
    const present = projectSidebarViewPresence(true, nativePresence([]));
    const settled = { assets: false, siteAccess: false };

    expect(
      projectDefaultViewUnavailable("preview", absent, settled, [], true),
    ).toBe(true);
    expect(
      projectDefaultViewUnavailable(
        "content",
        present,
        settled,
        ["site-editor"],
        true,
      ),
    ).toBe(true);
    expect(
      projectDefaultViewUnavailable(
        "code",
        present,
        settled,
        ["site-editor"],
        false,
      ),
    ).toBe(false);
    expect(
      projectDefaultViewUnavailable(
        "code",
        present,
        settled,
        ["site-editor"],
        true,
      ),
    ).toBe(true);
    expect(
      projectDefaultViewUnavailable("ext-apps", absent, settled, [], true),
    ).toBe(false);
  });
});

describe("Calendar on a Blocks (v8) site", () => {
  test("shows by default as a peer of the Site Editor where the site has it", () => {
    const v8 = projectSidebarViewPresence(true, nativePresence(["calendar"]));
    expect(
      selectedProjectSidebarViews(
        undefined,
        v8,
        undefined,
        offeredProjectSidebarViews(undefined, true),
      ),
    ).toEqual([
      "overview",
      "context",
      "monitor",
      "plan",
      "reports",
      "board",
      "site-editor",
      "calendar",
    ]);
  });

  test("Calendar is absent where the site isn't v8, and needs a source", () => {
    const v7 = projectSidebarViewPresence(true, nativePresence([]));
    expect(selectedProjectSidebarViews(undefined, v7)).not.toContain(
      "calendar",
    );
    const noSource = projectSidebarViewPresence(
      false,
      nativePresence(["calendar"]),
    );
    expect(noSource.calendar).toBe(false);
  });

  test("a saved choice is kept: a turned-off Calendar stays off", () => {
    const v8 = projectSidebarViewPresence(true, nativePresence(["calendar"]));
    expect(selectedProjectSidebarViews(["site-editor"], v8, 1)).toEqual([
      "site-editor",
    ]);
  });
});

describe("Calendar added once to a Blocks site's saved list", () => {
  const v8 = projectSidebarViewPresence(true, nativePresence(["calendar"]));
  const saved = ["site-editor", "releases"] as const;

  test("a list saved before it was a default gets it on a Blocks site", () => {
    const offered = blocksOffers();
    expect(offered).toEqual(["calendar", "experiments"]);
    expect(selectedProjectSidebarViews(saved, v8, 1, offered)).toEqual([
      "site-editor",
      "calendar",
    ]);
  });

  test("never on a v7 site", () => {
    expect(offeredProjectSidebarViews(PROJECT_NAV_VIEW_IDS, false)).toEqual([]);
    const v7 = projectSidebarViewPresence(true, nativePresence([]));
    expect(
      selectedProjectSidebarViews(
        saved,
        v7,
        1,
        offeredProjectSidebarViews(PROJECT_NAV_VIEW_IDS, false),
      ),
    ).toEqual(["site-editor"]);
  });

  test("once: after a save, hiding it sticks", () => {
    // The editor sees Calendar offered, and hides it.
    const shown = effectiveProjectSidebarViews(saved, 1, blocksOffers());
    const next = toggleProjectSidebarView(shown, "calendar", false, 1);
    const seen = seenProjectSidebarViewsAfterSave(PROJECT_NAV_VIEW_IDS, true);
    expect(seen).toEqual([...PROJECT_NAV_VIEW_IDS, "calendar", "experiments"]);
    // Read back: nothing is offered again, the saved list decides.
    const offered = offeredProjectSidebarViews(seen, true);
    expect(offered).toEqual([]);
    expect(selectedProjectSidebarViews(next, v8, 1, offered)).toEqual([
      "site-editor",
    ]);
  });

  test("a save on a v7 site leaves it to offer once it becomes a Blocks site", () => {
    const seen = seenProjectSidebarViewsAfterSave(undefined, false);
    expect(seen).toEqual([...PROJECT_NAV_VIEW_IDS]);
    expect(seenProjectSidebarViewsAfterSave(null, false)).toEqual(seen);
    expect(offeredProjectSidebarViews(seen, true)).toEqual([
      "calendar",
      "experiments",
    ]);
  });

  test("unversioned projects get the defaults plus the offers", () => {
    expect(
      selectedProjectSidebarViews(
        undefined,
        v8,
        undefined,
        offeredProjectSidebarViews(undefined, true),
      ),
    ).toContain("calendar");
  });

  test("Calendar is still only where it shows today", () => {
    const noCalendar = projectSidebarViewPresence(true, nativePresence([]));
    expect(
      selectedProjectSidebarViews(
        saved,
        noCalendar,
        1,
        offeredProjectSidebarViews(undefined, true),
      ),
    ).not.toContain("calendar");
  });
});

describe("Experiments on a Blocks (v8) site", () => {
  const v8 = projectSidebarViewPresence(
    true,
    nativePresence(["calendar", "experiments"]),
  );

  test("shows as a peer of the Site Editor, after Calendar", () => {
    expect(
      selectedProjectSidebarViews(
        undefined,
        v8,
        undefined,
        offeredProjectSidebarViews(undefined, true),
      ),
    ).toEqual([
      "overview",
      "context",
      "monitor",
      "plan",
      "reports",
      "board",
      "site-editor",
      "calendar",
      "experiments",
    ]);
  });

  test("is absent where the site isn't v8 (v7 tests stay in Monitor), and needs a source", () => {
    const v7 = projectSidebarViewPresence(true, nativePresence([]));
    expect(v7.experiments).toBe(false);
    expect(
      selectedProjectSidebarViews(
        ["site-editor", "experiments"],
        v7,
        1,
        offeredProjectSidebarViews(PROJECT_NAV_VIEW_IDS, false),
      ),
    ).toEqual(["site-editor"]);
    expect(
      projectSidebarViewPresence(false, nativePresence(["experiments"]))
        .experiments,
    ).toBe(false);
  });

  test("offered once to a list that already saw Calendar", () => {
    const offered = blocksOffers(["calendar"]);
    expect(offered).toEqual(["experiments"]);
    expect(
      selectedProjectSidebarViews(["site-editor"], v8, 1, offered),
    ).toEqual(["site-editor", "experiments"]);
  });

  test("once: hidden after a save, it stays hidden", () => {
    const seen = seenProjectSidebarViewsAfterSave(
      [...PROJECT_NAV_VIEW_IDS, "calendar"],
      true,
    );
    expect(seen).toEqual([...PROJECT_NAV_VIEW_IDS, "calendar", "experiments"]);
    const offered = offeredProjectSidebarViews(seen, true);
    expect(offered).toEqual([]);
    expect(
      selectedProjectSidebarViews(["site-editor"], v8, 1, offered),
    ).toEqual(["site-editor"]);
  });

  test("a deep link is unavailable at once where it's absent", () => {
    const none = projectSidebarViewPresence(true, nativePresence([]));
    expect(
      projectSidebarViewUnavailable("experiments", none, {
        assets: true,
        siteAccess: true,
      }),
    ).toBe(true);
    expect(
      projectSidebarViewUnavailable("experiments", v8, {
        assets: false,
        siteAccess: false,
      }),
    ).toBe(false);
  });
});

describe("a project's top rows", () => {
  /** A list saved before the top rows could be hidden. */
  const saved = ["site-editor", "automations"] as const;

  test("every project is offered them once on top of its saved list", () => {
    expect(offeredProjectSidebarViews(undefined, false)).toEqual([
      ...PROJECT_NAV_VIEW_IDS,
    ]);
    expect([
      ...selectedProjectNavViews(
        { sidebarViews: [...saved], sidebarViewsVersion: 1 },
        undefined,
      ),
    ]).toEqual([...PROJECT_NAV_VIEW_IDS]);
  });

  test("once: after a save, hiding one sticks", () => {
    const shown = effectiveProjectSidebarViews(
      saved,
      1,
      offeredProjectSidebarViews(undefined, false),
    );
    const next = toggleProjectSidebarView(shown, "overview", false, 1);
    const metadata = {
      sidebarViews: next,
      sidebarViewsVersion: 1 as const,
      sidebarViewsSeen: seenProjectSidebarViewsAfterSave(undefined, false),
    };
    expect([...selectedProjectNavViews(metadata, undefined)]).toEqual([
      "context",
      "monitor",
      "plan",
      "board",
    ]);
  });

  test("follow an edit in flight before it is saved", () => {
    expect([
      ...selectedProjectNavViews(
        { sidebarViews: [...saved], sidebarViewsVersion: 1 },
        ["context", "board"],
      ),
    ]).toEqual(["context", "board"]);
  });

  test("all show until the project loads", () => {
    expect([...selectedProjectNavViews(undefined, undefined)]).toEqual([
      ...PROJECT_NAV_VIEW_IDS,
    ]);
  });

  test("hiding Overview while it is the main view lands on Settings", () => {
    expect(
      defaultMainViewAfterSidebarToggle(
        { type: "overview" },
        "overview",
        false,
      ),
    ).toEqual({ type: "settings" });
  });
});
