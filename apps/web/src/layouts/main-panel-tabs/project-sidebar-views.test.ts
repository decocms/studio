import { describe, expect, test } from "bun:test";
import { VirtualMcpSidebarViewSchema } from "@decocms/shared/sdk/types";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import {
  DEFAULT_PROJECT_SIDEBAR_VIEWS,
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
  analytics: present.includes("analytics"),
  cdn: present.includes("cdn"),
  experiments: present.includes("experiments"),
  calendar: present.includes("calendar"),
});

describe("project sidebar views", () => {
  test("covers every persisted sidebar id exactly once", () => {
    expect([...PROJECT_SIDEBAR_VIEW_IDS]).toEqual([
      ...VirtualMcpSidebarViewSchema.options,
    ]);
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
      nativePresence(["cdn", "assets", "e2e"]),
    );

    expect(availableProjectSidebarViews(presence)).toEqual([
      "overview",
      "reports",
      "board",
      "site-editor",
      "assets",
      "e2e",
      "cdn",
      "automations",
    ]);
  });

  test("gates experiments on a CMS source, not the flag alone", () => {
    // Flag on (native.experiments) but no clonable source → no experiments row.
    expect(
      availableProjectSidebarViews(
        projectSidebarViewPresence(false, nativePresence(["experiments"])),
      ),
    ).toEqual(["automations"]);
    // With a clonable source, the flag surfaces it.
    expect(
      availableProjectSidebarViews(
        projectSidebarViewPresence(true, nativePresence(["experiments"])),
      ),
    ).toEqual([
      "overview",
      "reports",
      "board",
      "site-editor",
      "experiments",
      "automations",
    ]);
  });

  test("keeps only automations when a project has no source or native views", () => {
    expect(
      availableProjectSidebarViews(
        projectSidebarViewPresence(false, nativePresence([])),
      ),
    ).toEqual(["automations"]);
  });

  test("keeps org destinations present while gating their project-scoped form", () => {
    const native = nativePresence([]);
    expect(
      availableProjectSidebarViews(
        projectMainViewPresence(null, false, native),
      ),
    ).toEqual(["overview", "reports", "board", "automations"]);
    expect(
      availableProjectSidebarViews(
        projectMainViewPresence("vir_1", false, native),
      ),
    ).toEqual(["automations"]);
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
    ).toEqual(["overview", "reports", "board", "site-editor", "automations"]);
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

  test("v7: an unversioned project's defaults never include Experiments, as before", () => {
    const presence = projectSidebarViewPresence(
      true,
      nativePresence(["experiments"]),
    );
    expect(DEFAULT_PROJECT_SIDEBAR_VIEWS).toEqual([
      "overview",
      "reports",
      "board",
      "site-editor",
    ]);
    expect(
      selectedProjectSidebarViews(
        undefined,
        presence,
        undefined,
        offeredProjectSidebarViews(undefined, false),
      ),
    ).toEqual(["overview", "reports", "board", "site-editor"]);
  });

  test("v8: an unversioned project also shows Experiments and Calendar", () => {
    const presence = projectSidebarViewPresence(
      true,
      nativePresence(["experiments", "calendar"]),
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
      "reports",
      "board",
      "site-editor",
      "calendar",
      "experiments",
    ]);
  });

  test("treats versioned null and empty selections as an explicit all-off", () => {
    expect(effectiveProjectSidebarViews(null, 1)).toEqual([]);
    expect(effectiveProjectSidebarViews([], 1)).toEqual([]);
  });

  test("requires both presence and selection", () => {
    const presence = projectSidebarViewPresence(
      true,
      nativePresence(["assets", "e2e", "cdn"]),
    );
    expect(
      selectedProjectSidebarViews(
        ["board", "cdn", "assets", "hosting", "automations"],
        presence,
        1,
      ),
    ).toEqual(["board", "assets", "cdn", "automations"]);
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
        ["cdn", "overview", "cdn", "automations"],
        "overview",
        false,
        1,
      ),
    ).toEqual(["cdn", "automations"]);
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

  test("keeps a Releases deep link while main's schema is being read", () => {
    const none = projectSidebarViewPresence(true, nativePresence([]));
    const settled = { assets: false, siteAccess: false };

    expect(
      projectSidebarViewUnavailable("releases", none, {
        ...settled,
        releases: true,
      }),
    ).toBe(false);
    expect(projectSidebarViewUnavailable("releases", none, settled)).toBe(true);
    const v8 = projectSidebarViewPresence(true, nativePresence(["releases"]));
    expect(projectSidebarViewUnavailable("releases", v8, settled)).toBe(false);
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

describe("Calendar and Experiments on a Blocks (v8) site", () => {
  test("show by default as peers of the Site Editor where the site has them", () => {
    const v8 = projectSidebarViewPresence(
      true,
      nativePresence(["experiments", "calendar"]),
    );
    expect(
      selectedProjectSidebarViews(
        undefined,
        v8,
        undefined,
        offeredProjectSidebarViews(undefined, true),
      ),
    ).toEqual([
      "overview",
      "reports",
      "board",
      "site-editor",
      "calendar",
      "experiments",
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
    const v8 = projectSidebarViewPresence(
      true,
      nativePresence(["experiments", "calendar"]),
    );
    expect(
      selectedProjectSidebarViews(["site-editor", "experiments"], v8, 1),
    ).toEqual(["site-editor", "experiments"]);
  });

  test("a Calendar deep link waits while main's schema is read", () => {
    const presence = projectSidebarViewPresence(true, nativePresence([]));
    expect(
      projectSidebarViewUnavailable("calendar", presence, {
        assets: false,
        siteAccess: false,
        calendar: true,
      }),
    ).toBe(false);
    expect(
      projectSidebarViewUnavailable("calendar", presence, {
        assets: false,
        siteAccess: false,
        calendar: false,
      }),
    ).toBe(true);
  });
});

describe("Experiments and Calendar added once to a Blocks site's saved list", () => {
  const v8 = projectSidebarViewPresence(
    true,
    nativePresence(["experiments", "calendar"]),
  );
  const saved = ["site-editor", "releases"] as const;

  test("a list saved before they were defaults gets them on a Blocks site", () => {
    const offered = offeredProjectSidebarViews(undefined, true);
    expect(offered).toEqual(["calendar", "experiments"]);
    expect(selectedProjectSidebarViews(saved, v8, 1, offered)).toEqual([
      "site-editor",
      "calendar",
      "experiments",
    ]);
  });

  test("never on a v7 site", () => {
    expect(offeredProjectSidebarViews(undefined, false)).toEqual([]);
    const v7 = projectSidebarViewPresence(
      true,
      nativePresence(["experiments"]),
    );
    expect(
      selectedProjectSidebarViews(
        saved,
        v7,
        1,
        offeredProjectSidebarViews(undefined, false),
      ),
    ).toEqual(["site-editor"]);
  });

  test("once: after a save, hiding one sticks", () => {
    // The editor sees both offered, and hides Calendar.
    const shown = effectiveProjectSidebarViews(
      saved,
      1,
      offeredProjectSidebarViews(undefined, true),
    );
    const next = toggleProjectSidebarView(shown, "calendar", false, 1);
    const seen = seenProjectSidebarViewsAfterSave(undefined, true);
    expect(seen).toEqual(["calendar", "experiments"]);
    // Read back: nothing is offered again, the saved list decides.
    const offered = offeredProjectSidebarViews(seen, true);
    expect(offered).toEqual([]);
    expect(selectedProjectSidebarViews(next, v8, 1, offered)).toEqual([
      "site-editor",
      "experiments",
    ]);
  });

  test("a save on a v7 site leaves them to offer once it becomes a Blocks site", () => {
    expect(seenProjectSidebarViewsAfterSave(undefined, false)).toBeUndefined();
    expect(seenProjectSidebarViewsAfterSave(null, false)).toBeNull();
    expect(seenProjectSidebarViewsAfterSave(["calendar"], false)).toEqual([
      "calendar",
    ]);
    expect(offeredProjectSidebarViews(["calendar"], true)).toEqual([
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
    const noCalendar = projectSidebarViewPresence(
      true,
      nativePresence(["experiments"]),
    );
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
