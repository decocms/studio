import type { MouseEvent } from "react";
import {
  captureReport,
  REPORT_SURFACE,
  reportAttributionFromSearch,
} from "./track";

/** The "connect my store" destination. Every connect CTA in the report lands
 *  the visitor on the commerce onboarding flow with the scanned store URL
 *  preserved (so onboarding starts pre-filled for the same store), and the
 *  report's attribution carried along so `commerce_onboarding_*` events can be
 *  joined back to the report view that sent them here. `fix` names the finding
 *  whose "fix automatically" button was clicked. */
export function onboardingUrl(storeUrl: string, fix?: string): string {
  const params = new URLSearchParams({ siteUrl: storeUrl });
  if (fix) params.set("fix", fix);
  const attribution = reportAttributionFromSearch(
    typeof window === "undefined" ? "" : window.location.search,
  );
  for (const [key, value] of Object.entries(attribution)) {
    if (typeof value === "string") params.set(key, value);
  }
  return `/reports-onboarding?${params.toString()}`;
}

export interface ConnectCtaContext {
  domain: string;
  /** Which CTA instance was clicked (finding_fix, report_footer, …). */
  placement: string;
  checkId?: string;
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
      ...(ctx.checkId ? { check_id: ctx.checkId } : {}),
      surface: REPORT_SURFACE,
    },
    { transport: "sendBeacon" },
  );
}
