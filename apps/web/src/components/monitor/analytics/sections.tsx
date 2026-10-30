/**
 * The Deco Analytics sections of the Monitor's Analytics tab, one designed
 * screen per read-surface view, all read with the same range and segment.
 */

import { HeatmapView } from "@/layouts/main-panel-tabs/analytics-heatmap-tab";
import { CustomEventsHelp } from "@/layouts/main-panel-tabs/analytics-tab";
import { BehaviourSection } from "./behaviour";
import { ErrorsSection } from "./errors";
import { EventsSection } from "./events";
import { ExperimentsSection } from "./experiments";
import { DecoOverview } from "./overview";
import { QualitySection } from "./quality";
import { RealtimeSection } from "./realtime";
import type { SectionProps } from "./types";
import { UsageSection } from "./usage";
import { VitalsSection } from "./vitals";

const DECO_SECTIONS = [
  "overview",
  "live",
  "behaviour",
  "events",
  "errors",
  "experiments",
  "vitals",
  "heatmap",
  "quality",
  "usage",
] as const;
export type DecoSectionId = (typeof DECO_SECTIONS)[number];

/** The Realtime tab: who is on the site now. */
export const REALTIME_SECTIONS: readonly DecoSectionId[] = ["live"];
/** The Pages & sources tab: how visitors arrive and where they go. */
export const PAGES_SECTIONS: readonly DecoSectionId[] = ["behaviour"];
/** The Heatmap tab: where visitors click and scroll on a page. */
export const HEATMAP_SECTIONS: readonly DecoSectionId[] = ["heatmap"];
/** The Events tab, top to bottom: what the site sends, how clean, how much. */
export const EVENTS_SECTIONS: readonly DecoSectionId[] = [
  "events",
  "quality",
  "usage",
];
/** Under the CDN on Performance: how fast pages feel. */
export const PERFORMANCE_SECTIONS: readonly DecoSectionId[] = ["vitals"];
/**
 * The Experiments tab, read only: how each running test is doing. Tests are
 * created and changed where work is done, not in the Monitor.
 */
export const EXPERIMENTS_SECTIONS: readonly DecoSectionId[] = ["experiments"];
/** The Errors tab: what breaks in visitors' browsers. */
export const ERRORS_SECTIONS: readonly DecoSectionId[] = ["errors"];

export function DecoSection({
  section,
  onConfigure,
  ...props
}: SectionProps & { section: DecoSectionId; onConfigure: () => void }) {
  switch (section) {
    case "overview":
      return <DecoOverview {...props} />;
    case "live":
      return <RealtimeSection {...props} />;
    case "behaviour":
      return <BehaviourSection {...props} />;
    case "events":
      return (
        <>
          <EventsSection {...props} />
          <CustomEventsHelp />
        </>
      );
    case "errors":
      return <ErrorsSection {...props} />;
    case "experiments":
      return <ExperimentsSection {...props} />;
    case "vitals":
      return <VitalsSection {...props} />;
    case "heatmap":
      return (
        <HeatmapView
          base={`/api/${props.orgSlug}/hosting/${encodeURIComponent(props.site)}`}
          orgSlug={props.orgSlug}
          site={props.site}
          modules={props.status.config?.modules ?? ["core"]}
          domain={
            props.status.config?.domains?.[0] ?? props.status.host ?? null
          }
          onConfigure={onConfigure}
        />
      );
    case "quality":
      return <QualitySection {...props} />;
    case "usage":
      return <UsageSection {...props} />;
    default: {
      const never: never = section;
      return never;
    }
  }
}
