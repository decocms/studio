import { useSearch } from "@tanstack/react-router";
import { useActivePanelSegment } from "@/hooks/use-destination-route";
import { type DraftKind, viewDraftKind } from "@/lib/draft-kind";

/** The draft kind of the current route's view (see `viewDraftKind`). */
export function useViewDraftKind(): DraftKind | null {
  const mainView = useActivePanelSegment();
  const search = useSearch({ strict: false });
  const view =
    "view" in search && typeof search.view === "string"
      ? search.view
      : undefined;
  return viewDraftKind(mainView, view);
}
