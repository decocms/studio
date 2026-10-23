/**
 * The header row of a view that edits the site's draft beside the site
 * editor (Experiments, Calendar), with the view's own actions (New A/B
 * test, Delete, New campaign) on the right. On a list it opens with the
 * view's intro sentence: the breadcrumb already names the view, so there is
 * no title row. On a detail it holds the way back to the list. The draft
 * bar above it (environment and Review & Publish) stays the same on every
 * view, so a view's actions never go in it and never move Publish.
 */

import type { ReactNode } from "react";
import { ArrowLeft } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";

/** The side inset of these views, as main's Releases view (`p-4`). */
export const SITE_DRAFT_VIEW_INSET = "p-4";

export function SiteDraftViewHeader({
  intro,
  back,
  actions,
}: {
  /** On a list: what the view holds, in one sentence. */
  intro?: ReactNode;
  /** On a detail: the way back to the list. */
  back?: { label: string; onClick: () => void };
  actions?: ReactNode;
}) {
  const actionsSlot = actions ? (
    <div className="flex shrink-0 items-center gap-2" data-slot="view-actions">
      {actions}
    </div>
  ) : null;
  if (back) {
    return (
      <div
        className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4"
        data-testid="site-draft-view-header"
      >
        <Button variant="ghost" size="sm" onClick={back.onClick}>
          <ArrowLeft size={16} />
          {back.label}
        </Button>
        {actionsSlot}
      </div>
    );
  }
  return (
    <div
      className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4"
      data-testid="site-draft-view-header"
    >
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">{intro}</p>
      {actionsSlot}
    </div>
  );
}
