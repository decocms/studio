import { useActivePanelSegment } from "@/hooks/use-destination-route";
import { type DraftKind, viewDraftKind } from "@/lib/draft-kind";

/** The draft kind of the current route's view (see `viewDraftKind`). */
export function useViewDraftKind(): DraftKind | null {
  return viewDraftKind(useActivePanelSegment());
}
