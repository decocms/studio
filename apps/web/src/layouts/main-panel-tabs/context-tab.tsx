/**
 * The blog's context, as a view of the project rather than a row inside the
 * Site Editor.
 *
 * It is the Content browser pinned to its Context collection: the brand, the
 * writing rules, the formats, the campaigns and the specialists all read from
 * the same decofile and the same org library the editor does, so duplicating
 * that plumbing to give them their own screen would only let the two drift.
 */

import { ContentBrowser } from "@/components/sandbox/content/content-browser";
import { EmptyState } from "@/components/empty-state";
import { useBlogAiState } from "@/hooks/use-blog-ai";
import { useT } from "@/i18n/use-t.ts";

export function ContextTab() {
  const t = useT();
  const blogAi = useBlogAiState();
  /** Nothing, rather than "it is off", until the organization has answered. */
  if (blogAi.isPending) return null;
  if (!blogAi.enabled) {
    return (
      <EmptyState
        className="h-full"
        title={t("mainPanelTabs.contextTab.offTitle")}
        description={t("mainPanelTabs.contextTab.offDescription")}
      />
    );
  }
  return <ContentBrowser pinnedCollection="context" />;
}
