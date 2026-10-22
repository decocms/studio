/**
 * The header row of a view that edits the site's draft beside the site
 * editor (Experiments, Calendar): the view's name, or a way back to it, on
 * the left and the view's own actions (New A/B test, Delete, New campaign)
 * on the right. The draft bar above it (environment and Review & Publish)
 * stays the same on every view, so a view's actions never go in it and
 * never move Publish.
 */

import type { ReactNode } from "react";
import { ArrowLeft } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";

export function SiteDraftViewHeader({
  title,
  back,
  actions,
}: {
  /** The view's name, on a list. */
  title?: string;
  /** On a detail: the way back to the list, in place of the title. */
  back?: { label: string; onClick: () => void };
  actions?: ReactNode;
}) {
  return (
    <div
      className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4"
      data-testid="site-draft-view-header"
    >
      {back ? (
        <Button variant="ghost" size="sm" onClick={back.onClick}>
          <ArrowLeft size={16} />
          {back.label}
        </Button>
      ) : (
        <h2 className="truncate text-sm font-medium">{title}</h2>
      )}
      {actions ? (
        <div
          className="flex shrink-0 items-center gap-2"
          data-slot="view-actions"
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}
