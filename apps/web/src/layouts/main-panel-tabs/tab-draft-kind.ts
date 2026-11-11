import {
  type DraftKind,
  type DraftThread,
  viewForThreadSwitch,
} from "@/lib/draft-kind";
import { tabRouteLocation } from "./tab-route";

/** The draft kind of the view a tab id opens (see `viewDraftKind`). */
function tabDraftKind(tabId: string | undefined): DraftKind | null {
  if (!tabId) return null;
  const location = tabRouteLocation(tabId);
  if (location.kind === "blog") return "blog";
  if (location.kind === "site-editor") return "site";
  // The Experiments app, or Monitor's Experiments view on a v7 site.
  if (
    location.kind === "agent-section" &&
    (location.section === "calendar" || location.section === "experiments")
  ) {
    return "site";
  }
  return null;
}

/**
 * The tab a switch to `thread` lands on: `tabId`, unless its view can't show
 * that thread (Blog and a site draft in Fast Preview, a site view and a Blog
 * draft). Read without the project, so an unstamped thread is let through; the
 * shell's own check still sends it to the view's entry.
 */
export function tabForThread(
  tabId: string | undefined,
  thread: DraftThread | undefined,
): string | undefined {
  if (!tabId || !thread) return tabId;
  return viewForThreadSwitch(tabDraftKind(tabId), thread, undefined) ?? tabId;
}
