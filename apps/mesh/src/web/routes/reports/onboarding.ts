import type { MouseEvent } from "react";
import { captureReport } from "./track";

/** The "connect my store" destination. Every connect CTA in the report deck
 *  lands the visitor on the commerce onboarding flow with the scanned store
 *  URL preserved (so onboarding starts pre-filled for the same store).
 *  Same-origin now — no cross-domain `ph_did` stamp needed. */
export function onboardingUrl(storeUrl: string): string {
  return `/commerce-onboarding?siteUrl=${encodeURIComponent(storeUrl)}`;
}

export interface ConnectCtaContext {
  domain: string;
  /** Which CTA instance was clicked (deck_footer_mobile, cta_slide_desktop, …). */
  placement: string;
  slideKey?: string;
  slideIndex?: number;
}

/** Click handler for every onboarding-bound CTA — captures the funnel event.
 *  Beacon transport so the event survives the navigation. */
export function trackConnectCta(
  _e: MouseEvent<HTMLAnchorElement>,
  ctx: ConnectCtaContext,
) {
  captureReport(
    "report_cta_clicked",
    {
      domain: ctx.domain,
      placement: ctx.placement,
      destination: "studio_onboarding",
      ...(ctx.slideKey !== undefined ? { slide_key: ctx.slideKey } : {}),
      ...(ctx.slideIndex !== undefined ? { slide_index: ctx.slideIndex } : {}),
      surface: "deck_v2",
    },
    { transport: "sendBeacon" },
  );
}
