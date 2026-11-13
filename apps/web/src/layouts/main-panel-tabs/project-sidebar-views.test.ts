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
  type ProjectSidebarOfferPresence,
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
  blog: present.includes("blog"),
});

const offerPresence = (
  present: Array<keyof ProjectSidebarOfferPresence>,
): ProjectSidebarOfferPresence => ({
  calendar: present.includes("calendar"),
  hosting: present.includes("hosting"),
  "site-editor": present.includes("site-editor"),
  blog: present.includes("blog"),
});
const NO_SITE = offerPresence([]);
const BLOCKS = offerPresence(["calendar", "site-editor"]);
const HOSTED = offerPresence(["hosting", "site-editor"]);

/** The Blocks site views a project that already saw the top rows is offered. */
const blocksOffers = (seen: Array<"calendar" | "experiments"> = []) =>
  offeredProjectSidebarViews([...PROJECT_NAV_VIEW_IDS, ...seen], BLOCKS);

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
      "blog",
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
        offeredProjectSidebarViews(undefined, BLOCKS),
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
      "blog",
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
        offeredProjectSidebarViews(undefined, BLOCKS),
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
    expect(offeredProjectSidebarViews(PROJECT_NAV_VIEW_IDS, NO_SITE)).toEqual(
      [],
    );
    const v7 = projectSidebarViewPresence(true, nativePresence([]));
    expect(
      selectedProjectSidebarViews(
        saved,
        v7,
        1,
        offeredProjectSidebarViews(PROJECT_NAV_VIEW_IDS, NO_SITE),
      ),
    ).toEqual(["site-editor"]);
  });

  test("once: after a save, hiding it sticks", () => {
    // The editor sees Calendar offered, and hides it.
    const shown = effectiveProjectSidebarViews(saved, 1, blocksOffers());
    const next = toggleProjectSidebarView(shown, "calendar", false, 1);
    const seen = seenProjectSidebarViewsAfterSave(
      PROJECT_NAV_VIEW_IDS,
      BLOCKS,
      ["site-editor"],
    );
    expect(seen).toEqual([...PROJECT_NAV_VIEW_IDS, "calendar", "experiments"]);
    // Read back: nothing is offered again, the saved list decides.
    const offered = offeredProjectSidebarViews(seen, BLOCKS);
    expect(offered).toEqual([]);
    expect(selectedProjectSidebarViews(next, v8, 1, offered)).toEqual([
      "site-editor",
    ]);
  });

  test("a save on a v7 site leaves it to offer once it becomes a Blocks site", () => {
    const seen = seenProjectSidebarViewsAfterSave(undefined, NO_SITE, [
      "site-editor",
    ]);
    expect(seen).toEqual([...PROJECT_NAV_VIEW_IDS]);
    expect(
      seenProjectSidebarViewsAfterSave(null, NO_SITE, ["site-editor"]),
    ).toEqual(seen);
    expect(offeredProjectSidebarViews(seen, BLOCKS)).toEqual([
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
        offeredProjectSidebarViews(undefined, BLOCKS),
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
        offeredProjectSidebarViews(undefined, BLOCKS),
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
        offeredProjectSidebarViews(undefined, BLOCKS),
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
        offeredProjectSidebarViews(PROJECT_NAV_VIEW_IDS, NO_SITE),
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
      BLOCKS,
      ["site-editor"],
    );
    expect(seen).toEqual([...PROJECT_NAV_VIEW_IDS, "calendar", "experiments"]);
    const offered = offeredProjectSidebarViews(seen, BLOCKS);
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
    expect(offeredProjectSidebarViews(undefined, NO_SITE)).toEqual([
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
      offeredProjectSidebarViews(undefined, NO_SITE),
    );
    const next = toggleProjectSidebarView(shown, "overview", false, 1);
    const metadata = {
      sidebarViews: next,
      sidebarViewsVersion: 1 as const,
      sidebarViewsSeen: seenProjectSidebarViewsAfterSave(undefined, NO_SITE, [
        "site-editor",
      ]),
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

describe("hosted site views", () => {
  const HOSTED_NATIVE = nativePresence(["hosting"]);
  const hosted = projectSidebarViewPresence(true, HOSTED_NATIVE);

  test("Hosting is offered next to the Site Editor on a saved list", () => {
    const offered = offeredProjectSidebarViews(PROJECT_NAV_VIEW_IDS, HOSTED);
    expect(offered).toEqual(["hosting"]);
    expect(
      selectedProjectSidebarViews(["site-editor"], hosted, 1, offered),
    ).toEqual(["site-editor", "hosting"]);
  });

  test("an unhosted save does not consume the offer", () => {
    const seen = seenProjectSidebarViewsAfterSave(undefined, NO_SITE, [
      "site-editor",
    ]);
    expect(seen).not.toContain("hosting");
    expect(offeredProjectSidebarViews(seen, HOSTED)).toEqual(["hosting"]);
  });

  test("once: hidden after a save, it stays hidden", () => {
    const seen = seenProjectSidebarViewsAfterSave(undefined, HOSTED, [
      "site-editor",
    ]);
    expect(seen).toContain("hosting");
    const offered = offeredProjectSidebarViews(seen, HOSTED);
    expect(offered).toEqual([]);
    expect(
      selectedProjectSidebarViews(["site-editor"], hosted, 1, offered),
    ).toEqual(["site-editor"]);
  });

  test("not offered beside a hidden Site Editor", () => {
    const offered = offeredProjectSidebarViews(PROJECT_NAV_VIEW_IDS, HOSTED);
    expect(selectedProjectSidebarViews(["board"], hosted, 1, offered)).toEqual([
      "board",
    ]);
    const seen = seenProjectSidebarViewsAfterSave(undefined, HOSTED, ["board"]);
    expect(seen).not.toContain("hosting");
  });

  test("not offered without a Site Editor source", () => {
    const noSource = projectSidebarViewPresence(false, HOSTED_NATIVE);
    expect(offeredProjectSidebarViews(PROJECT_NAV_VIEW_IDS, noSource)).toEqual(
      [],
    );
  });
});

/**
 * Blog is the org's (`blog_view_enabled`). It arrived after projects could save
 * an exact list, and a list saved before it existed could not have turned it
 * off, so it is offered once on top of it, while the org has it on.
 */
describe("Blog view", () => {
  const withBlog = projectSidebarViewPresence(true, nativePresence(["blog"]));
  const BLOG = offerPresence(["blog"]);
  const saved = ["overview", "board"] as const;
  /** A list saved after the top rows became hideable: Blog alone is new. */
  const offered = offeredProjectSidebarViews(PROJECT_NAV_VIEW_IDS, BLOG);

  test("a list saved before Blog existed gets it, keeping its other opt-outs", () => {
    expect(offered).toEqual(["blog"]);
    expect(selectedProjectSidebarViews(saved, withBlog, 1, offered)).toEqual([
      "overview",
      "board",
      "blog",
    ]);
  });

  test("an all-off saved before Blog existed still offers it, once", () => {
    expect(effectiveProjectSidebarViews([], 1, offered)).toEqual(["blog"]);
    expect(effectiveProjectSidebarViews(null, 1, offered)).toEqual(["blog"]);
  });

  test("once: after a save, a hidden Blog stays hidden", () => {
    const shown = effectiveProjectSidebarViews(saved, 1, offered);
    const next = toggleProjectSidebarView(shown, "blog", false, 1);
    const seen = seenProjectSidebarViewsAfterSave(
      PROJECT_NAV_VIEW_IDS,
      BLOG,
      next,
    );
    expect(
      selectedProjectSidebarViews(
        next,
        withBlog,
        1,
        offeredProjectSidebarViews(seen, BLOG),
      ),
    ).toEqual(["overview", "board"]);
  });

  test("with the org's flag off: no row, no offer, and a save keeps the offer", () => {
    const off = projectSidebarViewPresence(true, nativePresence([]));
    expect(off.blog).toBe(false);
    expect(offeredProjectSidebarViews(PROJECT_NAV_VIEW_IDS, NO_SITE)).toEqual(
      [],
    );
    expect(selectedProjectSidebarViews(["blog"], off, 1)).toEqual([]);
    const seen = seenProjectSidebarViewsAfterSave(undefined, NO_SITE, [
      "board",
    ]);
    expect(seen).not.toContain("blog");
    expect(offeredProjectSidebarViews(seen, BLOG)).toEqual(["blog"]);
  });

  test("needs a source, like the Site Editor", () => {
    const noSource = projectSidebarViewPresence(
      false,
      nativePresence(["blog"]),
    );
    expect(noSource.blog).toBe(false);
    expect(
      projectSidebarViewUnavailable("blog", noSource, {
        assets: false,
        siteAccess: false,
      }),
    ).toBe(true);
  });

  test("a Blog link waits while the org's flags load", () => {
    const loading = projectSidebarViewPresence(true, nativePresence([]));
    const settled = { assets: false, siteAccess: false };
    expect(
      projectSidebarViewUnavailable("blog", loading, {
        ...settled,
        blog: true,
      }),
    ).toBe(false);
    expect(projectSidebarViewUnavailable("blog", loading, settled)).toBe(true);
    expect(projectSidebarViewUnavailable("blog", withBlog, settled)).toBe(
      false,
    );
  });
});
