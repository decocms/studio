import EChartArea from "./echart-area";
import SlideHeader from "./slide-header";
import type { SeriesProps } from "@decocms/shared/reports/deck-types";

/**
 * "The simple graph one" — headline top-left, then a full-bleed trend chart
 * that fills the rest of the slide edge-to-edge (no caption, à la the Figma).
 * Mobile-first: type scales with the viewport; the chart goes to the edges.
 */
export default function SeriesTemplate({
  eyebrow,
  headline,
  annotation,
  points,
  xLabels,
  unit,
  callout,
  active,
}: SeriesProps) {
  return (
    <div className="flex h-full flex-col">
      <SlideHeader
        eyebrow={eyebrow}
        headline={headline}
        annotation={annotation}
        active={active}
      />

      <div
        className="reveal relative mt-6 min-h-0 flex-1"
        data-show={active ? "true" : "false"}
        style={{ transitionDelay: active ? "120ms" : "0ms" }}
      >
        <EChartArea
          points={points}
          xLabels={xLabels}
          highlightIndex={callout.index}
          calloutValue={callout.value}
          tone={callout.tone ?? "good"}
          unit={unit}
        />
      </div>
    </div>
  );
}
