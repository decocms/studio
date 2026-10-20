/**
 * Translates raw site-URL error strings (from `normalizeReportsSiteUrl` or the
 * well-known internal sentinels) into the current locale. Dynamic server errors
 * fall through and are shown as-is.
 *
 * Shared by the onboarding site form and the Reports empty state, so both spell
 * the same validation failures the same way.
 */
import type { useT } from "@/i18n/use-t.ts";

export function translateSiteError(
  t: ReturnType<typeof useT>,
  error: string,
): string {
  switch (error) {
    case "Enter a website URL.":
      return t("routes.reportsOnboarding.siteUrl.enterUrl");
    case "Use an HTTP or HTTPS website URL.":
      return t("routes.reportsOnboarding.siteUrl.useHttpOrHttps");
    case "Enter a valid website URL.":
      return t("routes.reportsOnboarding.siteUrl.enterValidUrl");
    case "__configurationFailed":
      return t("routes.reportsOnboarding.configurationFailed");
    default:
      return error;
  }
}
