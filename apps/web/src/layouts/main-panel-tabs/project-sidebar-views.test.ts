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
  projectActiveViewUnavailable,
  projectDefaultViewUnavailable,
  projectSidebarViewPresence,
  projectSidebarViewUnavailable,
  resolveProjectMainViewProject,
  resolveProjectSidebarViews,
  selectedProjectSidebarViews,
  toggleProjectSidebarView,
  type ProjectNativeViewPresence,
} from "./project-sidebar-views";

const nativePresence = (
  present: Array<keyof ProjectNativeViewPresence>,
): ProjectNativeViewPresence => ({
  assets: present.includes("assets"),
  hosting: present.includes("hosting"),
  e2e: present.includes("e2e"),
  analytics: present.includes("analytics"),
  cdn: present.includes("cdn"),
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
      "site-editor",
      "assets",
      "e2e",
      "cdn",
      "automations",
    ]);
  });

  test("offers only optional destinations when a project has no source or native views", () => {
    expect(
      availableProjectSidebarViews(
        projectSidebarViewPresence(false, nativePresence([])),
      ),
    ).toEqual(["automations"]);
  });

  test("uses the scoped project instead of the org shell for destination main views", () => {
    const shell = { id: "decopilot", metadata: {} };
    const project = {
      id: "vir_project",
      metadata: { githubRepo: { url: "https://github.com/deco/site" } },
    };

    const resolvedProject = resolveProjectMainViewProject(
      project.id,
      project,
      shell,
    );
    expect(resolvedProject).toBe(project);
    expect(
      availableProjectSidebarViews(
        projectSidebarViewPresence(
          agentHasClonableSource(resolvedProject?.metadata),
          nativePresence([]),
        ),
      ),
    ).toEqual(["site-editor", "automations"]);
  });

  test("reuses an agent-route shell and fails open while a destination scope resolves", () => {
    const project = { id: "vir_project" };

    expect(resolveProjectMainViewProject(project.id, null, project)).toBe(
      project,
    );
    expect(
      resolveProjectMainViewProject(project.id, null, { id: "decopilot" }),
    ).toBeNull();
  });

  test("uses the four-view initial selection for unversioned projects", () => {
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

  test("keeps structural Home, Reports, and Tasks when every optional row is off", () => {
    expect(effectiveProjectSidebarViews(null, 1)).toEqual([
      "overview",
      "reports",
      "board",
    ]);
    expect(effectiveProjectSidebarViews([], 1)).toEqual([
      "overview",
      "reports",
      "board",
    ]);
  });

  test("forces structural rows and requires presence plus selection for optional rows", () => {
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
    ).toEqual(["overview", "reports", "board", "assets", "cdn", "automations"]);
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
    expect(
      defaultMainViewAfterSidebarToggle({ type: "reports" }, "reports", false),
    ).toEqual({ type: "reports" });
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
    ).toEqual(["overview", "reports", "board", "cdn", "automations"]);
  });

  test("never disables a structural project destination", () => {
    for (const viewId of ["overview", "reports", "board"] as const) {
      expect(toggleProjectSidebarView(["assets"], viewId, false, 1)).toEqual([
        "overview",
        "reports",
        "board",
        "assets",
      ]);
    }
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

  test("rejects only source-backed views when source is absent", () => {
    const none = projectSidebarViewPresence(false, nativePresence([]));
    const pending = { assets: true, siteAccess: true };

    expect(projectSidebarViewUnavailable("overview", none, pending)).toBe(
      false,
    );
    expect(projectSidebarViewUnavailable("reports", none, pending)).toBe(false);
    expect(projectSidebarViewUnavailable("board", none, pending)).toBe(false);
    expect(projectSidebarViewUnavailable("site-editor", none, pending)).toBe(
      true,
    );
    expect(projectSidebarViewUnavailable("automations", none, pending)).toBe(
      false,
    );
  });

  test("keeps explicitly matched source-less landing routes active", () => {
    const none = projectSidebarViewPresence(false, nativePresence([]));
    const pending = { assets: false, siteAccess: false };

    // Canonical Home is structural. Preview remains a useful route-owned body
    // even when its optional shortcut is unavailable without source.
    expect(projectSidebarViewUnavailable("overview", none, pending)).toBe(
      false,
    );
    expect(projectActiveViewUnavailable("overview", none, pending)).toBe(false);
    expect(projectSidebarViewUnavailable("site-editor", none, pending)).toBe(
      true,
    );
    expect(projectActiveViewUnavailable("site-editor", none, pending)).toBe(
      false,
    );

    // Tasks remains a useful read-only destination for exact linked runs.
    expect(projectActiveViewUnavailable("board", none, pending)).toBe(false);
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
