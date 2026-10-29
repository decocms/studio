import type { AnalyticsStatus } from "@/layouts/main-panel-tabs/analytics-tab";
import type { AnalyticsSegment } from "./segment";

/** What every Deco Analytics section is drawn from. */
export interface SectionProps {
  orgSlug: string;
  site: string;
  /** One of RANGE_PILLS (5m…30d). */
  range: string;
  segment: AnalyticsSegment;
  status: AnalyticsStatus;
}
