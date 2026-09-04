import type { VirtualMcpSidebarView } from "@decocms/shared/sdk/types";

/** Every project-controlled sidebar row, in the order the sidebar renders it. */
export const PROJECT_SIDEBAR_VIEW_IDS = [
  "overview",
  "reports",
  "board",
  "site-editor",
  "assets",
  "hosting",
  "e2e",
  "analytics",
  "cdn",
  "automations",
] as const satisfies readonly VirtualMcpSidebarView[];

/** Initial selection for projects that have not explicitly saved sidebar
 * preferences yet. */
export const DEFAULT_PROJECT_SIDEBAR_VIEWS = [
  "overview",
  "reports",
  "board",
  "site-editor",
] as const satisfies readonly VirtualMcpSidebarView[];

/** Unversioned values came from the first native-only rollout, in which core
 * rows were not configurable and therefore remained implicitly enabled. */
export const PROJECT_SIDEBAR_VIEWS_VERSION = 1 as const;

export type ProjectSidebarViewId = (typeof PROJECT_SIDEBAR_VIEW_IDS)[number];

/** The project's navigation spine. These destinations exist for every project
 * and are therefore never offered as optional Layout switches. */
const STRUCTURAL_PROJECT_SIDEBAR_VIEW_IDS = [
  "overview",
  "reports",
  "board",
] as const satisfies readonly ProjectSidebarViewId[];

function isStructuralProjectSidebarView(viewId: ProjectSidebarViewId): boolean {
  return viewId === "overview" || viewId === "reports" || viewId === "board";
}

/** Native panels whose availability is discovered from project resources. */
export const PROJECT_NATIVE_VIEW_IDS = [
  "assets",
  "hosting",
  "e2e",
  "analytics",
  "cdn",
] as const satisfies readonly ProjectSidebarViewId[];

export type ProjectNativeViewId = (typeof PROJECT_NATIVE_VIEW_IDS)[number];

export type ProjectNativeViewPresence = Record<ProjectNativeViewId, boolean>;
export type ProjectSidebarViewPresence = Record<ProjectSidebarViewId, boolean>;

export interface ProjectNativeViewPending {
  assets: boolean;
  siteAccess: boolean;
}

export interface ProjectSidebarViewsMetadata {
  /** Canonical location for optional rows. Home, Reports, and Tasks are
   * structural and cannot be disabled even if an older value omits them. */
  sidebarViews?: readonly VirtualMcpSidebarView[] | null;
  sidebarViewsVersion?: typeof PROJECT_SIDEBAR_VIEWS_VERSION;
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
 * Organization routes use the Super Agent as their shell entity and have no
 * project scope. Agent routes name that project as both the shell and scope;
 * resolve it from the non-blocking project list when possible, otherwise reuse
 * the already loaded shell entity. Fail open as org-level while an unexpected
 * non-blocking scope is unresolved.
 */
export function resolveProjectMainViewProject<
  T extends { readonly id: string },
>(
  scopeId: string | null,
  scopedProject: T | null | undefined,
  shellEntity: T | null | undefined,
): T | null {
  if (!scopeId) return shellEntity ?? null;

  return scopedProject?.id === scopeId
    ? scopedProject
    : shellEntity?.id === scopeId
      ? shellEntity
      : null;
}

/** Read the canonical setting, falling back only when it is truly absent. */
export function resolveProjectSidebarViews(
  metadata: ProjectSidebarViewsMetadata | null | undefined,
): readonly VirtualMcpSidebarView[] | null | undefined {
  if (metadata?.sidebarViews !== undefined) return metadata.sidebarViews;
  return metadata?.ui?.layout?.sidebarViews;
}

/** Apply the compatibility default without conflating it with explicit null or
 * an empty selection. */
export function effectiveProjectSidebarViews(
  sidebarViews: readonly VirtualMcpSidebarView[] | null | undefined,
  version?: number | null,
): readonly VirtualMcpSidebarView[] {
  const selected = new Set(sidebarViews ?? []);
  for (const viewId of STRUCTURAL_PROJECT_SIDEBAR_VIEW_IDS) {
    selected.add(viewId);
  }
  if (version !== PROJECT_SIDEBAR_VIEWS_VERSION) {
    for (const viewId of DEFAULT_PROJECT_SIDEBAR_VIEWS) selected.add(viewId);
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

/** Combine permanent project capabilities with the five resource-backed
 * native panels. */
export function projectSidebarViewPresence(
  hasClonableSource: boolean,
  native: ProjectNativeViewPresence,
): ProjectSidebarViewPresence {
  return {
    overview: true,
    reports: true,
    board: true,
    "site-editor": hasClonableSource,
    assets: native.assets,
    hosting: native.hosting,
    e2e: native.e2e,
    analytics: native.analytics,
    cdn: native.cdn,
    automations: true,
  };
}

/** Keep selected views in stable sidebar order and apply runtime presence. */
export function selectedProjectSidebarViews(
  sidebarViews: readonly VirtualMcpSidebarView[] | null | undefined,
  presence: ProjectSidebarViewPresence,
  version?: number | null,
): ProjectSidebarViewId[] {
  const selected = new Set(effectiveProjectSidebarViews(sidebarViews, version));
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
  if (enabled || !defaultMainView || isStructuralProjectSidebarView(viewId)) {
    return defaultMainView;
  }

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
  return PROJECT_SIDEBAR_VIEW_IDS.filter(
    (viewId) => !isStructuralProjectSidebarView(viewId) && presence[viewId],
  );
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
  return !(viewId === "assets" ? pending.assets : pending.siteAccess);
}

/** Decide whether an already-matched project route must fall back to another
 * view. Canonical Overview remains the agent root, and Site Editor Preview owns
 * a useful connect-source empty state, even without source. This does not make
 * either sidebar row or persisted default available: those keep using
 * `projectSidebarViewUnavailable` directly. Content and Code have their own
 * surface-capability guards in the tab-state resolver. */
export function projectActiveViewUnavailable(
  viewId: string | null | undefined,
  presence: ProjectSidebarViewPresence,
  pending: ProjectNativeViewPending,
): boolean {
  return (
    viewId !== "overview" &&
    viewId !== "site-editor" &&
    projectSidebarViewUnavailable(viewId, presence, pending)
  );
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
  if (isStructuralProjectSidebarView(viewId)) {
    return PROJECT_SIDEBAR_VIEW_IDS.filter((id) => selected.has(id));
  }
  if (enabled) selected.add(viewId);
  else selected.delete(viewId);
  return PROJECT_SIDEBAR_VIEW_IDS.filter((id) => selected.has(id));
}
