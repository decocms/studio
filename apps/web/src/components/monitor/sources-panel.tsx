/**
 * How the page names its sources.
 */

import type { TFunction } from "@/i18n/use-t.ts";
import type { SourceId } from "./board";

export function sourceName(id: SourceId, t: TFunction): string {
  switch (id) {
    case "orders":
      return t("monitor.sources.name.orders");
    case "site":
      return t("monitor.sources.name.site");
    case "deploys":
      return t("monitor.sources.name.deploys");
    case "analytics":
      return t("monitor.sources.name.analytics");
    case "search":
      return t("monitor.sources.name.search");
    default: {
      const unhandled: never = id;
      return unhandled;
    }
  }
}

/** What the button that connects a source says: the platform, by name. */
export function connectLabel(id: SourceId, t: TFunction): string {
  switch (id) {
    case "orders":
      return t("monitor.connect.orders");
    case "site":
      return t("monitor.connect.site");
    case "deploys":
      return t("monitor.connect.deploys");
    case "analytics":
      return t("monitor.connect.analytics");
    case "search":
      return t("monitor.connect.search");
    default: {
      const unhandled: never = id;
      return unhandled;
    }
  }
}

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
