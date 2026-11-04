/** The Deco Analytics sections the Monitor draws, all read with the same range and segment. */

import { HeatmapView } from "@/layouts/main-panel-tabs/analytics-heatmap-tab";
import { CustomEventsHelp } from "@/layouts/main-panel-tabs/analytics-tab";
import { BehaviourSection } from "./behaviour";
import { EventsSection } from "./events";
import { DecoOverview } from "./overview";
import { RealtimeSection } from "./realtime";
import type { SectionProps } from "./types";
import { VitalsSection } from "./vitals";

export type DecoSectionId =
  | "overview"
  | "live"
  | "behaviour"
  | "events"
  | "vitals"
  | "heatmap";

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
          fill
        />
      );
    default: {
      const never: never = section;
      return never;
    }
  }
}
