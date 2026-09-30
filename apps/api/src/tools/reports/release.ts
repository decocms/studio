import { siteUrlToHost } from "@decocms/shared/reports/site-url";
import { unlinkReportsSite } from "./auth-client";

/**
 * The site a setup moves away from, or null when it stays on the same one.
 * Compares hostnames because the engine keys a diagnostic by hostname: two
 * URLs with one hostname are one diagnostic, and unlinking it would release
 * the claim the setup has just made.
 */
export function siteLeftBehind(
  previousSiteUrl: unknown,
  nextSiteUrl: string,
): string | null {
  if (typeof previousSiteUrl !== "string") return null;
  const previousHost = siteUrlToHost(previousSiteUrl);
  return previousHost && previousHost !== siteUrlToHost(nextSiteUrl)
    ? previousSiteUrl
    : null;
}

/**
 * Tell the engine the org has let go of its Deco Score site, so it stops
 * recomputing the site and pushing tasks to the org's board. Runs in the
 * background and only logs the outcome: the deletion or site switch that
 * led here has already happened and must not wait on the engine or fail
 * because of it. The engine ignores the call unless this org still holds
 * the site, so a late or repeated call does no harm.
 */
export function releaseReportsSite(input: {
  siteUrl: string;
  orgId: string;
  cause: "connection_deleted" | "organization_deleted" | "site_changed";
}): void {
  void unlinkReportsSite({ siteUrl: input.siteUrl, orgId: input.orgId }).then(
    (result) => console.log("[reports] released site", { ...input, ...result }),
    (error: unknown) =>
      console.warn("[reports] could not release site", {
        ...input,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
}
