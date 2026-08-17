export interface SourceSystemTab {
  id: "preview" | "code";
  title: string;
}

const SOURCE_SYSTEM_TABS: readonly SourceSystemTab[] = [
  { id: "preview", title: "Preview" },
  { id: "code", title: "Code" },
];

/**
 * Preview is available to any clonable source. Code is not: it browses the
 * sandbox filesystem, which CMS mode does not have — there the decofile is
 * read over HTTP and Content is the editing surface instead.
 */
export function getSourceSystemTabs(
  hasClonableSource: boolean,
  hasSandbox = true,
): SourceSystemTab[] {
  if (!hasClonableSource) return [];
  return SOURCE_SYSTEM_TABS.filter(
    (tab) => hasSandbox || tab.id !== "code",
  ).map((tab) => ({ ...tab }));
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
