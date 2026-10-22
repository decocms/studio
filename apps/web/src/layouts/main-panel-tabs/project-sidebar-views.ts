import type { VirtualMcpSidebarView } from "@decocms/shared/sdk/types";

/** Every project-controlled sidebar row, in the order the sidebar renders it. */
export const PROJECT_SIDEBAR_VIEW_IDS = [
  "overview",
  "reports",
  "board",
  "site-editor",
  "assets",
  "releases",
  "hosting",
  "e2e",
  "analytics",
  "cdn",
  "automations",
  "experiments",
  "calendar",
] as const satisfies readonly VirtualMcpSidebarView[];

/** Initial selection for projects that have not explicitly saved sidebar
 * preferences yet. Experiments and Calendar are peers of the Site Editor on a
 * Blocks (v8) site (their presence gates keep them off where they don't
 * apply: Calendar is v8-only). */
export const DEFAULT_PROJECT_SIDEBAR_VIEWS = [
  "overview",
  "reports",
  "board",
  "site-editor",
  "experiments",
  "calendar",
] as const satisfies readonly VirtualMcpSidebarView[];

/** Unversioned values came from the first native-only rollout, in which core
 * rows were not configurable and therefore remained implicitly enabled. */
export const PROJECT_SIDEBAR_VIEWS_VERSION = 1 as const;

/**
 * Views a Blocks (v8) site gets once on top of a list saved before they were
 * defaults (PO decision): its A/B tests and campaigns are content its editors
 * own. Offered until the project's next sidebar save records them in
 * `sidebarViewsSeen`; from then on the saved list alone decides, so hiding
 * one sticks. A v7 site is never offered them.
 */
const BLOCKS_SITE_SIDEBAR_VIEWS = [
  "experiments",
  "calendar",
] as const satisfies readonly ProjectSidebarViewId[];

/**
 * The views to add once to this project's saved list: the Blocks site views
 * it hasn't seen yet, on a Blocks site; none elsewhere. Pass the result to
 * {@link effectiveProjectSidebarViews} and friends.
 */
export function offeredProjectSidebarViews(
  seen: readonly VirtualMcpSidebarView[] | null | undefined,
  blocksSite: boolean,
): ProjectSidebarViewId[] {
  if (!blocksSite) return [];
  const already = new Set(seen ?? []);
  return BLOCKS_SITE_SIDEBAR_VIEWS.filter((view) => !already.has(view));
}

/**
 * `sidebarViewsSeen` to save with a sidebar change: on a Blocks site, the
 * offered views are seen now (the list the change was made on had them), so
 * the saved list decides from then on. Elsewhere it stays as it was, so a
 * site that becomes a Blocks site still gets them once.
 */
export function seenProjectSidebarViewsAfterSave(
  seen: readonly VirtualMcpSidebarView[] | null | undefined,
  blocksSite: boolean,
): VirtualMcpSidebarView[] | null | undefined {
  if (!blocksSite) return seen === null ? null : seen ? [...seen] : seen;
  const next = new Set<VirtualMcpSidebarView>([
    ...(seen ?? []),
    ...BLOCKS_SITE_SIDEBAR_VIEWS,
  ]);
  return PROJECT_SIDEBAR_VIEW_IDS.filter((view) => next.has(view));
}

export type ProjectSidebarViewId = (typeof PROJECT_SIDEBAR_VIEW_IDS)[number];

/** Native panels whose availability is discovered from project resources. */
export const PROJECT_NATIVE_VIEW_IDS = [
  "assets",
  "releases",
  "hosting",
  "e2e",
  "analytics",
  "cdn",
  "experiments",
  "calendar",
] as const satisfies readonly ProjectSidebarViewId[];

export type ProjectNativeViewId = (typeof PROJECT_NATIVE_VIEW_IDS)[number];

export type ProjectNativeViewPresence = Record<ProjectNativeViewId, boolean>;
export type ProjectSidebarViewPresence = Record<ProjectSidebarViewId, boolean>;

export interface ProjectNativeViewPending {
  assets: boolean;
  siteAccess: boolean;
  /** Main's schema is not read yet (or can't be, on a site last found v8),
   *  so whether the site has Releases is not known. */
  releases?: boolean;
  /** Main's schema is not read yet, so whether the site is v8 (and has a
   *  Calendar) is not known. */
  calendar?: boolean;
}

export interface ProjectSidebarViewsMetadata {
  /** Canonical location. With version 1, null or [] disables every row. */
  sidebarViews?: readonly VirtualMcpSidebarView[] | null;
  sidebarViewsVersion?: typeof PROJECT_SIDEBAR_VIEWS_VERSION;
  /** Views offered once on top of the saved list (see BLOCKS_SITE_SIDEBAR_VIEWS). */
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
  for (const viewId of offered) selected.add(viewId);
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
    reports: hasClonableSource,
    board: hasClonableSource,
    "site-editor": hasClonableSource,
    assets: native.assets,
    // Hosted Deco CMS releases: a v8 site's repo history.
    releases: hasClonableSource && native.releases,
    hosting: native.hosting,
    e2e: native.e2e,
    analytics: native.analytics,
    cdn: native.cdn,
    // Authored in the Site Editor decofile — only where a CMS source exists.
    experiments: hasClonableSource && native.experiments,
    // A v8 site's campaigns block, edited in the same draft as the pages.
    calendar: hasClonableSource && native.calendar,
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
  if (!isProjectNativeViewId(viewId)) return true;
  // Releases follows main's schema (`useMainSchemaV8`): a deep link waits
  // for that read instead of bouncing to Settings before it lands.
  if (viewId === "releases") return !pending.releases;
  if (viewId === "calendar") return !pending.calendar;
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
