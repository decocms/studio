import type { VirtualMcpSidebarView } from "@decocms/shared/sdk/types";

/** Every project-controlled sidebar row, in the order the sidebar renders it. */
export const PROJECT_SIDEBAR_VIEW_IDS = [
  "overview",
  "context",
  "monitor",
  "plan",
  "reports",
  "board",
  "site-editor",
  "calendar",
  "experiments",
  "blog",
  "assets",
  "releases",
  "hosting",
  "e2e",
  "automations",
] as const satisfies readonly VirtualMcpSidebarView[];

/** Initial selection for projects that have not explicitly saved sidebar
 * preferences yet. A Blocks v8 project also gets Calendar and Experiments,
 * peers of its Site Editor, through {@link offeredProjectSidebarViews}. */
export const DEFAULT_PROJECT_SIDEBAR_VIEWS = [
  "overview",
  "reports",
  "board",
  "site-editor",
  "blog",
] as const satisfies readonly VirtualMcpSidebarView[];

/** Unversioned values came from the first native-only rollout, in which core
 * rows were not configurable and therefore remained implicitly enabled. */
export const PROJECT_SIDEBAR_VIEWS_VERSION = 1 as const;

/** A project's top rows (`nav-destinations.tsx`), offered once to every saved list since they predate hiding. */
export const PROJECT_NAV_VIEW_IDS = [
  "overview",
  "context",
  "monitor",
  "plan",
  "board",
] as const satisfies readonly ProjectSidebarViewId[];

export type ProjectNavViewId = (typeof PROJECT_NAV_VIEW_IDS)[number];

/**
 * Views a project gets once on top of a list saved before they existed: a
 * selection made without a row could not have turned it off. Offered while
 * the org has them on (Blog: `blog_view_enabled`) until the project's next
 * sidebar save records them in `sidebarViewsSeen`; from then on the saved list
 * alone decides, so hiding one sticks.
 */
const ADDED_SIDEBAR_VIEWS = [
  "blog",
] as const satisfies readonly ProjectSidebarViewId[];

/**
 * Views a Blocks (v8) site gets once on top of a list saved before they were
 * defaults (PO decision): its campaigns and A/B tests are content its
 * editors own. Offered and recorded like {@link ADDED_SIDEBAR_VIEWS}, but a v7
 * site is never offered them.
 */
const BLOCKS_SITE_SIDEBAR_VIEWS = [
  "calendar",
  "experiments",
] as const satisfies readonly ProjectSidebarViewId[];

/** A hosted site's settings (env vars, domains, deploys), offered once the
 * same way, and only beside a Site Editor the project shows. */
const HOSTED_SITE_SIDEBAR_VIEWS = [
  "hosting",
] as const satisfies readonly ProjectSidebarViewId[];

/** Presence the offers depend on: `calendar` marks a Blocks site, `blog` an
 * org with the Blog view on. */
export type ProjectSidebarOfferPresence = Pick<
  ProjectSidebarViewPresence,
  "calendar" | "hosting" | "site-editor" | "blog"
>;

const NO_SITE_OFFERS: ProjectSidebarOfferPresence = {
  calendar: false,
  hosting: false,
  "site-editor": false,
  blog: false,
};

function offerableProjectSidebarViews(
  presence: ProjectSidebarOfferPresence,
): readonly ProjectSidebarViewId[] {
  return [
    ...PROJECT_NAV_VIEW_IDS,
    ...(presence.calendar ? BLOCKS_SITE_SIDEBAR_VIEWS : []),
    ...(presence.hosting && presence["site-editor"]
      ? HOSTED_SITE_SIDEBAR_VIEWS
      : []),
    ...(presence.blog ? ADDED_SIDEBAR_VIEWS : []),
  ];
}

/** Offerable views this project hasn't seen yet; pass to {@link effectiveProjectSidebarViews}. */
export function offeredProjectSidebarViews(
  seen: readonly VirtualMcpSidebarView[] | null | undefined,
  presence: ProjectSidebarOfferPresence,
): ProjectSidebarViewId[] {
  const already = new Set(seen ?? []);
  return offerableProjectSidebarViews(presence).filter(
    (view) => !already.has(view),
  );
}

/** `sidebarViewsSeen` after saving `saved`; site views stay unseen until the
 * site has them, and Hosting until the Site Editor is shown beside it. */
export function seenProjectSidebarViewsAfterSave(
  seen: readonly VirtualMcpSidebarView[] | null | undefined,
  presence: ProjectSidebarOfferPresence,
  saved: readonly VirtualMcpSidebarView[],
): VirtualMcpSidebarView[] {
  const next = new Set<VirtualMcpSidebarView>([
    ...(seen ?? []),
    ...offerableProjectSidebarViews({
      ...presence,
      "site-editor": presence["site-editor"] && saved.includes("site-editor"),
    }),
  ]);
  return PROJECT_SIDEBAR_VIEW_IDS.filter((view) => next.has(view));
}

/** The top rows a project shows; every row until the project loads. */
export function selectedProjectNavViews(
  metadata: ProjectSidebarViewsMetadata | null | undefined,
  pending: readonly VirtualMcpSidebarView[] | undefined,
): ReadonlySet<ProjectNavViewId> {
  if (!metadata && pending === undefined) return new Set(PROJECT_NAV_VIEW_IDS);
  const selected = new Set(
    pending !== undefined
      ? effectiveProjectSidebarViews(pending, PROJECT_SIDEBAR_VIEWS_VERSION)
      : effectiveProjectSidebarViews(
          resolveProjectSidebarViews(metadata),
          metadata?.sidebarViewsVersion,
          offeredProjectSidebarViews(
            metadata?.sidebarViewsSeen,
            NO_SITE_OFFERS,
          ),
        ),
  );
  return new Set(PROJECT_NAV_VIEW_IDS.filter((view) => selected.has(view)));
}

export type ProjectSidebarViewId = (typeof PROJECT_SIDEBAR_VIEW_IDS)[number];

/** Native panels whose availability is discovered from project resources. */
const PROJECT_NATIVE_VIEW_IDS = [
  "calendar",
  "experiments",
  "assets",
  "releases",
  "hosting",
  "e2e",
] as const satisfies readonly ProjectSidebarViewId[];

export type ProjectNativeViewId = (typeof PROJECT_NATIVE_VIEW_IDS)[number];

export type ProjectNativeViewPresence = Record<ProjectNativeViewId, boolean> & {
  /** The org's Blog view (`blog_view_enabled`), a product rollout rather than a
   *  resource: no native panel of its own. */
  blog?: boolean;
};
export type ProjectSidebarViewPresence = Record<ProjectSidebarViewId, boolean>;

export interface ProjectNativeViewPending {
  assets: boolean;
  siteAccess: boolean;
  /** The org's flags are loading, so whether Blog is on is not known yet. */
  blog?: boolean;
}

export interface ProjectSidebarViewsMetadata {
  /** Canonical location. With version 1, null or [] disables every row. */
  sidebarViews?: readonly VirtualMcpSidebarView[] | null;
  sidebarViewsVersion?: typeof PROJECT_SIDEBAR_VIEWS_VERSION;
  /** Views offered once on top of the saved list (see ADDED_SIDEBAR_VIEWS). */
  sidebarViewsSeen?: readonly VirtualMcpSidebarView[] | null;
  /** Deprecated location, retained only while persisted agents migrate. */
  ui?: {
    layout?: {
      sidebarViews?: readonly VirtualMcpSidebarView[] | null;
    } | null;
  } | null;
}

interface ProjectDefaultMainView {
  type: string;
  id?: string;
  toolName?: string;
}

/** Resolve the entity whose capabilities govern a main-panel project view.
 *
 * Destination routes such as Tasks and Reports keep the org Super Agent as
 * their shell entity while `?virtualmcpid=` selects the project they display.
 * Agent routes instead name that project as both the shell and the scope. Use
 * the resolved scoped project in the former case, reuse the shell in the
 * latter, and fail open as org-level while a non-blocking scope is unresolved.
 */
export function resolveProjectMainViewContext<
  T extends { readonly id: string },
>(
  scopeId: string | null,
  scopedProject: T | null | undefined,
  shellEntity: T | null | undefined,
): { project: T | null; resolvedScopeId: string | null } {
  if (!scopeId) {
    return { project: shellEntity ?? null, resolvedScopeId: null };
  }

  const project =
    scopedProject?.id === scopeId
      ? scopedProject
      : shellEntity?.id === scopeId
        ? shellEntity
        : null;
  return {
    project,
    resolvedScopeId: project ? scopeId : null,
  };
}

/** Read the canonical setting, falling back only when it is truly absent. */
export function resolveProjectSidebarViews(
  metadata: ProjectSidebarViewsMetadata | null | undefined,
): readonly VirtualMcpSidebarView[] | null | undefined {
  if (metadata?.sidebarViews !== undefined) return metadata.sidebarViews;
  return metadata?.ui?.layout?.sidebarViews;
}

/** Apply the compatibility default without conflating it with explicit null or
 * an empty selection. `offered` (see {@link offeredProjectSidebarViews}) adds
 * views once on top of an exact list. */
export function effectiveProjectSidebarViews(
  sidebarViews: readonly VirtualMcpSidebarView[] | null | undefined,
  version?: number | null,
  offered: readonly ProjectSidebarViewId[] = [],
): readonly VirtualMcpSidebarView[] {
  const selected = new Set(sidebarViews ?? []);
  if (version !== PROJECT_SIDEBAR_VIEWS_VERSION) {
    for (const viewId of DEFAULT_PROJECT_SIDEBAR_VIEWS) selected.add(viewId);
  }
  for (const viewId of offered) {
    if (viewId === "hosting" && !selected.has("site-editor")) continue;
    selected.add(viewId);
  }
  return PROJECT_SIDEBAR_VIEW_IDS.filter((viewId) => selected.has(viewId));
}

export function isProjectSidebarViewId(
  value: string | null | undefined,
): value is ProjectSidebarViewId {
  return PROJECT_SIDEBAR_VIEW_IDS.some((viewId) => viewId === value);
}

export function isProjectNativeViewId(
  value: string | null | undefined,
): value is ProjectNativeViewId {
  return PROJECT_NATIVE_VIEW_IDS.some((viewId) => viewId === value);
}

/** Combine permanent project capabilities with the resource-backed native
 * panels. */
export function projectSidebarViewPresence(
  hasClonableSource: boolean,
  native: ProjectNativeViewPresence,
): ProjectSidebarViewPresence {
  return {
    overview: hasClonableSource,
    // Overview and Board stay source-gated above: they are also main views.
    context: true,
    monitor: true,
    plan: true,
    reports: hasClonableSource,
    board: hasClonableSource,
    "site-editor": hasClonableSource,
    /** The org's Blog view, with the Site Editor's source requirement: blog
     *  records are decofile blocks. Whether the site actually has a blog app is
     *  the view's own empty state to explain — a row whose existence waits on a
     *  decofile read would blink in, or never appear. */
    blog: hasClonableSource && native.blog === true,
    assets: native.assets,
    // Hosted Deco CMS releases: a v8 site's repo history.
    releases: hasClonableSource && native.releases,
    hosting: native.hosting,
    e2e: native.e2e,
    // A v8 site's campaigns block, edited in the same draft as the pages.
    calendar: hasClonableSource && native.calendar,
    // A v8 site's A/B tests block, edited in the same draft too.
    experiments: hasClonableSource && native.experiments,
    automations: true,
  };
}

/** Main-panel routes also serve organization-level Home/Reports/Tasks. Those
 * destinations remain available without project scope; only their scoped form
 * inherits the project's source requirement. */
export function projectMainViewPresence(
  scopeId: string | null,
  hasClonableSource: boolean,
  native: ProjectNativeViewPresence,
): ProjectSidebarViewPresence {
  const presence = projectSidebarViewPresence(hasClonableSource, native);
  if (scopeId) return presence;
  return { ...presence, overview: true, reports: true, board: true };
}

/** Keep selected views in stable sidebar order and apply runtime presence. */
export function selectedProjectSidebarViews(
  sidebarViews: readonly VirtualMcpSidebarView[] | null | undefined,
  presence: ProjectSidebarViewPresence,
  version?: number | null,
  offered: readonly ProjectSidebarViewId[] = [],
): ProjectSidebarViewId[] {
  const selected = new Set(
    effectiveProjectSidebarViews(sidebarViews, version, offered),
  );
  return PROJECT_SIDEBAR_VIEW_IDS.filter(
    (viewId) => presence[viewId] && selected.has(viewId),
  );
}

/** Keep the landing view aligned with the sidebar rows that can reach it.
 * Preview, Content and Code are all entry points into the Site Editor row. */
export function defaultMainViewAfterSidebarToggle(
  defaultMainView: ProjectDefaultMainView | null | undefined,
  viewId: ProjectSidebarViewId,
  enabled: boolean,
): ProjectDefaultMainView | null | undefined {
  if (enabled || !defaultMainView) return defaultMainView;

  const defaultViewId =
    defaultMainView.type === "preview" ||
    defaultMainView.type === "content" ||
    defaultMainView.type === "code"
      ? "site-editor"
      : defaultMainView.type;
  return defaultViewId === viewId ? { type: "settings" } : defaultMainView;
}

export function availableProjectSidebarViews(
  presence: ProjectSidebarViewPresence,
): ProjectSidebarViewId[] {
  return PROJECT_SIDEBAR_VIEW_IDS.filter((viewId) => presence[viewId]);
}

/** Reject an absent project view while keeping a native route stable during
 * resource discovery. Source-backed rows resolve synchronously. */
export function projectSidebarViewUnavailable(
  viewId: string | null | undefined,
  presence: ProjectSidebarViewPresence,
  pending: ProjectNativeViewPending,
): boolean {
  if (!isProjectSidebarViewId(viewId) || presence[viewId]) return false;
  // Held while the org's flags load, so a Blog link isn't sent away first.
  if (viewId === "blog") return pending.blog !== true;
  if (!isProjectNativeViewId(viewId)) return true;
  // Releases, Calendar and Experiments are a v8 project's (its switch, known
  // with the project): nothing to wait for.
  if (
    viewId === "releases" ||
    viewId === "calendar" ||
    viewId === "experiments"
  ) {
    return true;
  }
  return !(viewId === "assets" ? pending.assets : pending.siteAccess);
}

/** Validate a persisted built-in landing view, including retired Preview and
 * the Content/Code subviews that belong to Site Editor. Ext-app types pass
 * through because their ids are a separate namespace. */
export function projectDefaultViewUnavailable(
  viewType: string | null | undefined,
  presence: ProjectSidebarViewPresence,
  pending: ProjectNativeViewPending,
  surfaceViews: readonly string[],
  runtimeResolved: boolean,
): boolean {
  const presenceViewType =
    viewType === "preview" || viewType === "content" || viewType === "code"
      ? "site-editor"
      : viewType;
  return (
    projectSidebarViewUnavailable(presenceViewType, presence, pending) ||
    (viewType === "content" && !surfaceViews.includes("content")) ||
    (viewType === "code" && runtimeResolved && !surfaceViews.includes("code"))
  );
}

/** Apply one switch change and normalize the persisted list at the boundary. */
export function toggleProjectSidebarView(
  sidebarViews: readonly VirtualMcpSidebarView[] | null | undefined,
  viewId: ProjectSidebarViewId,
  enabled: boolean,
  version?: number | null,
): ProjectSidebarViewId[] {
  const selected = new Set(effectiveProjectSidebarViews(sidebarViews, version));
  if (enabled) selected.add(viewId);
  else selected.delete(viewId);
  return PROJECT_SIDEBAR_VIEW_IDS.filter((id) => selected.has(id));
}
