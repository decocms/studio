/**
 * How the page names its sources.
 */

import type { TFunction } from "@/i18n/use-t.ts";
import type { SourceId } from "./board";

/** The platform behind a source, by its own name. */
export function platformName(id: SourceId, t: TFunction): string {
  switch (id) {
    case "orders":
      return t("monitor.platform.orders");
    case "site":
      return t("monitor.platform.site");
    case "deploys":
      return t("monitor.platform.deploys");
    case "analytics":
      return t("monitor.platform.analytics");
    case "search":
      return t("monitor.platform.search");
    default: {
      const unhandled: never = id;
      return unhandled;
    }
  }
}

/** What connecting a source brings to the page. */
export function connectPowers(id: SourceId, t: TFunction): string {
  switch (id) {
    case "orders":
      return t("monitor.powers.orders");
    case "site":
      return t("monitor.powers.site");
    case "deploys":
      return t("monitor.powers.deploys");
    case "analytics":
      return t("monitor.powers.analytics");
    case "search":
      return t("monitor.powers.search");
    default: {
      const unhandled: never = id;
      return unhandled;
    }
  }
}
