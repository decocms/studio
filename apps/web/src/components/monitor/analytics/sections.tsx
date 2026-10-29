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

export function asDecoSection(section: string): DecoSectionId {
  return DECO_SECTIONS.find((s) => s === section) ?? "overview";
}

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
