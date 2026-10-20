import type { Feature } from "@/hooks/use-entitlements";
import { isSurfaceTab } from "./source-system-tabs";

/**
 * The plan feature a view is gated on, or null when the plan has no say.
 *
 * Gating HERE — at the body, not at the tab button — is what makes a
 * deep-linked `?main=board` obey the plan too; the button is a second door to
 * the same room. Product gating only: the data itself is still enforced
 * server-side (the gateway for AI spend, the BFF for the control plane).
 */
export function featureForTab(tabId: string): Feature | null {
  if (tabId === "board") return "kanban";
  if (tabId === "cdn") return "monitoring";
  // Preview / Content / Code are three views of one Site Editor surface.
  if (isSurfaceTab(tabId)) return "cms";
  return null;
}
