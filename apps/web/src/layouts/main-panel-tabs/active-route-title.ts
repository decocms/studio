import { toTitleCase } from "@/components/chat/message/parts/tool-call-part/utils";
import { parsePinnedViewTabId } from "./tab-id";

interface PinnedViewTitleSource {
  connectionId: string;
  toolName: string;
  label?: string;
}

/**
 * Resolve dynamic route titles from data owned above the responsive surface.
 *
 * Mobile keeps the matched route while Chat replaces its rendered Main body,
 * so a title registered inside that body is no longer available. Agent data
 * remains mounted in the workspace provider and is the durable authority for
 * the two dynamic route families: the agent Overview and curated app views.
 */
export function resolveActiveRouteTitle({
  activeTab,
  entityTitle,
  pinnedViews,
}: {
  activeTab: string;
  entityTitle?: string;
  pinnedViews?: readonly PinnedViewTitleSource[] | null;
}): string | undefined {
  if (activeTab === "overview") return entityTitle?.trim() || undefined;

  const app = parsePinnedViewTabId(activeTab);
  if (!app) return undefined;

  const pinnedView = pinnedViews?.find(
    (view) =>
      view.connectionId === app.connectionId && view.toolName === app.toolName,
  );
  if (!pinnedView) return undefined;

  return pinnedView.label?.trim() || toTitleCase(pinnedView.toolName);
}
