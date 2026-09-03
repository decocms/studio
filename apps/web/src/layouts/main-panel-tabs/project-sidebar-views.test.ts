import { describe, expect, test } from "bun:test";
import { VirtualMcpSidebarViewSchema } from "@decocms/shared/sdk/types";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import {
  DEFAULT_PROJECT_SIDEBAR_VIEWS,
  PROJECT_SIDEBAR_VIEW_IDS,
  availableProjectSidebarViews,
  effectiveProjectSidebarViews,
  isProjectNativeViewId,
  isProjectSidebarViewId,
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
      metadata: { githubRepo: { url: "https://github.com/deco/site" } },
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
