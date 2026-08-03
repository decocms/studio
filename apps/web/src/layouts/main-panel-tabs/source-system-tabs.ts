import { parseCodeTabId, parsePinnedViewTabId } from "./tab-id";

export interface SourceSystemTab {
  id: "preview" | "code";
  title: string;
}

const SOURCE_SYSTEM_TABS: readonly SourceSystemTab[] = [
  { id: "preview", title: "Preview" },
  { id: "code", title: "Code" },
];

export function getSourceSystemTabs(
  hasClonableSource: boolean,
  canMutateThread = true,
): SourceSystemTab[] {
  if (!hasClonableSource) return [];
  return canMutateThread
    ? [...SOURCE_SYSTEM_TABS]
    : SOURCE_SYSTEM_TABS.filter((tab) => tab.id === "preview");
}

/**
 * A read-only viewer must never fall through to an owner-only configured tab.
 * Preview is safe when source exists; otherwise use the non-runtime Settings
 * view.
 */
export function getViewerSafeFallbackTab(
  hasClonableSource: boolean,
): "preview" | "settings" {
  return hasClonableSource ? "preview" : "settings";
}

export function resolveViewerActiveTab(opts: {
  rawActiveTab: string;
  hasClonableSource: boolean;
  configuredLayoutTabIds: readonly string[];
  gitTabVisible: boolean;
  gitQueryPending: boolean;
}): string {
  const fallback = getViewerSafeFallbackTab(opts.hasClonableSource);
  if (
    parseCodeTabId(opts.rawActiveTab) ||
    parsePinnedViewTabId(opts.rawActiveTab) ||
    opts.rawActiveTab === "content" ||
    opts.configuredLayoutTabIds.includes(opts.rawActiveTab)
  ) {
    return fallback;
  }
  if (
    opts.rawActiveTab === "git" &&
    !opts.gitTabVisible &&
    !opts.gitQueryPending
  ) {
    return fallback;
  }
  return opts.rawActiveTab;
}

/**
 * Reports-only orgs surface Preview/Code on every shell, but the storefront
 * they point at lives on the Report Agent. From any other shell the click must
 * deep-link into the Report Agent rather than toggle the current (source-less)
 * agent's panel. On the Report Agent itself it's a normal in-place toggle.
 */
export function shouldDeepLinkSourceTab(opts: {
  reportsOnly: boolean;
  onReportAgent: boolean;
  tabId: string;
}): boolean {
  return (
    opts.reportsOnly &&
    !opts.onReportAgent &&
    (opts.tabId === "preview" || opts.tabId === "code")
  );
}
